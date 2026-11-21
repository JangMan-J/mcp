import { createPrivateKey, sign } from "node:crypto";
import {
  AuthError, ConfiguredBearer, OAuthAuthorization, SafeFetch, openSystemBrowser,
  parseBearerChallenges, startLoopbackRedirect, type AuthorizationConsent, type AuthorizationPrompt,
} from "@mcp-client/auth";
import { JSONRPC_VERSION, type AuthProvider, type BrowserPort, type ConsentPort, type ConsentPrompt, type CredentialStore, type FetchPort } from "@mcp-client/core";
import { ClientCredentialsAuth, type AssertionSigner } from "@mcp-client/ext-client-credentials";
import { EnterpriseManagedAuth } from "@mcp-client/ext-enterprise-auth";
import type { LegacyOAuthConfig, LegacyServerConfig } from "./config.js";

interface LiveAuthOptions {
  credentials?: CredentialStore;
  authorizationConsent?: AuthorizationConsent;
  resolveProviderToken?: (provider: string) => Promise<string>;
  browser?: BrowserPort;
  signal?: AbortSignal;
}
interface LiveAuth {
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
const uiAvailable = new WeakMap<AuthorizationConsent, () => boolean>();

function privateKeySigner(pem: string, alg: unknown, kid: string | undefined): AssertionSigner {
  if (alg !== "RS256" && alg !== "ES256") throw unavailable("invalid-signing-algorithm");
  try {
    const key = createPrivateKey(pem);
    if (alg === "RS256" ? key.asymmetricKeyType !== "rsa"
      : key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw unavailable("invalid-signing-key");
    }
    return { alg, ...(kid ? { kid } : {}), sign: (input) => sign("sha256", input,
      alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key) };
  } catch { throw unavailable("invalid-signing-key"); }
}

export async function createLiveAuth(descriptor: LegacyServerConfig, options: LiveAuthOptions): Promise<LiveAuth> {
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
    if (descriptor.source !== "global" || !resolveProviderToken) throw unavailable("provider-token-resolver");
    return { provider: new ConfiguredBearer({ resource, token: () => resolveProviderToken(auth.provider), allowInsecureDev: true }) };
  }
  const safe = new SafeFetch({ allowInsecureDev: true });
  const local = loopback(url) ? new SafeFetch({ allowInsecureDev: true,
    allowAddress: (host, ip) => host === url.hostname && (ip === "127.0.0.1" || ip === "::1"),
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
      ...(pem ? { signer: privateKeySigner(pem, c.alg, text(c.kid)) } : {}),
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

function createOAuth(resource: string, serverLabel: string, config: LegacyOAuthConfig | undefined, fetcher: FetchPort, options: LiveAuthOptions): LiveAuth {
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
    if (!authorizationConsent || uiAvailable.get(authorizationConsent)?.() === false) throw unavailable("interactive-sign-in-unavailable");
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

function registrationKey(key: string, redirectUri: string): string {
  return key.startsWith('["registration",') ? JSON.stringify([key, redirectUri]) : key;
}

function issuerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer), path = url.pathname.replace(/\/$/u, "");
  return [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`];
}

interface PiUi {
  confirm(title: string, message: string, options?: { signal: AbortSignal }): Promise<boolean>;
  input(title: string, placeholder?: string, options?: { signal: AbortSignal }): Promise<string | undefined>;
  select(title: string, choices: string[], options?: { signal: AbortSignal }): Promise<string | undefined>;
}

async function abortable<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }), cancelled]);
    signal.throwIfAborted();
    return result;
  } finally { signal.removeEventListener("abort", abort); }
}

export function createPiConsent(getContext: () => unknown): { consent: ConsentPort; authorizationConsent: AuthorizationConsent } {
  const ui = () => {
    const ctx = getContext();
    return record(ctx) && ctx.hasUI === true && record(ctx.ui) ? ctx.ui as unknown as PiUi : undefined;
  };
  const cancel = { decision: "cancel" } as const;
  const decline = { decision: "decline" } as const;
  const accept = { decision: "accept" } as const;
  const authorizationConsent: AuthorizationConsent = { async request(prompt, signal) {
    const host = ui();
    if (!host || signal.aborted) return cancel;
    const confirm = (message: string) => abortable(signal, () => host.confirm(`MCP authorization: ${prompt.serverLabel}`, message, { signal }));
    try {
      if (prompt.kind === "client-info") {
        if (!await confirm(`Provide OAuth client details for ${prompt.issuer}?\nRedirect: ${prompt.redirectUri}`)) return decline;
        const clientId = await abortable(signal, () => host.input("OAuth client ID", undefined, { signal }));
        if (!clientId?.trim()) return cancel;
        const clientSecret = await abortable(signal, () => host.input("OAuth client secret (optional)", undefined, { signal }));
        if (clientSecret === undefined) return cancel;
        return { ...accept, registration: { clientId, redirectUris: [prompt.redirectUri], ...(clientSecret ? { clientSecret } : {}) } };
      }
      return await confirm(authorizationDetails(prompt)) ? accept : decline;
    } catch { return cancel; }
  } };
  uiAvailable.set(authorizationConsent, () => !!ui());
  const consent: ConsentPort = { async request(prompt, signal) {
    const host = ui();
    if (!host || signal.aborted) return cancel;
    const title = `MCP: ${prompt.serverLabel}`;
    const confirm = (message: string) => abortable(signal, () => host.confirm(title, message, { signal }));
    try {
      switch (prompt.kind) {
        case "url-elicitation": {
          if (!prompt.url) return decline;
          const url = new URL(prompt.url);
          if (url.protocol !== "https:" || url.username || url.password) return decline;
          if (!await confirm(`${prompt.message ?? "Open this URL?"}\n\n${prompt.url}`)) return decline;
          await abortable(signal, () => systemBrowser.open(prompt.url!, signal));
          return accept;
        }
        case "form-elicitation": {
          if (!await confirm(prompt.message ?? "Provide information to this server?")) return decline;
          const content = await form(prompt.schema, host, signal);
          return content ? { ...accept, content } : cancel;
        }
        case "client-info": {
          if (!prompt.issuer || !prompt.redirectUri) return decline;
          const result = await authorizationConsent.request({ kind: "client-info", serverLabel: prompt.serverLabel,
            issuer: prompt.issuer, redirectUri: prompt.redirectUri }, signal);
          return result.decision === "accept" ? { ...accept, content: { ...result.registration } } : result;
        }
        case "authorize":
        case "auth":
          if (!prompt.issuerHost || !prompt.resource || !prompt.redirectHost) return decline;
          return await confirm(authorizationDetails(prompt)) ? accept : decline;
        case "tool-call":
          return await confirm(prompt.message ?? "Approve this tool action?") ? accept : decline;
        default: return decline;
      }
    } catch { return cancel; }
  } };
  return { consent, authorizationConsent };
}

function authorizationDetails(prompt: Pick<ConsentPrompt, "issuerHost" | "resource" | "scopes" | "redirectHost" | "localhostWarning"> | Extract<AuthorizationPrompt, { kind: "authorize" }>) {
  return `Authorize ${prompt.resource}?\nIssuer: ${prompt.issuerHost}\nScopes: ${prompt.scopes?.join(", ") || "(none)"}\nRedirect: ${prompt.redirectHost}${prompt.localhostWarning ? " (local callback)" : ""}`;
}

async function form(schema: ConsentPrompt["schema"], ui: PiUi, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
  if (schema?.type !== "object" || !record(schema.properties)) return;
  const required = strings(schema.required) ? schema.required : [];
  if (required.some(key => !Object.hasOwn(schema.properties as RecordValue, key))) return;
  const content: [string, unknown][] = [];
  for (const [key, field] of Object.entries(schema.properties)) {
    if (!record(field)) return;
    const label = [text(field.title) ?? key, text(field.description)].filter(Boolean).join(" — ");
    if (field.type === "boolean") {
      content.push([key, await abortable(signal, () => ui.confirm(label, "Select true or false", { signal }))]);
    } else if (field.type === "string" && strings(field.enum)) {
      const choices = [...field.enum];
      const selected = await abortable(signal, () => ui.select(label, choices, { signal }));
      if (selected === undefined || !choices.includes(selected)) return;
      content.push([key, selected]);
    } else if (field.type === "string" || field.type === "number" || field.type === "integer") {
      const value = await abortable(signal, () => ui.input(label, undefined, { signal }));
      if (value === undefined) return;
      if (!value && !required.includes(key)) continue;
      if (field.type === "string") {
        if ((typeof field.minLength === "number" && value.length < field.minLength) || (typeof field.maxLength === "number" && value.length > field.maxLength)) return;
        content.push([key, value]);
      } else {
        const number = Number(value);
        if (!value.trim() || !Number.isFinite(number) || (field.type === "integer" && !Number.isInteger(number)) ||
          (typeof field.minimum === "number" && number < field.minimum) || (typeof field.maximum === "number" && number > field.maximum)) return;
        content.push([key, number]);
      }
    } else return;
  }
  return Object.fromEntries(content);
}
