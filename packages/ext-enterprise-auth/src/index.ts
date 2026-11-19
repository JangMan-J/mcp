import { createHash } from "node:crypto";
import type {
  AuthChallenge,
  AuthHeaderResult,
  AuthProvider,
  AuthRequestContext,
  CredentialStore,
  Disposable,
  Extension,
  ExtensionCapabilities,
  ExtensionHost,
  FetchPort,
} from "@mcp-client/core";
import { AuthError } from "@mcp-client/core";
import { SafeFetch, canonicalResource } from "@mcp-client/auth";

export const ENTERPRISE_AUTH_EXTENSION_ID =
  "io.modelcontextprotocol/enterprise-managed-authorization" as const;

export const ENTERPRISE_AUTH_PIN = {
  repository: "modelcontextprotocol/ext-auth",
  commit: "15ca394e00a66434520b9ade26294999295a43ae",
  committedAt: "2026-10-23",
  path: "specification/stable/enterprise-managed-authorization/2026-07-28/enterprise-managed-authorization.mdx",
  stage: "stable",
  coreSpecRevision: "2026-07-28",
  coreSpecCommit: "5f5440bb26a62e2cf3440b92da5a667efa03b267",
  standards: ["RFC 8693", "RFC 7523", "ID-JAG"],
} as const;

export interface EnterpriseIdentityAssertion {
  readonly type: "id_token" | "saml2";
  readonly value: string;
}

export interface EnterpriseIdentityPort {
  getIdentityAssertion(ctx: {
    readonly serverLabel?: string;
    readonly resource: string;
    readonly asIssuer: string;
    readonly idpIssuer: string;
    readonly signal: AbortSignal;
  }): Promise<EnterpriseIdentityAssertion>;
  healthy?(): boolean;
}

export interface EnterpriseAuthConfig {
  readonly resource: string;
  readonly idpIssuer: string;
  readonly idpTokenEndpoint?: string;
  readonly identityPort?: EnterpriseIdentityPort;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly cimdClientId?: string;
  readonly credentials?: CredentialStore;
  readonly scopes?: readonly string[];
  readonly fetch?: FetchPort;
  readonly clock?: { now(): number };
  readonly allowInsecureDev?: boolean;
  readonly allowAddress?: (host: string) => boolean;
  readonly onDiagnostic?: (msg: string) => void;
}

const ID_JAG_PROFILE = "urn:ietf:params:oauth:grant-profile:id-jag";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

function fail(reason: string): never {
  throw new AuthError("auth-failure", reason);
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

function isBlockedLiteral(host: string): boolean {
  const h = host.replace(/^\[|\]$/gu, "");
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) || (a === 198 && (b === 18 || b === 19)) || a >= 224) return true;
    return false;
  }
  if (h.includes(":")) {
    const lower = h.toLowerCase();
    // Only globally routable IPv6 (2000::/3, minus special ranges checked by SafeFetch) is allowed.
    if (!/^[23]/u.test(lower)) return true;
    if (lower.startsWith("2001:db8:") || lower.startsWith("2001::") || lower.startsWith("2002:") || lower.startsWith("3fff:")) return true;
  }
  return false;
}

/** Validate an admin-configured URL before any fetch; SafeFetch re-validates the resolved address. */
export function validateEnterpriseUrl(input: string, allowInsecureDev = false, allowAddress?: (host: string) => boolean): URL {
  if (typeof input !== "string" || !/^https?:\/\//iu.test(input) || /[\s\\<>"'`|{}^]/u.test(input)) fail("invalid-url");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("invalid-url");
  }
  if (url.username || url.password || url.hash) fail("invalid-url");
  if (url.protocol !== "https:" && !(allowInsecureDev && url.protocol === "http:" && isLoopback(url.hostname))) fail("invalid-url");
  if (isBlockedLiteral(url.hostname) && !isLoopback(url.hostname) && !(allowAddress?.(url.hostname) ?? false)) fail("ssrf-blocked");
  if (isLoopback(url.hostname) && url.protocol !== "https:" && !allowInsecureDev) fail("invalid-url");
  return url;
}

