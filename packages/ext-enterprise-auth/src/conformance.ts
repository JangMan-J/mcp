import { AuthError } from "@mcp-client/core";
import type { FetchPort } from "@mcp-client/core";
import {
  EnterpriseAuthExtension,
  EnterpriseManagedAuth,
  type EnterpriseAuthConfig,
  type EnterpriseIdentityPort,
} from "./index.js";

export class ObservationMismatch extends Error {
  readonly isObservationMismatch = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ObservationMismatch";
  }
}

const RESOURCE = "https://mcp.test/rpc";
const AS_ISSUER = "https://as.test/tenant";
const IDP_ISSUER = "https://idp.test/tenant";
const ASSERTION = "fixture-assertion-secret";
const ID_JAG = "fixture-id-jag-secret";
const ACCESS = "fixture-access-1";
const SECRETS = [ASSERTION, ID_JAG, ACCESS, "fixture-client-secret"];

const MUTANTS = new Set([
  "wrong-audience",
  "wrong-resource",
  "no-identity-port",
  "leak-secrets",
  "redirect-to-authorization-endpoint",
  "ignore-insufficient-scope",
  "ssrf-bypass",
  "force-capability",
  "browser-assertion",
]);

export function supportsMutant(name: string): boolean {
  return MUTANTS.has(name);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed fixture: expected object");
  return value as Record<string, unknown>;
}

function mismatch(message: string): never {
  throw new ObservationMismatch(message);
}

export interface WireFrame {
  direction: "client" | "server";
  endpoint: "mcp" | "oauth" | "registration" | "other";
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  message?: unknown;
}

export interface ExchangeObservation {
  frames: WireFrame[];
  mcpEndpoint?: string;
  zeroWire?: boolean;
}

/** Map synthetic `*.test` hosts to loopback `*.test.localhost` for recorded transcripts. */
function loopback<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.test)(?![A-Za-z0-9.-])/gu, "$1.localhost")) as T;
}

function classify(url: string, resource: string): WireFrame["endpoint"] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "other";
  }
  const r = new URL(resource);
  if (u.origin === r.origin && u.pathname === r.pathname && !u.search) return "mcp";
  if (/\/register\/?$/u.test(u.pathname)) return "registration";
  if (/\.well-known|\/(token|authorize)\/?$|metadata\.json$/u.test(u.pathname)) return "oauth";
  return "other";
}

