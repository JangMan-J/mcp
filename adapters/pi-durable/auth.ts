// Auth selection vendored from adapters/pi-coding-agent/live-auth.ts (no cross-adapter imports).
import { canonicalServerCardUrl, discoverCard, type DiscoverCardOptions, type ParsedServerCard } from '@mcp-client/ext-server-cards';
import { createIsolatedCredentialStore } from './credentials.js';
import { createPrivateKey } from "node:crypto";
import {
  AuthError, ConfiguredBearer, OAuthAuthorization, SafeFetch, openSystemBrowser,
  parseBearerChallenges, startLoopbackRedirect, type AuthorizationConsent,
} from "@mcp-client/auth";
import { JSONRPC_VERSION, type AuthProvider, type BrowserPort, type CredentialStore, type FetchPort } from "@mcp-client/core";
import { ClientCredentialsAuth, createWebCryptoAssertionSigner, type AssertionSigner } from "@mcp-client/ext-client-credentials";
import { EnterpriseManagedAuth } from "@mcp-client/ext-enterprise-auth";

interface PiLiveAuthOptions {
  credentials?: CredentialStore;
  authorizationConsent?: AuthorizationConsent;
  resolveProviderToken?: (provider: string) => Promise<string>;
  browser?: BrowserPort;
  signal?: AbortSignal;
}
export interface LiveAuth {
  provider?: AuthProvider;
  signIn?(signal: AbortSignal): Promise<void>;
  close?(): void | Promise<void>;
}

type RecordValue = Readonly<Record<string, unknown>>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const unavailable = (reason: string) => new AuthError("auth-unavailable", reason);
const text = (v: unknown): string | undefined => typeof v === "string" && v.trim() ? v : undefined;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string");
const scopes = (v: unknown) => strings(v) ? v : text(v)?.trim().split(/ +/u);
const loopback = (url: URL) => url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
const systemBrowser: BrowserPort = { open: openSystemBrowser };

