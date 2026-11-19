import { createHash } from "node:crypto";
import { AuthError, MemoryCredentialStore, SafeFetch, canonicalResource } from "@mcp-client/auth";
import type { AuthChallenge, AuthRequestContext, AuthHeaderResult, AuthProvider, FetchPort } from "@mcp-client/core";
import { parseBearerChallenges } from "@mcp-client/core";
import { isConfigured, type ClientCredentialsConfig } from "./config.js";
import { signAssertion } from "./jwt.js";

const JWT_BEARER = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const SKEW_MS = 10_000;
const DEFAULT_TTL_S = 300;
const ASSERTION_TTL_S = 60;
type Json = Record<string, unknown>;
interface Token { readonly value: string; readonly expiresAt: number }
interface AsMetadata { readonly issuer: string; readonly tokenEndpoint: string; readonly methods: readonly string[]; readonly algs: readonly string[] }

const fail = (reason: string): never => { throw new AuthError("auth-failure", reason); };
const strings = (v: unknown): string[] => Array.isArray(v) && v.every((x) => typeof x === "string") ? v : [];

function secure(input: unknown, dev: boolean): URL {
  if (typeof input !== "string" || /[\s\\<>"'`|{}^]/u.test(input)) return fail("invalid-url");
  let url: URL;
  try { url = new URL(input); } catch { return fail("invalid-url"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(dev && url.protocol === "http:" && loopback))) fail("invalid-url");
  return url;
}

export class ClientCredentialsAuth implements AuthProvider {
  readonly stepUpLimit = 0;
  private readonly fetcher: FetchPort;
  private readonly resource: string;
  private readonly dev: boolean;
  private pinned: string | undefined;
  private token: (Token & { version: object }) | undefined;
  private inflight: Promise<Token & { version: object }> | undefined;

  constructor(private readonly config: ClientCredentialsConfig) {
    if (!isConfigured(config)) throw new AuthError("auth-unavailable", "not-configured");
    this.dev = config.allowInsecureDev === true;
    this.resource = canonicalResource(config.resource!);
    this.fetcher = config.fetch ?? new SafeFetch({ allowInsecureDev: this.dev });
    this.pinned = config.expectedIssuer;
    if (this.pinned !== undefined) secure(this.pinned, this.dev);
  }

  contextId(): string {
    const digest = createHash("sha256").update(`${this.resource}\n${this.config.clientId}\n${this.pinned ?? ""}`).digest("base64url");
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
      const insufficient = parseBearerChallenges(challenge.wwwAuthenticate ?? "").some((c) => c.error === "insufficient_scope");
      // No interactive step-up for a machine credential: abort (AUTH-STEP-4).
      if (insufficient) throw new AuthError("auth-failure", "insufficient-scope");
      return false;
    }
    if (this.token && challenge.credentialVersion !== null && challenge.credentialVersion !== undefined
      && challenge.credentialVersion !== this.token.version) return true; // already replaced by another caller
    if (this.token) { this.token = undefined; this.diag("token-invalidated"); }
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
    const work = this.inflight;
    if (!signal) return work;
    return new Promise((resolve, reject) => {
      const abort = () => reject(new AuthError("auth-failure", "cancelled"));
      if (signal.aborted) return abort();
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private now(): number { return this.config.clock?.now() ?? Date.now(); }
  private diag(event: "token-acquired" | "token-failed" | "token-invalidated", detail?: string): void {
    try { this.config.onDiagnostic?.({ event, ...(detail !== undefined ? { detail } : {}) }); } catch { /* host hook failure is not ours */ }
  }

  private async acquire(): Promise<Token & { version: object }> {
    try {
      const signal = AbortSignal.timeout(30_000);
      const as = await this.discover(signal);
      const token = await this.requestToken(as, signal);
      this.diag("token-acquired", new URL(as.issuer).host);
      return { ...token, version: {} };
    } catch (error) {
      const out = error instanceof AuthError ? error : new AuthError("auth-failure", "token-request-failed");
      this.diag("token-failed", out.reason);
      throw out;
    }
  }

  private async getJson(url: string, signal: AbortSignal): Promise<Json | undefined> {
    let res: Response;
    try { res = await this.fetcher.fetch(url, { method: "GET", credentials: "omit", redirect: "manual", signal }); }
    catch (error) { if (error instanceof AuthError) throw error; return fail("discovery-fetch"); }
    if (res.status === 404 || res.status === 410) { await res.body?.cancel(); return undefined; }
    if (!res.ok) { await res.body?.cancel(); return fail("discovery-fetch"); }
    try {
      const doc: unknown = await res.json();
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) return fail("invalid-document");
      return doc as Json;
    } catch { return fail("invalid-document"); }
  }

  /** PRM then AS metadata. Never reads or calls a registration endpoint (EXT-cc-10). */
  private async discover(signal: AbortSignal): Promise<AsMetadata> {
    const url = secure(this.resource, this.dev);
    const root = `${url.origin}/.well-known/oauth-protected-resource`;
    const candidates = [...new Set([`${root}${url.pathname === "/" ? "" : url.pathname}${url.search}`, root])];
    let prm: Json | undefined;
    for (const candidate of candidates) {
      const doc = await this.getJson(candidate, signal);
      if (!doc) continue;
      if (doc["resource"] !== (candidate === root && candidates.length > 1 ? url.origin : this.resource)) fail("prm-resource-mismatch");
      prm = doc;
      break;
    }
    const issuers = prm ? [...new Set(strings(prm["authorization_servers"]))] : [];
    if (!issuers.length) fail("prm-invalid");
    // Issuer pinning (EXT-cc-8, AUTH-BIND-1/2): credentials only go to the pinned AS.
    const issuer = this.pinned ?? issuers[0]!;
    if (!issuers.includes(issuer)) fail("issuer-mismatch");
    this.pinned = issuer;
    return await this.metadata(issuer, signal);
  }

  private async metadata(issuer: string, signal: AbortSignal): Promise<AsMetadata> {
    const url = secure(issuer, this.dev);
    if (url.search || /[?#]/u.test(issuer)) fail("as-issuer-invalid");
    const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
    const urls = [`${url.origin}/.well-known/oauth-authorization-server${path}`, `${url.origin}/.well-known/openid-configuration${path}`];
    if (path) urls.push(`${url.origin}${path}/.well-known/openid-configuration`);
    for (const candidate of urls) {
      const doc = await this.getJson(candidate, signal);
      if (!doc) continue;
      if (doc["issuer"] !== issuer) fail("as-issuer-mismatch");
      return {
        issuer,
        tokenEndpoint: secure(doc["token_endpoint"], this.dev).href,
        methods: strings(doc["token_endpoint_auth_methods_supported"]),
        algs: strings(doc["token_endpoint_auth_signing_alg_values_supported"]),
      };
    }
    return fail("as-metadata-missing");
  }

  private async secretValue(): Promise<string> {
    const { secret, credentials, credentialKey } = this.config;
    const value = secret ?? (credentials && credentialKey !== undefined ? await credentials.get(credentialKey) : undefined);
    if (!value) throw new AuthError("auth-unavailable", "credentials-missing");
    return value;
  }

  private async requestToken(as: AsMetadata, signal: AbortSignal): Promise<Token> {
    const form = new URLSearchParams({ grant_type: "client_credentials", resource: this.resource });
    if (this.config.scopes?.length) form.set("scope", this.config.scopes.join(" "));
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const { signer, clientId } = this.config;
    if (signer) {
      if (as.methods.length && !as.methods.includes("private_key_jwt")) fail("auth-method-unsupported");
      if (as.algs.length && !as.algs.includes(signer.alg)) fail("signing-alg-unsupported");
      const random = this.config.random?.bytes(16) ?? crypto.getRandomValues(new Uint8Array(16));
      form.set("client_assertion_type", JWT_BEARER);
      form.set("client_assertion", await signAssertion(signer, {
        clientId: clientId!, audience: as.issuer, nowMs: this.now(), ttlSeconds: ASSERTION_TTL_S, jti: Buffer.from(random).toString("hex"),
      }));
    } else {
      const secret = await this.secretValue();
      const methods = as.methods.length ? as.methods : ["client_secret_basic"];
      if (methods.includes("client_secret_basic")) {
        const enc = (s: string) => encodeURIComponent(s).replace(/%20/gu, "+");
        headers["authorization"] = `Basic ${Buffer.from(`${enc(clientId!)}:${enc(secret)}`).toString("base64")}`;
      } else if (methods.includes("client_secret_post")) {
        form.set("client_id", clientId!);
        form.set("client_secret", secret);
      } else fail("auth-method-unsupported");
    }
    let res: Response;
    try { res = await this.fetcher.fetch(as.tokenEndpoint, { method: "POST", headers, body: form.toString(), credentials: "omit", redirect: "manual", signal }); }
    catch (error) { if (error instanceof AuthError) throw error; return fail("token-request-failed"); }
    if (!res.ok) { await res.body?.cancel(); return fail("token-request-rejected"); }
    let body: Json;
    try { body = (await res.json()) as Json; } catch { return fail("invalid-token-response"); }
    const value = body["access_token"];
    if (typeof value !== "string" || !/^[A-Za-z\d._~+/-]+=*$/u.test(value)) return fail("invalid-token-response");
    if (typeof body["token_type"] !== "string" || body["token_type"].toLowerCase() !== "bearer") return fail("invalid-token-response");
    const ttl = typeof body["expires_in"] === "number" && body["expires_in"] > 0 ? body["expires_in"] : DEFAULT_TTL_S;
    return { value, expiresAt: this.now() + ttl * 1000 };
  }
}

export { MemoryCredentialStore };