export async function runExchange(fixture: unknown, mutant?: string): Promise<ExchangeObservation> {
  if (mutant !== undefined && !MUTANTS.has(mutant)) throw new Error(`unknown ema mutant: ${mutant}`);
  const fx = record(fixture);
  if (typeof fx["id"] !== "string" || !fx["id"].startsWith("ext/ema/")) throw new Error("malformed fixture: id");
  const client = record(fx["client"] ?? {});
  const expect = record(fx["expect"] ?? {});
  if (Object.keys(expect).length === 0) throw new Error("malformed fixture: empty expect");

  const fetches: string[] = [];
  const frames: WireFrame[] = [];
  const resource = (client["resource"] as string | undefined) ?? RESOURCE;
  const forms: Record<string, string>[] = [];
  const diagnostics: string[] = [];
  let identityCalls = 0;
  let identityContext: Record<string, unknown> = {};
  let assertionSource = "port";

  const grantProfiles = client["grantProfiles"];
  const idpError = client["idpError"] as string | undefined;
  const asError = client["asError"] as string | undefined;

  const fetcher: FetchPort = {
    async fetch(url, init) {
      const method = init.method ?? "GET";
      const reqHeaders = init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {};
      const endpoint = classify(url, resource);
      frames.push(loopback({
        direction: "client" as const,
        endpoint,
        method,
        url,
        ...(Object.keys(reqHeaders).length ? { headers: reqHeaders } : {}),
      }));
      let form: Record<string, string> | undefined;
      if (method === "POST" && typeof init.body === "string") {
        const params = new URLSearchParams(init.body);
        if (mutant === "wrong-audience" && url === "https://idp.test/token" && params.has("audience")) params.set("audience", "https://wrong.test");
        if (mutant === "wrong-resource") params.set("resource", "https://wrong.test/rpc");
        form = Object.fromEntries(params);
        forms.push(form);
      }
      fetches.push(`${method} ${url}`);
      if (mutant === "redirect-to-authorization-endpoint" && url.includes("/.well-known/oauth-authorization-server/tenant")) {
        fetches.push("GET https://as.test/authorize");
      }
      const reply = async (): Promise<Response> => {
        if (url === "https://mcp.test/.well-known/oauth-protected-resource/rpc" || url === "https://mcp.test/.well-known/oauth-protected-resource") {
          return Response.json({
            resource: (client["prmResource"] as string | undefined) ?? RESOURCE,
            authorization_servers: [AS_ISSUER],
            scopes_supported: ["read"],
          });
        }
        if (url === "https://as.test/.well-known/oauth-authorization-server/tenant" || url === "https://as.test/.well-known/openid-configuration/tenant") {
          return Response.json({
            issuer: (client["asIssuer"] as string | undefined) ?? AS_ISSUER,
            authorization_endpoint: "https://as.test/authorize",
            token_endpoint: "https://as.test/token",
            ...(grantProfiles === null ? {} : { authorization_grant_profiles_supported: grantProfiles ?? ["urn:ietf:params:oauth:grant-profile:id-jag"] }),
          });
        }
        if (url === "https://idp.test/.well-known/oauth-authorization-server/tenant" || url === "https://idp.test/.well-known/openid-configuration/tenant" ||
          url === "https://idp.test/.well-known/openid-configuration" || url === "https://idp.test/.well-known/oauth-authorization-server") {
          return Response.json({ issuer: IDP_ISSUER, token_endpoint: "https://idp.test/token" });
        }
        if (url === "https://idp.test/token" && method === "POST") {
          if (idpError && mutant !== "ignore-insufficient-scope") {
            return Response.json({ error: idpError }, { status: 400 });
          }
          return Response.json({ access_token: ID_JAG, issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", token_type: "Bearer" });
        }
        if (url === "https://as.test/token" && method === "POST") {
          if (asError) return Response.json({ error: asError }, { status: 400 });
          return Response.json({ access_token: ACCESS, token_type: "Bearer", expires_in: 3600 });
        }
        return new Response(null, { status: 404 });
      };
      const res = await reply();
      let message: unknown;
      if (/json/iu.test(res.headers.get("content-type") ?? "")) {
        try { message = await res.clone().json(); } catch { /* not JSON */ }
      }
      frames.push(loopback({
        direction: "server" as const,
        endpoint,
        url,
        headers: { ...Object.fromEntries(res.headers.entries()), status: String(res.status) },
        ...(message !== undefined ? { message } : {}),
      }));
      return res;
    },
  };

  const identityPort: EnterpriseIdentityPort = {
    async getIdentityAssertion(ctx) {
      identityCalls++;
      if (mutant === "browser-assertion") assertionSource = "browser";
      identityContext = { resource: ctx.resource, asIssuer: ctx.asIssuer, idpIssuer: ctx.idpIssuer };
      return { type: (client["assertionType"] as "id_token" | "saml2" | undefined) ?? "id_token", value: ASSERTION };
    },
    healthy: () => true,
  };

  const baseConfig: EnterpriseAuthConfig = {
    resource: (client["resource"] as string | undefined) ?? RESOURCE,
    idpIssuer: mutant === "ssrf-bypass" ? IDP_ISSUER : ((client["idpIssuer"] as string | undefined) ?? IDP_ISSUER),
    ...(mutant === "ssrf-bypass"
      ? { idpTokenEndpoint: "https://idp.test/token" }
      : (client["idpTokenEndpoint"] as string | undefined) !== undefined
        ? { idpTokenEndpoint: client["idpTokenEndpoint"] as string }
        : {}),
    identityPort,
    clientId: "fixture-client",
    clientSecret: "fixture-client-secret",
    scopes: (client["scopes"] as string[] | undefined) ?? ["read"],
    fetch: fetcher,
    clock: { now: () => 0 },
    onDiagnostic: (msg) => {
      diagnostics.push(msg);
      if (mutant === "leak-secrets") diagnostics.push(ASSERTION);
    },
    ...((client["allowInsecureDev"] as boolean | undefined) ? { allowInsecureDev: true } : {}),
  };

  const { identityPort: _port, ...withoutPort } = baseConfig;
  const config: EnterpriseAuthConfig = mutant === "no-identity-port" ? withoutPort : baseConfig;

  // Removal-style fixtures only observe the extension surface, never the provider flow.
  if (client["extensionOnly"] === true) {
    const ext = mutant === "force-capability"
      ? new EnterpriseAuthExtension(baseConfig)
      : new EnterpriseAuthExtension(mutant === "no-identity-port" || client["withIdentityPort"] !== true ? withoutPort : baseConfig);
    const observed = {
      health: ext.health(),
      capabilities: ext.capabilities(true),
      fetches,
    };
    compare("health", observed.health, expect["health"]);
    compare("capabilities", observed.capabilities, expect["capabilities"]);
    compare("fetches", observed.fetches, expect["fetches"]);
    return frames.length === 0 ? { frames: [], zeroWire: true } : { frames, mcpEndpoint: loopback(resource) };
  }

  let header: string | undefined;
  let error: string | undefined;
  try {
    const provider = new EnterpriseManagedAuth(config);
    const result = await provider.headerFor((client["resource"] as string | undefined) ?? RESOURCE);
    header = result?.authorization;
  } catch (caught) {
    error = caught instanceof AuthError ? caught.message : caught instanceof Error ? caught.message : String(caught);
  }

  const idpForm = forms[0];
  const asForm = forms[1];
  const observed: Record<string, unknown> = {
    header: header ?? null,
    error: error ?? null,
    fetches,
    identityCalls,
    identityContext,
    assertionSource,
    diagnostics,
    idpForm: idpForm ?? null,
    asForm: asForm ?? null,
  };

  for (const secret of SECRETS) {
    if (diagnostics.join("\n").includes(secret) || (error ?? "").includes(secret)) {
      mismatch("secret leaked into diagnostics or error");
    }
  }
  if (fetches.some((f) => f.includes("/authorize"))) mismatch("authorization endpoint was contacted");

  for (const [key, wanted] of Object.entries(expect)) {
    if (key === "idpForm" || key === "asForm") {
      subset(key, observed[key], wanted);
    } else {
      compare(key, observed[key], wanted);
    }
  }
  return frames.length === 0 ? { frames: [], zeroWire: true } : { frames, mcpEndpoint: loopback(resource) };
}

function compare(key: string, actual: unknown, wanted: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    mismatch(`${key}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  }
}

function subset(key: string, actual: unknown, wanted: unknown): void {
  const form = record(actual ?? {});
  const want = record(wanted);
  for (const [k, v] of Object.entries(want)) {
    if (form[k] !== v) mismatch(`${key}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(form[k])}`);
  }
}