async function privateKeySigner(pem: string, alg: unknown, kid: string | undefined): Promise<AssertionSigner> {
  if (alg !== "RS256" && alg !== "ES256") throw unavailable("invalid-signing-algorithm");
  let der: Buffer;
  try {
    const key = createPrivateKey(pem);
    if (alg === "RS256" ? key.asymmetricKeyType !== "rsa"
      : key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw 0;
    der = key.export({ format: "der", type: "pkcs8" });
  } catch { throw unavailable("invalid-signing-key"); }
  const params = alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  try {
    const key = await crypto.subtle.importKey("pkcs8", new Uint8Array(der), params, false, ["sign"]);
    return createWebCryptoAssertionSigner(alg, key, kid);
  } catch { throw unavailable("invalid-signing-key"); }
  finally { der.fill(0); }
}

async function createPiLiveAuth(descriptor: LegacyServerConfig, options: PiLiveAuthOptions): Promise<LiveAuth> {
  options.signal?.throwIfAborted();
  if (descriptor.transport !== "http" || !descriptor.url || !descriptor.trusted) return {};
  const { url: resource, auth, oauth, clientCredentials, enterpriseAuth } = descriptor as LegacyServerConfig & {
    url: string; clientCredentials?: RecordValue; enterpriseAuth?: RecordValue;
  };
  if ([auth, oauth, clientCredentials, enterpriseAuth].filter(value => value !== undefined).length > 1) {
    throw unavailable("conflicting-auth-config");
  }
  const url = new URL(resource);
  if (!(url.protocol === "https:" || loopback(url)) || url.username || url.password || url.hash) {
    if (auth || oauth || clientCredentials || enterpriseAuth) throw unavailable("invalid-auth-resource");
    return {};
  }
  const { credentials, resolveProviderToken } = options;
  if (auth) {
    // Trust is the descriptor's explicit `trusted` flag (checked above), not Pi's global config source.
    if (!resolveProviderToken) throw unavailable("provider-token-resolver");
    return { provider: new ConfiguredBearer({ resource, token: () => resolveProviderToken(auth.provider), allowInsecureDev: true }) };
  }
  const safe = new SafeFetch({ allowInsecureDev: true });
  const local = loopback(url) ? new SafeFetch({ allowInsecureDev: true,
    // SafeFetch passes IPv6 hosts unbracketed; only the resource's own loopback host may bypass the address blocklist.
    allowAddress: (host, ip) => host === url.hostname.replace(/^\[|\]$/gu, "") && (ip === "127.0.0.1" || ip === "::1"),
  }) : undefined;
  const fetcher: FetchPort = { fetch: (input, init) =>
    (local && new URL(input).origin === url.origin ? local : safe).fetch(input, init),
  };
  const common = { resource, allowInsecureDev: true, fetch: fetcher };
  if (clientCredentials !== undefined) {
    const c = clientCredentials;
    if (!record(c)) throw unavailable("invalid-client-credentials-config");
    const clientId = text(c.clientId), secret = text(c.clientSecret ?? c.secret), credentialKey = text(c.credentialKey);
    const pem = text(c.privateKeyPem), expectedIssuer = text(c.expectedIssuer), requestedScopes = scopes(c.scopes);
    if (!clientId || [secret, credentialKey, pem].filter(Boolean).length !== 1 || (credentialKey && !credentials)) {
      throw unavailable("invalid-client-credentials-config");
    }
    return { provider: new ClientCredentialsAuth({ ...common, clientId,
      ...(secret ? { secret } : {}), ...(credentialKey && credentials ? { credentialKey, credentials } : {}),
      ...(pem ? { signer: await privateKeySigner(pem, c.alg, text(c.kid)) } : {}),
      ...(expectedIssuer ? { expectedIssuer } : {}), ...(requestedScopes ? { scopes: requestedScopes } : {}),
    }) };
  }
  if (enterpriseAuth !== undefined) {
    const c = enterpriseAuth;
    if (!record(c)) throw unavailable("invalid-enterprise-auth-config");
    const idpIssuer = text(c.idpIssuer), key = text(c.identityAssertionKey ?? c.credentialKey), type = c.identityAssertionType ?? "id_token";
    if (!idpIssuer || !key || !credentials || (type !== "id_token" && type !== "saml2")) {
      throw unavailable("invalid-enterprise-auth-config");
    }
    const idpTokenEndpoint = text(c.idpTokenEndpoint), clientId = text(c.clientId), clientSecret = text(c.clientSecret);
    const cimdClientId = text(c.cimdClientId), requestedScopes = scopes(c.scopes);
    return { provider: new EnterpriseManagedAuth({ ...common, idpIssuer,
      ...(idpTokenEndpoint ? { idpTokenEndpoint } : {}), ...(clientId ? { clientId } : {}),
      ...(clientSecret ? { clientSecret } : {}), ...(cimdClientId ? { cimdClientId } : {}),
      ...(requestedScopes ? { scopes: requestedScopes } : {}),
      identityPort: { async getIdentityAssertion({ signal }) {
        signal.throwIfAborted();
        const value = await credentials.get(key);
        signal.throwIfAborted();
        if (!value) throw unavailable("identity-assertion-unavailable");
        return { type, value };
      } },
    }) };
  }
  return createOAuth(resource, descriptor.name, oauth, fetcher, options);
}

function createOAuth(resource: string, serverLabel: string, config: LegacyOAuthConfig | undefined, fetcher: FetchPort, options: PiLiveAuthOptions): LiveAuth {
  const { authorizationConsent, browser = systemBrowser, credentials } = options;
  const closed = new AbortController();
  const lifetime = options.signal ? AbortSignal.any([closed.signal, options.signal]) : closed.signal;
  let active: OAuthAuthorization | undefined;
  let signingIn = false;
  const provider: AuthProvider = {
    contextId: () => lifetime.aborted ? "anonymous" : active?.contextId() ?? "anonymous",
    async headerFor(url, operation, context) {
      if (lifetime.aborted || !active) return undefined;
      const signal = context ? AbortSignal.any([lifetime, context.signal]) : lifetime;
      return active.headerFor(url, operation, { ...context, signal });
    },
    // A rejected or insufficient grant requires another explicit sign-in; expiry can still refresh in headerFor.
    async onChallenge() { return false; },
    stepUpLimit: 0,
  };
  return { provider, close() { closed.abort(); active = undefined; }, async signIn(requestSignal) {
    const signal = AbortSignal.any([lifetime, requestSignal, AbortSignal.timeout(120_000)]);
    signal.throwIfAborted();
    if (!authorizationConsent) throw unavailable("interactive-sign-in-unavailable");
    // ## YAGNI: the shared redirect port only binds an ephemeral IPv4 loopback socket.
    if (config?.callbackUrl !== undefined || config?.callbackPort !== undefined) throw unavailable("fixed-oauth-callback-unsupported");
    if (config?.clientRegistration === "cimd") throw unavailable("cimd-callback-unsupported");
    if (signingIn) throw unavailable("sign-in-in-progress");
    signingIn = true;
    let redirect: Awaited<ReturnType<typeof startLoopbackRedirect>> | undefined;
    const flow = new AbortController();
    let committed = false;
    const flowSignal = AbortSignal.any([signal, flow.signal]);
    try {
      // Use the real protected route and server-advertised scopes, not legacy scope overrides.
      const response = await fetcher.fetch(resource, { method: "POST", redirect: "manual", credentials: "omit", signal,
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: JSONRPC_VERSION, id: 1, method: "server/discover" }),
      });
      const header = response.headers.get("www-authenticate") ?? undefined;
      await response.body?.cancel();
      if (response.status !== 401 || !header || !parseBearerChallenges(header).length) throw unavailable("no-bearer-challenge");
      redirect = await startLoopbackRedirect();
      signal.throwIfAborted();
      const { redirectUri } = redirect;
      const pin = text(config?.issuer);
      const metadataUrl = text(config?.authServerMetadataUrl);
      const clientId = text(config?.clientId), clientSecret = text(config?.clientSecret);
      if (clientSecret && (!clientId || (!pin && !metadataUrl))) throw unavailable("oauth-client-secret-requires-issuer");
      // Registration is bound to a redirect URI; a cached dynamic registration for a different port cannot be reused.
      const store = credentials && {
        get: (key: string) => credentials.get(registrationKey(key, redirectUri)),
        set: (key: string, value: string) => credentials.set(registrationKey(key, redirectUri), value),
        delete: (key: string) => credentials.delete(registrationKey(key, redirectUri)),
      };
      const oauth = new OAuthAuthorization({ resource, serverLabel, redirectUri, redirect, allowInsecureDev: true,
        ...(store ? { credentials: store } : {}),
        ...(config?.clientRegistration === "dcr" && !clientId ? { dynamicRegistration: { clientName: config.clientName ?? "Pi MCP Client" } } : {}),
        chooseAuthorizationServer(candidates) {
          const issuer = candidates.find(candidate => (!pin || pin === candidate) && (!metadataUrl || issuerMetadataUrls(candidate).includes(metadataUrl)));
          if ((pin || metadataUrl) && !issuer) throw unavailable("oauth-issuer-mismatch");
          return issuer ?? candidates[0]!;
        },
        fetch: { fetch(url, init) {
          // Detaching the provider's challenge wait does not cancel its internal work.
          const scoped = committed ? lifetime : flowSignal;
          return fetcher.fetch(url, { ...init, signal: init.signal ? AbortSignal.any([scoped, init.signal]) : scoped });
        } },
        browser: { open(url, authSignal) {
          flowSignal.throwIfAborted();
          return browser.open(url, AbortSignal.any([flowSignal, authSignal]));
        } },
        consent: { async request(prompt, authSignal) {
          const scoped = AbortSignal.any([flowSignal, authSignal]);
          scoped.throwIfAborted();
          if (prompt.kind === "client-info" && clientId) {
            return { decision: "accept", registration: { clientId, redirectUris: [redirectUri], ...(clientSecret ? { clientSecret } : {}) } };
          }
          return abortable(scoped, () => authorizationConsent.request(prompt, scoped));
        } },
      });
      await oauth.onChallenge({ status: 401, resource: new URL(resource).href, wwwAuthenticate: header, credentialVersion: null }, signal);
      signal.throwIfAborted();
      committed = true;
      active = oauth;
    } finally {
      flow.abort();
      redirect?.close();
      signingIn = false;
    }
  } };
}

