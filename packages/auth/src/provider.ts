import { randomBytes } from 'node:crypto';
import type { AuthChallenge, AuthHeaderResult, AuthProvider, AuthRequestContext, CredentialStore, FetchPort, RandomPort } from '@mcp-client/core';
import { discover, getDocument, object, strings, type DiscoveryOptions, type Metadata } from './discovery.js';
import { AuthError, bearerValue, canonicalResource, detach, fail, hash, isLoopback, parseBearerChallenges, pkceChallenge, secureUrl, type BearerChallenge } from './protocol.js';
import { SafeFetch } from './safe-fetch.js';

export class MemoryCredentialStore implements CredentialStore {
  readonly #values = new Map<string, string>();
  async get(key: string) { return this.#values.get(key); }
  async set(key: string, value: string) { this.#values.set(key, value); }
  async delete(key: string) { this.#values.delete(key); }
}

interface ResourceOptions {
  readonly resource: string;
  readonly preserveTrailingSlash?: boolean;
}
function matches(options: ResourceOptions, resource: string, candidate: string) {
  try { return canonicalResource(candidate, options.preserveTrailingSlash) === resource && !new URL(candidate).hash; }
  catch { return false; }
}
export interface ConfiguredBearerOptions extends ResourceOptions {
  readonly token: string | (() => Promise<string>);
  readonly refresh?: () => Promise<void>;
  readonly allowInsecureDev?: boolean;
}
export class ConfiguredBearer implements AuthProvider {
  readonly #resource: string;
  #context = 'anonymous';
  #credentialVersion: object = {};
  #pending: Promise<boolean> | undefined;
  readonly #options: ConfiguredBearerOptions;
  constructor(options: ConfiguredBearerOptions) {
    this.#options = options;
    secureUrl(options.resource, options.allowInsecureDev);
    this.#resource = canonicalResource(options.resource, options.preserveTrailingSlash);
  }
  contextId() { return this.#context; }
  async headerFor(url: string): Promise<AuthHeaderResult | undefined> {
    if (!matches(this.#options, this.#resource, url)) return undefined;
    try {
      const token = bearerValue(typeof this.#options.token === 'string' ? this.#options.token : await this.#options.token());
      const context = hash(JSON.stringify([this.#resource, 'bearer', hash(token)]));
      if (context !== this.#context) this.#credentialVersion = {};
      this.#context = context;
      return { authorization: `Bearer ${token}`, contextId: context, credentialVersion: this.#credentialVersion };
    } catch { return fail('configured-bearer-unavailable'); }
  }
  async onChallenge(challenge: AuthChallenge, signal: AbortSignal): Promise<boolean> {
    if (challenge.status !== 401 || !this.#options.refresh || signal.aborted ||
      (challenge.resource !== undefined && !matches(this.#options, this.#resource, challenge.resource))) return false;
    if (challenge.credentialVersion && challenge.credentialVersion !== this.#credentialVersion) return true;
    this.#pending ??= Promise.resolve().then(this.#options.refresh).then(() => {
      this.#credentialVersion = {};
      return true;
    }, () => false).finally(() => { this.#pending = undefined; });
    return detach(this.#pending, signal);
  }
}

export interface ClientRegistration {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly clientSecretExpiresAt?: number; // seconds since epoch; set by dynamic registration
  readonly authMethod?: 'none' | 'client_secret_basic' | 'client_secret_post'; // set by dynamic registration
  readonly redirectUris: readonly string[];
}
export type AuthorizationPrompt =
  | { readonly kind: 'client-info'; readonly serverLabel: string; readonly issuer: string; readonly redirectUri: string }
  | { readonly kind: 'authorize'; readonly serverLabel: string; readonly issuerHost: string; readonly resource: string;
      readonly scopes: readonly string[]; readonly redirectHost: string; readonly localhostWarning: boolean };
export interface AuthorizationConsent {
  request(prompt: AuthorizationPrompt, signal: AbortSignal): Promise<
    { readonly decision: 'accept'; readonly registration?: ClientRegistration } | { readonly decision: 'decline' | 'cancel' }>;
}
export interface RedirectPort {
  waitForCallback(options: { readonly redirectUri: string; readonly state: string; readonly signal: AbortSignal }): Promise<URLSearchParams>;
}
export interface OAuthOptions extends ResourceOptions, DiscoveryOptions {
  readonly serverLabel?: string;
  readonly redirectUri: string;
  readonly registrations?: Readonly<Record<string, ClientRegistration>>; // issuer -> registration, for this resource only
  readonly cimd?: { readonly clientIdUrl: string; readonly redirectUris: readonly string[]; readonly selfCheck?: boolean };
  readonly dynamicRegistration?: { readonly clientName: string; readonly softwareId?: string }; // opt-in RFC 7591; absent = never POST
  readonly consent?: AuthorizationConsent;
  readonly browser?: { open(url: string, signal: AbortSignal): Promise<void> };
  readonly redirect?: RedirectPort;
  readonly credentials?: CredentialStore;
  readonly fetch?: FetchPort;
  readonly random?: RandomPort;
  readonly clock?: { now(): number };
  readonly skewMs?: number;
  readonly flowTimeoutMs?: number;
  readonly stepUpLimit?: number;
  readonly offlineAccess?: boolean;
  readonly onDiagnostic?: (message: string) => void;
}
interface Session {
  readonly resource: string; // Validated PRM identifier; may differ from the configured MCP endpoint.
  readonly metadata: Metadata;
  readonly registration: ClientRegistration;
}
interface Grant extends Session {
  readonly context: string;
  readonly version: object;
  readonly token: string;
  readonly expires: number;
  readonly scopes: readonly string[];
}
const scopesOf = (scope: string | undefined) => scope?.split(/ +/u).filter((value) => /^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(value)) ?? [];

export class OAuthAuthorization implements AuthProvider {
  readonly #resource: string;
  readonly #redirect: URL;
  readonly #fetch: FetchPort;
  readonly #store: CredentialStore;
  readonly #stepUps = new Map<string, number>();
  readonly stepUpLimit: number;
  #grant: Grant | undefined;
  #resourceMetadataHint: string | undefined;
  #pending: { readonly scopeKey?: string; readonly work: Promise<void> } | undefined;

  readonly #options: OAuthOptions;
  constructor(options: OAuthOptions) {
    this.#options = options;
    this.stepUpLimit = options.stepUpLimit ?? 3;
    if (!Number.isSafeInteger(this.stepUpLimit) || this.stepUpLimit < 0) fail('invalid-step-up-limit');
    secureUrl(options.resource, options.allowInsecureDev);
    this.#resource = canonicalResource(options.resource, options.preserveTrailingSlash);
    this.#redirect = secureUrl(options.redirectUri, options.allowInsecureDev);
    if (this.#redirect.hash || [...this.#redirect.searchParams.keys()].some((key) => ['code', 'error', 'iss', 'state'].includes(key))) fail('invalid-redirect-uri');
    this.#fetch = options.fetch ?? new SafeFetch({ allowInsecureDev: options.allowInsecureDev ?? false });
    this.#store = options.credentials ?? new MemoryCredentialStore();
  }
  contextId() { return this.#grant?.context ?? 'anonymous'; }
  async headerFor(url: string, _operation?: string, context?: AuthRequestContext): Promise<AuthHeaderResult | undefined> {
    if (!matches(this.#options, this.#resource, url)) return undefined;
    context?.signal.throwIfAborted();
    const grant = this.#grant;
    const work = this.#pending?.work ?? (grant && grant.expires - (this.#options.skewMs ?? 30_000) <= this.now()
      ? this.start(undefined, signal => this.renew(grant, grant.scopes, signal, context)) : undefined);
    if (work) await (context ? detach(work, context.signal) : work);
    return this.#grant && { authorization: `Bearer ${this.#grant.token}`, contextId: this.#grant.context, credentialVersion: this.#grant.version };
  }

  async onChallenge(challenge: AuthChallenge, signal: AbortSignal, context?: AuthRequestContext): Promise<boolean> {
    if (signal.aborted) fail('cancelled');
    if (challenge.resource !== undefined && !matches(this.#options, this.#resource, challenge.resource)) return false;
    const parsed = parseBearerChallenges(challenge.wwwAuthenticate ?? '');
    const bearer = challenge.status === 403 ? parsed.find(x => x.error === 'insufficient_scope') :
      parsed.find(x => x.resource_metadata !== undefined) ?? parsed[0];
    if (challenge.status === 403 && !bearer) return false;
    if (challenge.status === 401 && !this.#pending && this.#grant && challenge.credentialVersion !== undefined &&
        challenge.credentialVersion !== this.#grant.version &&
        (bearer?.resource_metadata === undefined || bearer.resource_metadata === this.#resourceMetadataHint)) return true;
    if (challenge.status === 401 && !bearer && /^\s*Basic(?:\s|$)/iu.test(challenge.wwwAuthenticate ?? '')) fail('unsupported-scheme');
    const operation = challenge.operation ?? '';
    const scopeKey = challenge.status === 403 ? JSON.stringify([operation, bearer?.scope, bearer?.resource_metadata]) : undefined;
    while (this.#pending) {
      const pending = this.#pending;
      await detach(pending.work, signal);
      if (pending.scopeKey === scopeKey) return true;
      if (scopeKey === undefined) return true;
      if (signal.aborted) fail('cancelled');
    }
    if (scopeKey !== undefined) {
      const used = this.#stepUps.get(operation) ?? 0;
      if (used >= this.stepUpLimit) fail('insufficient-scope');
      this.#stepUps.set(operation, used + 1);
    }
    await detach(this.start(scopeKey, flowSignal => this.challenge(challenge, bearer, flowSignal, context)), signal);
    return true;
  }

  private now() { return this.#options.clock?.now() ?? Date.now(); }
  private diagnostic(message: string) { this.#options.onDiagnostic?.(message); }
  private start(scopeKey: string | undefined, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const signal = AbortSignal.timeout(this.#options.flowTimeoutMs ?? 120_000);
    const work = Promise.resolve().then(() => detach(run(signal), signal)).catch((error: unknown) => {
      if (error instanceof AuthError) throw error;
      return fail('flow-failed');
    }).finally(() => { this.#pending = undefined; });
    this.#pending = { ...(scopeKey === undefined ? {} : { scopeKey }), work };
    return work;
  }

  private async challenge(challenge: AuthChallenge, bearer: BearerChallenge | undefined, signal: AbortSignal, context?: AuthRequestContext) {
    const previous = this.#grant;
    const step = challenge.status === 403;
    if (!step) this.#grant = undefined;
    const { metadata, scopes, resource } = await discover(this.#fetch, this.#resource, challenge.resource ?? new URL(this.#options.resource).href,
      bearer?.resource_metadata, this.#options, signal);
    const sameBinding = previous?.metadata.issuer === metadata.issuer && previous.resource === resource;
    if (previous && !sameBinding) this.#grant = undefined;
    const selected = [...new Set([...(step && sameBinding ? previous.scopes : []),
      ...(bearer?.scope !== undefined ? scopesOf(bearer.scope) : step && sameBinding ? [] : scopes.flatMap(scopesOf)),
    ])].filter(scope => scope !== 'offline_access');
    if (this.#options.offlineAccess && metadata.scopes.includes('offline_access')) selected.push('offline_access');
    const session = { metadata, resource, registration: await this.registration(metadata, signal, context, selected) };
    if (!step && (!previous || sameBinding)) {
      await this.renew(session, selected, signal, context, sameBinding ? previous : undefined);
    } else {
      await this.interactive(session, selected, signal, context);
    }
    this.#resourceMetadataHint = bearer?.resource_metadata;
  }

  private refreshKey(session: Session) {
    const key = ['refresh', this.#resource, session.metadata.issuer, session.registration.clientId];
    // Preserve existing keys for grants whose audience is the configured endpoint.
    if (session.resource !== this.#resource) key.push(session.resource);
    return JSON.stringify(key);
  }

  private validateRegistration(reg: ClientRegistration): ClientRegistration {
    if (!reg || typeof reg.clientId !== 'string' || !reg.clientId || !strings(reg.redirectUris).includes(this.#options.redirectUri) ||
      (reg.clientSecret !== undefined && typeof reg.clientSecret !== 'string')) fail('invalid-client-registration');
    return { clientId: reg.clientId, redirectUris: [...reg.redirectUris], ...(reg.clientSecret !== undefined ? { clientSecret: reg.clientSecret } : {}),
      ...(reg.clientSecretExpiresAt !== undefined ? { clientSecretExpiresAt: reg.clientSecretExpiresAt } : {}),
      ...(reg.authMethod !== undefined ? { authMethod: reg.authMethod } : {}) };
  }

  private async registration(metadata: Metadata, signal: AbortSignal, context?: AuthRequestContext, scopes: readonly string[] = []): Promise<ClientRegistration> {
    const registrations = this.#options.registrations;
    const preset = registrations && Object.hasOwn(registrations, metadata.issuer) ? registrations[metadata.issuer] : undefined;
    if (preset) return this.validateRegistration(preset);
    const cimd = this.#options.cimd;
    if (metadata.cimd && cimd) {
      const id = secureUrl(cimd.clientIdUrl);
      if (id.pathname === '/' || /[?#]/u.test(cimd.clientIdUrl)) fail('cimd-client-id-invalid');
      if (cimd.selfCheck) {
        const doc = await getDocument(this.#fetch, id.href, signal);
        if (doc?.['client_id'] !== cimd.clientIdUrl || typeof doc['client_name'] !== 'string' || !doc['client_name'] ||
          !strings(doc['redirect_uris']).includes(this.#options.redirectUri)) fail('cimd-document-invalid');
        if (!strings(doc['grant_types']).includes('refresh_token')) this.diagnostic('CIMD does not list the refresh_token grant');
      }
      return this.validateRegistration({ clientId: cimd.clientIdUrl, redirectUris: cimd.redirectUris });
    }
    if (registrations && Object.keys(registrations).length) fail('client-issuer-mismatch');
    const key = JSON.stringify(['registration', this.#resource, metadata.issuer, null]);
    const cached = await this.#store.get(key);
    if (cached) {
      const reg = this.validateRegistration(JSON.parse(cached) as ClientRegistration);
      if (!reg.clientSecretExpiresAt || reg.clientSecretExpiresAt * 1000 > this.now()) return reg;
    }
    if (this.#options.dynamicRegistration && metadata.registrationEndpoint) {
      const registration = await this.register(metadata, metadata.registrationEndpoint, this.#options.dynamicRegistration, scopes, signal);
      signal.throwIfAborted();
      await this.#store.set(key, JSON.stringify(registration));
      return registration;
    }
    if (!this.#options.consent && !context?.consent) fail('no-registration-mechanism');
    const result = await this.consent({ kind: 'client-info', serverLabel: this.#options.serverLabel ?? context?.serverLabel ?? this.#resource,
      issuer: metadata.issuer, redirectUri: this.#options.redirectUri }, signal, context);
    if (!result.registration) fail('no-registration-mechanism');
    const registration = this.validateRegistration(result.registration);
    signal.throwIfAborted();
    await this.#store.set(key, JSON.stringify(registration));
    return registration;
  }

  // RFC 7591 dynamic client registration. Never logs or echoes the secret.
  private async register(metadata: Metadata, endpoint: URL, dcr: NonNullable<OAuthOptions['dynamicRegistration']>,
    scopes: readonly string[], signal: AbortSignal): Promise<ClientRegistration> {
    const supported = metadata.clientAuthMethods;
    const method = (['none', 'client_secret_basic', 'client_secret_post'] as const).find(m => supported.includes(m)) ?? 'client_secret_basic';
    const body = { client_name: dcr.clientName, redirect_uris: [this.#options.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method,
      application_type: this.#redirect.protocol === 'http:' && isLoopback(this.#redirect.hostname) ? 'native' : 'web',
      ...(dcr.softwareId !== undefined ? { software_id: dcr.softwareId } : {}), ...(scopes.length ? { scope: scopes.join(' ') } : {}) };
    signal.throwIfAborted();
    let response: Response;
    try { response = await this.#fetch.fetch(endpoint.href, { method: 'POST', body: JSON.stringify(body),
      headers: new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' }), credentials: 'omit', redirect: 'error', signal }); }
    catch { return fail('registration-failed'); }
    let doc: Record<string, unknown>;
    try { doc = object(await response.json()); } catch { return fail('registration-failed'); }
    if (response.status !== 201 && response.status !== 200) return fail('registration-failed');
    const { client_id: clientId, client_secret: secret, client_secret_expires_at: expires, token_endpoint_auth_method: returned } = doc;
    if (typeof clientId !== 'string' || !clientId || (secret !== undefined && typeof secret !== 'string') ||
      (expires !== undefined && (typeof expires !== 'number' || !Number.isFinite(expires)))) return fail('registration-failed');
    const authMethod = returned ?? method;
    if (authMethod !== 'none' && authMethod !== 'client_secret_basic' && authMethod !== 'client_secret_post') return fail('registration-failed');
    if (authMethod !== 'none' && !secret) return fail('registration-failed');
    return { clientId, redirectUris: [this.#options.redirectUri], authMethod,
      ...(secret ? { clientSecret: secret } : {}), ...(expires ? { clientSecretExpiresAt: expires } : {}) };
  }

  private async consent(prompt: AuthorizationPrompt, signal: AbortSignal, context?: AuthRequestContext) {
    signal.throwIfAborted();
    if (this.#options.consent) {
      const result = await this.#options.consent.request(prompt, signal);
      if (result.decision !== 'accept') fail(result.decision === 'decline' ? 'declined' : 'cancelled');
      signal.throwIfAborted();
      return result;
    }
    if (!context?.consent) throw new AuthError('auth-unavailable', prompt.kind);
    const result = await context.consent.request(prompt, signal);
    if (result.decision !== 'accept') fail(result.decision === 'decline' ? 'declined' : 'cancelled');
    signal.throwIfAborted();
    if (prompt.kind === 'client-info' && result.content) {
      return { registration: this.validateRegistration(result.content as unknown as ClientRegistration) };
    }
    return { registration: undefined };
  }

  private async renew(session: Session, scopes: readonly string[], signal: AbortSignal, context?: AuthRequestContext, previous = this.#grant) {
    const refresh = await this.#store.get(this.refreshKey(session));
    if (refresh) {
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh });
      if (await this.token(session, form, previous?.scopes ?? scopes, signal, refresh, previous)) return;
      await this.#store.delete(this.refreshKey(session));
      this.#grant = undefined;
    }
    await this.interactive(session, scopes, signal, context);
  }

  private nonce(size: number) {
    const bytes = this.#options.random ? this.#options.random.bytes(size) : randomBytes(size);
    if (bytes.length !== size) fail('invalid-random-source');
    return Buffer.from(bytes).toString('base64url');
  }
  private async interactive(session: Session, scopes: readonly string[], signal: AbortSignal, context?: AuthRequestContext) {
    const { metadata, registration } = session;
    const { browser, redirect, redirectUri } = this.#options;
    if (!browser || !redirect) throw new AuthError('auth-unavailable', 'authorize');
    await this.consent({ kind: 'authorize', serverLabel: this.#options.serverLabel ?? context?.serverLabel ?? this.#resource,
      issuerHost: new URL(metadata.issuer).hostname, resource: session.resource, scopes: Object.freeze([...scopes]),
      redirectHost: this.#redirect.hostname, localhostWarning: isLoopback(this.#redirect.hostname) }, signal, context);
    const verifier = this.nonce(32), state = this.nonce(24);
    const url = new URL(metadata.authorizationEndpoint);
    const parameters = { response_type: 'code', client_id: registration.clientId, redirect_uri: redirectUri,
      code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', state, resource: session.resource };
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    url.searchParams.delete('scope');
    if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
    const callbackController = new AbortController();
    const callbackSignal = AbortSignal.any([signal, callbackController.signal]);
    try {
      const callback = redirect.waitForCallback({ redirectUri, state, signal: callbackSignal });
      // Listen before opening the browser; avoid an unhandled rejection if either port fails.
      const [, params] = await Promise.all([Promise.resolve().then(() => browser.open(url.href, callbackSignal)), callback]);
      if (params.getAll('state').length !== 1 || params.get('state') !== state) fail('state-mismatch');
      const iss = params.getAll('iss');
      if (iss.length > 1 || (iss.length === 0 ? metadata.responseIssuer : iss[0] !== metadata.issuer)) fail('issuer-mismatch');
      if (params.has('error')) fail('authorization-rejected');
      const code = params.get('code');
      if (!code || params.getAll('code').length !== 1) fail('invalid-code');
      await this.token(session, new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }), scopes, signal);
    } finally { callbackController.abort(); }
  }

  private async token(session: Session, form: URLSearchParams, scopes: readonly string[], signal: AbortSignal, refresh?: string, previous?: Grant) {
    const { metadata, registration } = session;
    form.set('client_id', registration.clientId);
    form.set('resource', session.resource);
    const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    const basicAuth = () => {
      const encode = (value: string) => new URLSearchParams({ x: value }).toString().slice(2);
      headers.set('Authorization', `Basic ${Buffer.from(`${encode(registration.clientId)}:${encode(registration.clientSecret!)}`).toString('base64')}`);
    };
    if (registration.authMethod === 'client_secret_basic') basicAuth();
    else if (registration.authMethod === 'client_secret_post') form.set('client_secret', registration.clientSecret!);
    else if (registration.authMethod === 'none') { /* public client */ }
    else if (registration.clientSecret !== undefined) {
      if (!metadata.clientAuthMethods.length || metadata.clientAuthMethods.includes('client_secret_basic')) {
        basicAuth();
      } else if (metadata.clientAuthMethods.includes('client_secret_post')) {
        form.set('client_secret', registration.clientSecret);
      } else fail('client-auth-method-unsupported');
    }
    signal.throwIfAborted();
    let response: Response;
    try { response = await this.#fetch.fetch(metadata.tokenEndpoint.href, { method: 'POST', body: form.toString(), headers,
      credentials: 'omit', redirect: 'error', signal }); }
    catch { return fail('token-endpoint-unavailable'); }
    let doc: Record<string, unknown>;
    try { doc = object(await response.json()); } catch { return fail('token-response-invalid'); }
    if (!response.ok) {
      if (refresh && response.status === 400 && doc['error'] === 'invalid_grant') return false;
      return fail('token-request-rejected');
    }
    if (typeof doc['token_type'] !== 'string' || doc['token_type'].toLowerCase() !== 'bearer') fail('invalid-token-type');
    const token = bearerValue(doc['access_token']);
    const lifetime = doc['expires_in'];
    if (lifetime !== undefined && (typeof lifetime !== 'number' || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > Number.MAX_SAFE_INTEGER / 1000)) fail('invalid-token-expiry');
    const issuedRefresh = doc['refresh_token'];
    if (issuedRefresh !== undefined && (typeof issuedRefresh !== 'string' || !issuedRefresh)) fail('invalid-refresh-token');
    const key = this.refreshKey(session);
    signal.throwIfAborted();
    if (issuedRefresh !== undefined) await this.#store.set(key, issuedRefresh);
    else if (!refresh) await this.#store.delete(key);
    signal.throwIfAborted();
    const context = refresh && previous?.metadata.issuer === metadata.issuer && previous.registration.clientId === registration.clientId ? previous.context : randomBytes(18).toString('base64url');
    this.#grant = { ...session, token, context, version: {}, expires: lifetime === undefined ? Infinity : this.now() + lifetime * 1000,
      scopes: [...new Set([...scopes, ...scopesOf(typeof doc['scope'] === 'string' ? doc['scope'] : undefined)])] };
    return true;
  }
}