function validUrl(input: string | undefined, allowInsecureDev?: boolean, allowAddress?: (host: string) => boolean): boolean {
  if (!input) return false;
  try {
    validateEnterpriseUrl(input, allowInsecureDev ?? false, allowAddress);
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid-document");
  return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string") ? (value as string[]) : [];
}

interface Grant {
  readonly token: string;
  readonly expires: number;
  readonly context: string;
  readonly version: object;
}

export class EnterpriseManagedAuth implements AuthProvider {
  readonly #config: EnterpriseAuthConfig;
  readonly #fetch: FetchPort;
  readonly #resource: string;
  #grant: Grant | undefined;
  #pending: Promise<void> | undefined;

  constructor(config: EnterpriseAuthConfig) {
    this.#config = config;
    // Validated eagerly so a blocked IdP endpoint is refused before any network use.
    validateEnterpriseUrl(config.idpIssuer, config.allowInsecureDev, config.allowAddress);
    if (config.idpTokenEndpoint !== undefined) {
      validateEnterpriseUrl(config.idpTokenEndpoint, config.allowInsecureDev, config.allowAddress);
    }
    validateEnterpriseUrl(config.resource, config.allowInsecureDev, config.allowAddress);
    this.#resource = canonicalResource(config.resource);
    this.#fetch = config.fetch ?? new SafeFetch({
      allowInsecureDev: config.allowInsecureDev ?? false,
      ...(config.allowAddress ? { allowAddress: (host: string) => config.allowAddress!(host) } : {}),
    });
  }

  contextId(): string {
    return this.#grant?.context ?? "anonymous";
  }

  async headerFor(url: string, _operation?: string, context?: AuthRequestContext): Promise<AuthHeaderResult | undefined> {
    let matches = false;
    try {
      matches = canonicalResource(url) === this.#resource;
    } catch {
      matches = false;
    }
    if (!matches) return undefined;
    context?.signal.throwIfAborted();
    const grant = this.#grant;
    if (!grant || grant.expires <= this.#now()) {
      await this.#exchange(context?.signal ?? new AbortController().signal, context?.serverLabel);
    }
    const current = this.#grant;
    return current ? { authorization: `Bearer ${current.token}`, contextId: current.context, credentialVersion: current.version } : undefined;
  }

  async onChallenge(challenge: AuthChallenge, signal: AbortSignal, context?: AuthRequestContext): Promise<boolean> {
    if (signal.aborted) fail("cancelled");
    if (challenge.resource !== undefined) {
      let matches = false;
      try {
        matches = canonicalResource(challenge.resource) === this.#resource;
      } catch {
        matches = false;
      }
      if (!matches) return false;
    }
    if (challenge.status === 403) {
      // Scope restriction is terminal: no step-up loop in the enterprise flow.
      if ((challenge.wwwAuthenticate ?? "").includes("insufficient_scope")) {
        throw new AuthError("auth-failure", "insufficient-scope");
      }
      return false;
    }
    const previousVersion = this.#grant?.version;
    if (challenge.credentialVersion !== undefined && challenge.credentialVersion !== null &&
      previousVersion !== undefined && challenge.credentialVersion !== previousVersion) {
      return true;
    }
    this.#grant = undefined;
    await this.#exchange(signal, context?.serverLabel);
    return true;
  }

  #now(): number {
    return this.#config.clock?.now() ?? Date.now();
  }

  #diagnostic(msg: string): void {
    this.#config.onDiagnostic?.(msg);
  }

  async #exchange(signal: AbortSignal, serverLabel?: string): Promise<void> {
    if (this.#pending) return this.#pending;
    const work = this.#doExchange(signal, serverLabel).finally(() => {
      this.#pending = undefined;
    });
    this.#pending = work;
    return work;
  }

  async #getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    let response: Response;
    try {
      response = await this.#fetch.fetch(url, { method: "GET", credentials: "omit", redirect: "manual", signal });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      return fail("discovery-fetch");
    }
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return fail("discovery-fetch");
    }
    try {
      return record(await response.json());
    } catch (error) {
      if (error instanceof AuthError) throw error;
      return fail("invalid-document");
    }
  }

  async #discoverAs(signal: AbortSignal): Promise<{ issuer: string; tokenEndpoint: string; grantProfiles?: readonly string[] }> {
    const resourceUrl = validateEnterpriseUrl(this.#config.resource, this.#config.allowInsecureDev, this.#config.allowAddress);
    const root = `${resourceUrl.origin}/.well-known/oauth-protected-resource`;
    const candidates = [...new Set([`${root}${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`, root])];
    let prm: Record<string, unknown> | undefined;
    for (const candidate of candidates) {
      const doc = await this.#getJson(candidate, signal);
      if (!doc) continue;
      if (doc["resource"] !== this.#resource && doc["resource"] !== resourceUrl.origin) fail("prm-resource-mismatch");
      prm = doc;
      break;
    }
    if (!prm) fail("prm-invalid");
    const issuers = [...new Set(strings(prm["authorization_servers"]))];
    if (!issuers.length) fail("prm-invalid");
    const issuer = issuers[0]!;
    validateEnterpriseUrl(issuer, this.#config.allowInsecureDev, this.#config.allowAddress);
    const issuerUrl = new URL(issuer);
    const path = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/u, "");
    const metaCandidates = [
      `${issuerUrl.origin}/.well-known/oauth-authorization-server${path}`,
      `${issuerUrl.origin}/.well-known/openid-configuration${path}`,
      ...(path ? [`${issuerUrl.origin}${path}/.well-known/openid-configuration`] : []),
    ];
    for (const candidate of metaCandidates) {
      const doc = await this.#getJson(candidate, signal);
      if (!doc) continue;
      if (doc["issuer"] !== issuer) fail("as-issuer-mismatch");
      const profiles = strings(doc["authorization_grant_profiles_supported"]);
      if (doc["authorization_grant_profiles_supported"] !== undefined && !profiles.includes(ID_JAG_PROFILE)) {
        fail("id-jag-unsupported");
      }
      const tokenEndpoint = doc["token_endpoint"];
      if (typeof tokenEndpoint !== "string") fail("as-metadata-missing");
      validateEnterpriseUrl(tokenEndpoint, this.#config.allowInsecureDev, this.#config.allowAddress);
      // authorization_endpoint is deliberately never fetched or opened.
      return { issuer, tokenEndpoint, ...(doc["authorization_grant_profiles_supported"] !== undefined ? { grantProfiles: profiles } : {}) };
    }
    return fail("as-metadata-missing");
  }

  async #discoverIdpTokenEndpoint(signal: AbortSignal): Promise<string> {
    if (this.#config.idpTokenEndpoint !== undefined) return this.#config.idpTokenEndpoint;
    const idpUrl = validateEnterpriseUrl(this.#config.idpIssuer, this.#config.allowInsecureDev, this.#config.allowAddress);
    const path = idpUrl.pathname === "/" ? "" : idpUrl.pathname.replace(/\/$/u, "");
    const candidates = [
      `${idpUrl.origin}/.well-known/oauth-authorization-server${path}`,
      `${idpUrl.origin}/.well-known/openid-configuration${path}`,
      ...(path ? [`${idpUrl.origin}${path}/.well-known/openid-configuration`] : []),
    ];
    for (const candidate of candidates) {
      const doc = await this.#getJson(candidate, signal);
      if (!doc) continue;
      if (doc["issuer"] !== this.#config.idpIssuer) fail("idp-issuer-mismatch");
      const tokenEndpoint = doc["token_endpoint"];
      if (typeof tokenEndpoint !== "string") fail("idp-metadata-missing");
      validateEnterpriseUrl(tokenEndpoint, this.#config.allowInsecureDev, this.#config.allowAddress);
      return tokenEndpoint;
    }
    return fail("idp-metadata-missing");
  }

  async #postToken(endpoint: string, form: URLSearchParams, signal: AbortSignal): Promise<Record<string, unknown>> {
    validateEnterpriseUrl(endpoint, this.#config.allowInsecureDev, this.#config.allowAddress);
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await this.#fetch.fetch(endpoint, {
        method: "POST",
        body: form.toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (error instanceof AuthError) throw error;
      return fail("token-endpoint-unavailable");
    }
    let doc: Record<string, unknown>;
    try {
      doc = record(await response.json());
    } catch {
      return fail("token-response-invalid");
    }
    if (doc["error"] === "insufficient_scope") throw new AuthError("auth-failure", "insufficient-scope");
    if (!response.ok) fail("token-request-rejected");
    return doc;
  }

  async #doExchange(signal: AbortSignal, serverLabel?: string): Promise<void> {
    const port = this.#config.identityPort;
    if (!port) throw new AuthError("auth-unavailable", "identity-port-missing");
    const as = await this.#discoverAs(signal);
    const idpTokenEndpoint = await this.#discoverIdpTokenEndpoint(signal);
    signal.throwIfAborted();
    const assertion = await port.getIdentityAssertion({
      ...(serverLabel !== undefined ? { serverLabel } : {}),
      resource: this.#resource,
      asIssuer: as.issuer,
      idpIssuer: this.#config.idpIssuer,
      signal,
    });
    if (!assertion || (assertion.type !== "id_token" && assertion.type !== "saml2") || typeof assertion.value !== "string" || !assertion.value) {
      fail("invalid-identity-assertion");
    }
    // Step 1: RFC 8693 token exchange at the IdP, audience is the validated Resource AS issuer.
    const exchangeForm = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      requested_token_type: ID_JAG_TOKEN_TYPE,
      subject_token: assertion.value,
      subject_token_type: assertion.type === "saml2"
        ? "urn:ietf:params:oauth:token-type:saml2"
        : "urn:ietf:params:oauth:token-type:id_token",
      audience: as.issuer,
      resource: this.#resource,
    });
    if (this.#config.scopes?.length) exchangeForm.set("scope", this.#config.scopes.join(" "));
    if (this.#config.clientId !== undefined) exchangeForm.set("client_id", this.#config.clientId);
    if (this.#config.clientSecret !== undefined) exchangeForm.set("client_secret", this.#config.clientSecret);
    const jagDoc = await this.#postToken(idpTokenEndpoint, exchangeForm, signal);
    const idJag = jagDoc["access_token"];
    if (typeof idJag !== "string" || !idJag) fail("invalid-id-jag");
    const issuedType = jagDoc["issued_token_type"];
    if (issuedType !== undefined && issuedType !== ID_JAG_TOKEN_TYPE) fail("invalid-id-jag");

    // Step 2: RFC 7523 JWT bearer redemption at the Resource AS. Only the AS issues the access token.
    const redeemForm = new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: idJag,
      resource: this.#resource,
    });
    const clientId = this.#config.clientId ?? this.#config.cimdClientId;
    if (clientId !== undefined) redeemForm.set("client_id", clientId);
    if (this.#config.clientSecret !== undefined) redeemForm.set("client_secret", this.#config.clientSecret);
    const tokenDoc = await this.#postToken(as.tokenEndpoint, redeemForm, signal);
    if (typeof tokenDoc["token_type"] === "string" && tokenDoc["token_type"].toLowerCase() !== "bearer") fail("invalid-token-type");
    const token = tokenDoc["access_token"];
    if (typeof token !== "string" || !token) fail("invalid-access-token");
    const lifetime = tokenDoc["expires_in"];
    if (lifetime !== undefined && (typeof lifetime !== "number" || !Number.isFinite(lifetime) || lifetime <= 0)) fail("invalid-token-expiry");
    const context = createHash("sha256")
      .update(JSON.stringify([this.#resource, as.issuer, this.#config.idpIssuer, clientId ?? null]))
      .digest("base64url");
    signal.throwIfAborted();
    this.#grant = {
      token,
      context,
      version: {},
      expires: lifetime === undefined ? Number.POSITIVE_INFINITY : this.#now() + lifetime * 1000,
    };
    if (this.#config.credentials && typeof tokenDoc["refresh_token"] === "string" && tokenDoc["refresh_token"]) {
      // Stored only through the host store under a non-secret key; never diagnosed.
      await this.#config.credentials.set(JSON.stringify(["enterprise-refresh", this.#resource, as.issuer]), tokenDoc["refresh_token"]);
    }
    this.#diagnostic("enterprise-auth exchange completed");
  }
}

export class EnterpriseAuthExtension implements Extension {
  readonly id = ENTERPRISE_AUTH_EXTENSION_ID;
  readonly stage = "stable" as const;
  readonly defaultEnabled = false as const;
  readonly pin = ENTERPRISE_AUTH_PIN;
  readonly #config: EnterpriseAuthConfig | undefined;
  #provider: EnterpriseManagedAuth | undefined;

  constructor(config?: EnterpriseAuthConfig) {
    this.#config = config;
  }

  health(): "working" | "unavailable" {
    const config = this.#config;
    if (!config?.identityPort) return "unavailable";
    try {
      if (config.identityPort.healthy?.() === false) return "unavailable";
    } catch {
      return "unavailable";
    }
    if (!validUrl(config.idpIssuer, config.allowInsecureDev, config.allowAddress)) return "unavailable";
    if (!validUrl(config.resource, config.allowInsecureDev, config.allowAddress)) return "unavailable";
    if (config.idpTokenEndpoint !== undefined && !validUrl(config.idpTokenEndpoint, config.allowInsecureDev, config.allowAddress)) {
      return "unavailable";
    }
    return "working";
  }

  settings(): Record<string, unknown> | undefined {
    return this.health() === "working" ? {} : undefined;
  }

  capabilities(isWorking: boolean): ExtensionCapabilities {
    if (isWorking && this.health() === "working") {
      return { extensions: { [ENTERPRISE_AUTH_EXTENSION_ID]: {} } };
    }
    return {};
  }

  attach(_host: ExtensionHost): Disposable {
    return { dispose() {} };
  }

  createAuthProvider(): EnterpriseManagedAuth | undefined {
    if (!this.#config) return undefined;
    this.#provider ??= new EnterpriseManagedAuth(this.#config);
    return this.#provider;
  }
}

export function createEnterpriseAuthExtension(config?: EnterpriseAuthConfig): EnterpriseAuthExtension {
  return new EnterpriseAuthExtension(config);
}