async function abortable<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([run(), cancelled]);
  } finally { signal.removeEventListener("abort", abort); }
}

function registrationKey(key: string, redirectUri: string): string {
  return key.startsWith('["registration",') ? JSON.stringify([key, redirectUri]) : key;
}

function issuerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer), path = url.pathname.replace(/\/$/u, "");
  return [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`];
}

/** Structural subset of the Pi `mcpServers` entry this module reads. */
export interface LegacyOAuthConfig {
  readonly clientId?: string; readonly clientSecret?: string; readonly callbackPort?: number;
  readonly callbackUrl?: string; readonly clientName?: string;
  readonly clientRegistration?: "auto" | "dcr" | "cimd"; readonly authServerMetadataUrl?: string;
  readonly issuer?: string; readonly scope?: string;
}
export interface LegacyServerConfig {
  readonly name: string; readonly source: string; readonly trusted: boolean;
  readonly transport: string; readonly url?: string;
  readonly oauth?: LegacyOAuthConfig; readonly auth?: { readonly provider: string };
  readonly clientCredentials?: RecordValue; readonly enterpriseAuth?: RecordValue;
}



/** Runtime options should extend this. */
export interface LiveAuthOptions extends Omit<PiLiveAuthOptions, 'credentials'> {
  /** Durable-run state directory; credentials are stored only here, never in global Pi or mcp-auth.json. */
  stateDir: string;
}

/**
 * Same OAuth / client-credentials / enterprise / configured-bearer selection as the Pi live adapter,
 * but bound to an isolated credential store.
 */
export async function createLiveAuth(descriptor: LegacyServerConfig, options: LiveAuthOptions): Promise<LiveAuth> {
  const { stateDir, ...rest } = options;
  return createPiLiveAuth(descriptor, { ...rest, credentials: createIsolatedCredentialStore(stateDir) });
}

/**
 * Read-only server card inspection for a trusted HTTP server. Returns undefined when the server is not
 * an eligible HTTP target. Card metadata is informational only; it never grants capabilities or auth.
 */
export async function inspectServerCard(
  descriptor: LegacyServerConfig, signal?: AbortSignal, options: DiscoverCardOptions = {},
): Promise<ParsedServerCard | undefined> {
  signal?.throwIfAborted();
  if (descriptor.transport !== 'http' || !descriptor.url || !descriptor.trusted) return undefined;
  const rest = options;
  const base: FetchPort = rest.fetch ?? new SafeFetch({ allowInsecureDev: rest.allowInsecureDev === true });
  const fetch: FetchPort = signal
    ? { fetch: (input, init) => base.fetch(input, { ...init, signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal }) }
    : base;
  return discoverCard(canonicalServerCardUrl(descriptor.url), { ...rest, fetch });
}
