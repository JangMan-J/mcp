import { createHash } from 'node:crypto';
import type { AuthChallenge, AuthHeaderResult, AuthProvider, AuthRequestContext, Clock, CredentialStore, FetchPort, RandomPort } from '@mcp-client/core';
import { getDocument, object, strings, type JsonObject } from './discovery.js';
import { AuthError, basicAuthorization, cancelled, canonicalResource, fail, parseBearerChallenges, secureUrl, withAbort } from './protocol.js';
import { SafeFetch } from './safe-fetch.js';

const JWT_BEARER = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const SKEW_MS = 10_000;
const DEFAULT_TTL_S = 300;
const ASSERTION_TTL_S = 60;
const textEncoder = new TextEncoder();

export interface AssertionSigner {
  readonly alg: string;
  readonly kid?: string;
  sign(signingInput: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/** Sign with a non-extractable WebCrypto private key. ES256 output is the raw r||s form JWS requires. */
export function createWebCryptoAssertionSigner(alg: 'ES256' | 'RS256', privateKey: CryptoKey, kid?: string): AssertionSigner {
  if (privateKey.type !== 'private') throw new Error('a private CryptoKey is required');
  const params = alg === 'ES256' ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' };
  return {
    alg,
    ...(kid !== undefined ? { kid } : {}),
    async sign(input) {
      return new Uint8Array(await crypto.subtle.sign(params, privateKey, input as Uint8Array<ArrayBuffer>));
    },
  };
}

export interface ClientCredentialsDiagnostic {
  readonly event: 'token-acquired' | 'token-failed' | 'token-invalidated';
  /** Non-secret facts only: never a secret, assertion, signing key, or token. */
  readonly detail?: string;
}

export interface ClientCredentialsConfig {
  readonly resource?: string;
  readonly clientId?: string;
  readonly secret?: string;
  readonly credentialKey?: string;
  readonly credentials?: CredentialStore;
  readonly signer?: AssertionSigner;
  readonly expectedIssuer?: string;
  readonly scopes?: readonly string[];
  readonly fetch?: FetchPort;
  readonly clock?: Pick<Clock, 'now'>;
  readonly random?: RandomPort;
  readonly allowInsecureDev?: boolean;
  readonly onDiagnostic?: (event: ClientCredentialsDiagnostic) => void;
}

export function isConfigured(c: ClientCredentialsConfig): boolean {
  const hasSecret = (typeof c.secret === 'string' && c.secret !== '') || (!!c.credentials && !!c.credentialKey);
  return !!c.resource && !!c.clientId && (hasSecret || !!c.signer);
}

interface Token {
  readonly value: string;
  readonly expiresAt: number;
}

interface AsMetadata {
  readonly issuer: string;
  readonly tokenEndpoint: string;
  readonly methods: readonly string[];
  readonly algs: readonly string[];
}

function secureNoHash(input: unknown, dev: boolean): URL {
  if (typeof input !== 'string') return fail('invalid-url');
  const url = secureUrl(input, dev);
  if (url.hash) fail('invalid-url');
  return url;
}

async function signAssertion(
  signer: AssertionSigner,
  claims: { readonly clientId: string; readonly audience: string; readonly nowMs: number; readonly ttlSeconds: number; readonly jti: string },
): Promise<string> {
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
  const iat = Math.floor(claims.nowMs / 1000);
  const header = { alg: signer.alg, typ: 'JWT', ...(signer.kid !== undefined ? { kid: signer.kid } : {}) };
  const payload = { iss: claims.clientId, sub: claims.clientId, aud: claims.audience, iat, exp: iat + claims.ttlSeconds, jti: claims.jti };
  const input = `${b64(textEncoder.encode(JSON.stringify(header)))}.${b64(textEncoder.encode(JSON.stringify(payload)))}`;
  return `${input}.${b64(await signer.sign(textEncoder.encode(input)))}`;
}

/** OAuth 2.0 `client_credentials` provider supporting client secrets and RFC 7523 `private_key_jwt` assertions. */
export class ClientCredentialsAuth implements AuthProvider {
  readonly stepUpLimit = 0;
  private readonly fetcher: FetchPort;
  private readonly resource: string;
  private readonly dev: boolean;
  private pinned: string | undefined;
  private token: (Token & { version: object }) | undefined;
  private inflight: Promise<Token & { version: object }> | undefined;

  constructor(private readonly config: ClientCredentialsConfig) {
    if (!isConfigured(config)) throw new AuthError('auth-unavailable', 'not-configured');
    this.dev = config.allowInsecureDev === true;
    this.resource = canonicalResource(config.resource!);
    this.fetcher = config.fetch ?? new SafeFetch({ allowInsecureDev: this.dev });
    this.pinned = config.expectedIssuer;
    if (this.pinned !== undefined) secureNoHash(this.pinned, this.dev);
  }

  contextId(): string {
    const digest = createHash('sha256').update(`${this.resource}\n${this.config.clientId}\n${this.pinned ?? ''}`).digest('base64url');
    return `cc:${digest.slice(0, 22)}`;
  }

  async headerFor(url: string, _operation?: string, context?: AuthRequestContext): Promise<AuthHeaderResult | undefined> {
    let target: string;
    try { target = canonicalResource(url); } catch { return undefined; }
    if (target !== this.resource) return undefined;
    const token = await this.current(context?.signal);
    return { authorization: `Bearer ${token.value}`, contextId: this.contextId(), credentialVersion: token.version };
  }

  async onChallenge(challenge: AuthChallenge, signal: AbortSignal, _context?: AuthRequestContext): Promise<boolean> {
    if (challenge.status === 403) {
      const insufficient = parseBearerChallenges(challenge.wwwAuthenticate ?? '').some((c) => c.error === 'insufficient_scope');
      // No interactive step-up for a machine credential: abort instead of retrying.
      if (insufficient) throw new AuthError('auth-failure', 'insufficient-scope');
      return false;
    }
    if (this.token && challenge.credentialVersion !== null && challenge.credentialVersion !== undefined
      && challenge.credentialVersion !== this.token.version) return true;
    if (this.token) { this.token = undefined; this.diag('token-invalidated'); }
    await this.current(signal);
    return true;
  }

  private current(signal?: AbortSignal): Promise<Token & { version: object }> {
    const t = this.token;
    if (t && this.now() < t.expiresAt - SKEW_MS) return Promise.resolve(t);
    this.inflight ??= this.acquire().then(
      (fresh) => { this.token = fresh; this.inflight = undefined; return fresh; },
      (error: unknown) => { this.inflight = undefined; throw error; },
    );
    return signal ? withAbort(this.inflight, signal, cancelled) : this.inflight;
  }

  private now(): number { return this.config.clock?.now() ?? Date.now(); }

  private diag(event: ClientCredentialsDiagnostic['event'], detail?: string): void {
    try { this.config.onDiagnostic?.({ event, ...(detail !== undefined ? { detail } : {}) }); } catch { /* host hook failure is not ours */ }
  }

  private async acquire(): Promise<Token & { version: object }> {
    try {
      const signal = AbortSignal.timeout(30_000);
      const as = await this.discover(signal);
      const token = await this.requestToken(as, signal);
      this.diag('token-acquired', new URL(as.issuer).host);
      return { ...token, version: {} };
    } catch (error) {
      const out = error instanceof AuthError ? error : new AuthError('auth-failure', 'token-request-failed');
      this.diag('token-failed', out.reason);
      throw out;
    }
  }

  /** PRM then AS metadata. Never reads or calls a registration endpoint. */
  private async discover(signal: AbortSignal): Promise<AsMetadata> {
    const url = secureNoHash(this.resource, this.dev);
    const root = `${url.origin}/.well-known/oauth-protected-resource`;
    const candidates = [...new Set([`${root}${url.pathname === '/' ? '' : url.pathname}${url.search}`, root])];
    let prm: JsonObject | undefined;
    for (const candidate of candidates) {
      const doc = await getDocument(this.fetcher, candidate, signal);
      if (!doc) continue;
      if (doc['resource'] !== (candidate === root && candidates.length > 1 ? url.origin : this.resource)) fail('prm-resource-mismatch');
      prm = doc;
      break;
    }
    const issuers = prm ? [...new Set(strings(prm['authorization_servers']))] : [];
    if (!issuers.length) fail('prm-invalid');
    // Pin the issuer so credentials only ever go to the validated AS.
    const issuer = this.pinned ?? issuers[0]!;
    if (!issuers.includes(issuer)) fail('issuer-mismatch');
    this.pinned = issuer;
    return await this.metadata(issuer, signal);
  }

  private async metadata(issuer: string, signal: AbortSignal): Promise<AsMetadata> {
    const url = secureNoHash(issuer, this.dev);
    if (url.search || /[?#]/u.test(issuer)) fail('as-issuer-invalid');
    const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/u, '');
    const urls = [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`];
    if (path) urls.push(`${url.origin}${path}/.well-known/openid-configuration`);
    for (const candidate of urls) {
      const doc = await getDocument(this.fetcher, candidate, signal);
      if (!doc) continue;
      if (doc['issuer'] !== issuer) fail('as-issuer-mismatch');
      return {
        issuer,
        tokenEndpoint: secureNoHash(doc['token_endpoint'], this.dev).href,
        methods: strings(doc['token_endpoint_auth_methods_supported']),
        algs: strings(doc['token_endpoint_auth_signing_alg_values_supported']),
      };
    }
    return fail('as-metadata-missing');
  }

  private async secretValue(): Promise<string> {
    const { secret, credentials, credentialKey } = this.config;
    const value = secret ?? (credentials && credentialKey !== undefined ? await credentials.get(credentialKey) : undefined);
    if (!value) throw new AuthError('auth-unavailable', 'credentials-missing');
    return value;
  }

  private async requestToken(as: AsMetadata, signal: AbortSignal): Promise<Token> {
    const form = new URLSearchParams({ grant_type: 'client_credentials', resource: this.resource });
    if (this.config.scopes?.length) form.set('scope', this.config.scopes.join(' '));
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    const { signer, clientId } = this.config;
    if (signer) {
      if (as.methods.length && !as.methods.includes('private_key_jwt')) fail('auth-method-unsupported');
      if (as.algs.length && !as.algs.includes(signer.alg)) fail('signing-alg-unsupported');
      const random = this.config.random?.bytes(16) ?? crypto.getRandomValues(new Uint8Array(16));
      form.set('client_assertion_type', JWT_BEARER);
      form.set('client_assertion', await signAssertion(signer, {
        clientId: clientId!, audience: as.issuer, nowMs: this.now(), ttlSeconds: ASSERTION_TTL_S, jti: Buffer.from(random).toString('hex'),
      }));
    } else {
      const secret = await this.secretValue();
      const methods = as.methods.length ? as.methods : ['client_secret_basic'];
      if (methods.includes('client_secret_basic')) {
        headers['authorization'] = basicAuthorization(clientId!, secret);
      } else if (methods.includes('client_secret_post')) {
        form.set('client_id', clientId!);
        form.set('client_secret', secret);
      } else fail('auth-method-unsupported');
    }
    let res: Response;
    try { res = await this.fetcher.fetch(as.tokenEndpoint, { method: 'POST', headers, body: form.toString(), credentials: 'omit', redirect: 'manual', signal }); }
    catch (error) { if (error instanceof AuthError) throw error; return fail('token-request-failed'); }
    if (!res.ok) { await res.body?.cancel(); return fail('token-request-rejected'); }
    let body: JsonObject;
    try { body = object(await res.json()); } catch { return fail('invalid-token-response'); }
    const value = body['access_token'];
    if (typeof value !== 'string' || !/^[A-Za-z\d._~+/-]+=*$/u.test(value)) return fail('invalid-token-response');
    if (typeof body['token_type'] !== 'string' || body['token_type'].toLowerCase() !== 'bearer') return fail('invalid-token-response');
    const ttl = typeof body['expires_in'] === 'number' && Number.isFinite(body['expires_in']) && body['expires_in'] > 0
      ? body['expires_in'] : DEFAULT_TTL_S;
    return { value, expiresAt: this.now() + ttl * 1000 };
  }
}
