import { isDeepStrictEqual } from "node:util";
import { AuthError } from "@mcp-client/auth";
import { ExtensionRegistry } from "@mcp-client/core";
import type { AuthChallenge, AuthHeaderResult, AuthProvider, Extension, ExtensionCapabilities, ExtensionHost, FetchPort } from "@mcp-client/core";
import { ClientCredentialsAuth } from "./auth.js";
import type { ClientCredentialsConfig } from "./config.js";
import { ClientCredentialsExtension, CLIENT_CREDENTIALS_EXTENSION_ID } from "./extension.js";
import { createWebCryptoAssertionSigner } from "./signer.js";

/** Thrown only when an observation differs from the fixture's expectation. */
export class ObservationMismatch extends Error {
  readonly isObservationMismatch = true as const;
  constructor(message: string) {
    super(message);
    this.name = "ObservationMismatch";
  }
}

const MUTANTS = new Set([
  "aud-token-endpoint", "drop-exp", "iss-not-client-id", "no-single-flight", "ignore-expiry", "ignore-pin",
  "log-secret", "log-token", "register-first", "step-up-retry", "reacquire-on-403",
  "ignore-health", "ignore-is-working", "registers-result-type",
]);
export const supportsMutant = (name: string): boolean => MUTANTS.has(name);

type Json = Record<string, unknown>;
const RESOURCE = "https://mcp.test/rpc";
const ISSUER = "https://as.test/tenant";
const OTHER = "https://evil.test";
const CLIENT_ID = "client-1";
const SECRET = "s3cret-value-XYZ";
const T0 = 1_700_000_000_000;

const bad = (msg: string): never => { throw new Error(`malformed fixture: ${msg}`); };
const mismatch = (msg: string): never => { throw new ObservationMismatch(msg); };
const eq = (actual: unknown, expected: unknown, label: string) => {
  if (!isDeepStrictEqual(actual, expected)) mismatch(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const rec = (v: unknown, what: string): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : bad(what));
const str = (v: unknown, what: string): string => (typeof v === "string" ? v : bad(what));

interface Logged { method: string; url: string; headers: Record<string, string>; form?: URLSearchParams }

function decode(jwt: string): { header: Json; payload: Json } {
  const [h, p] = jwt.split(".");
  const parse = (s: string | undefined) => JSON.parse(Buffer.from(s ?? "", "base64url").toString("utf8")) as Json;
  return { header: parse(h), payload: parse(p) };
}

interface World {
  requests: Logged[];
  diagnostics: string[];
  tokens: string[];
  now: number;
  frozen: boolean;
  prm: Json;
  metadata: Json;
  fetchPort: FetchPort;
}

function makeWorld(client: Json, mutant: string | undefined): World {
  const issuer = str(client["issuer"] ?? ISSUER, "issuer");
  const world: World = {
    requests: [], diagnostics: [], tokens: [], now: T0, frozen: false,
    prm: rec(client["prm"] ?? { resource: RESOURCE, authorization_servers: [issuer] }, "prm"),
    metadata: rec(client["metadata"] ?? {}, "metadata"),
    fetchPort: undefined as never,
  };
  const expiresIn = typeof client["expiresIn"] === "number" ? client["expiresIn"] : 3600;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const asDoc = (iss: string): Json => ({ issuer: iss, token_endpoint: `${iss === ISSUER ? "https://as.test" : iss}/token`,
    registration_endpoint: `${iss === ISSUER ? "https://as.test" : iss}/register`, ...world.metadata });
  const real: FetchPort = {
    async fetch(url, init) {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const entry: Logged = { method: init.method ?? "GET", url, headers };
      if (entry.method === "POST" && typeof init.body === "string") entry.form = new URLSearchParams(init.body);
      world.requests.push(entry);
      if (entry.method === "GET") {
        if (url === "https://mcp.test/.well-known/oauth-protected-resource/rpc") return json(world.prm);
        if (url === "https://as.test/.well-known/oauth-authorization-server/tenant") return json(asDoc(ISSUER));
        if (url === `${OTHER}/.well-known/oauth-authorization-server`) return json(asDoc(OTHER));
        return new Response(null, { status: 404 });
      }
      if (url === "https://as.test/token" || url === `${OTHER}/token`) {
        const token = `tok-${world.tokens.length + 1}`;
        world.tokens.push(token);
        return json({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
      }
      if (url.endsWith("/register")) return json({ client_id: "dyn" }, 201);
      return new Response(null, { status: 404 });
    },
  };
  world.fetchPort = {
    async fetch(url, init) {
      if (url.endsWith("/token") && typeof init.body === "string") {
        const form = new URLSearchParams(init.body);
        const assertion = form.get("client_assertion");
        if (assertion && (mutant === "aud-token-endpoint" || mutant === "drop-exp" || mutant === "iss-not-client-id")) {
          const { header, payload } = decode(assertion);
          if (mutant === "aud-token-endpoint") payload["aud"] = url;
          if (mutant === "drop-exp") delete payload["exp"];
          if (mutant === "iss-not-client-id") payload["iss"] = "someone-else";
          const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
          form.set("client_assertion", `${enc(header)}.${enc(payload)}.${assertion.split(".")[2]}`);
          init = { ...init, body: form.toString() };
        }
        if (mutant === "log-secret") world.diagnostics.push(`token request ${init.body as string}`);
        const res = await real.fetch(url, init);
        if (mutant === "log-token") world.diagnostics.push(`token response ${await res.clone().text()}`);
        return res;
      }
      return real.fetch(url, init);
    },
  };
  return world;
}

async function configFor(client: Json, world: World, mutant: string | undefined): Promise<ClientCredentialsConfig> {
  const mode = str(client["mode"] ?? "jwt-es256", "mode");
  const base: ClientCredentialsConfig = {
    resource: RESOURCE, clientId: CLIENT_ID, fetch: world.fetchPort,
    clock: { now: () => (world.frozen ? T0 : world.now) },
    random: { bytes: (n) => new Uint8Array(n).fill(7) },
    onDiagnostic: (e) => world.diagnostics.push(`${e.event} ${e.detail ?? ""}`),
    ...(mutant === "ignore-expiry" ? { clock: { now: () => T0 } } : {}),
    ...(client["expectedIssuer"] !== undefined && mutant !== "ignore-pin" ? { expectedIssuer: str(client["expectedIssuer"], "expectedIssuer") } : {}),
    ...(Array.isArray(client["scopes"]) ? { scopes: client["scopes"] as string[] } : {}),
  };
  if (mode === "secret") return { ...base, secret: SECRET };
  if (mode !== "jwt-es256" && mode !== "jwt-rs256") bad(`mode ${mode}`);
  const pair = mode === "jwt-es256"
    ? await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"])
    : await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["sign"]);
  return { ...base, signer: createWebCryptoAssertionSigner(mode === "jwt-es256" ? "ES256" : "RS256", pair.privateKey, "k1") };
}

function mutate(auth: ClientCredentialsAuth, config: ClientCredentialsConfig, world: World, mutant: string | undefined): AuthProvider {
  if (mutant === "no-single-flight") {
    return { contextId: () => auth.contextId(), headerFor: (url, op, ctx) => new ClientCredentialsAuth(config).headerFor(url, op, ctx) };
  }
  if (mutant === "register-first") {
    return {
      contextId: () => auth.contextId(),
      async headerFor(url, op, ctx) {
        await world.fetchPort.fetch("https://as.test/register", { method: "POST", body: "{}" });
        return auth.headerFor(url, op, ctx);
      },
      onChallenge: (c, s, ctx) => auth.onChallenge(c, s, ctx),
    };
  }
  if (mutant === "step-up-retry") {
    return {
      contextId: () => auth.contextId(), headerFor: (u, o, c) => auth.headerFor(u, o, c),
      async onChallenge(c, s, ctx) { try { return await auth.onChallenge(c, s, ctx); } catch { await auth.headerFor(RESOURCE); return true; } },
    };
  }
  if (mutant === "reacquire-on-403") {
    return {
      contextId: () => auth.contextId(), headerFor: (u, o, c) => auth.headerFor(u, o, c),
      onChallenge: (c, s, ctx) => auth.onChallenge({ status: 401, ...(c.credentialVersion !== undefined ? { credentialVersion: c.credentialVersion } : {}) }, s, ctx),
    };
  }
  return auth;
}

function describeError(error: unknown): string {
  return error instanceof AuthError ? `${error.kind}/${error.reason}` : `unexpected/${error instanceof Error ? error.name : "unknown"}`;
}

function form(world: World, index: unknown): URLSearchParams {
  const tokens = world.requests.filter((r) => r.method === "POST" && r.form && r.url.endsWith("/token"));
  const i = typeof index === "number" ? (index < 0 ? tokens.length + index : index) : tokens.length - 1;
  const hit = tokens[i];
  if (!hit?.form) return mismatch(`no token request at index ${String(index ?? "last")}`);
  return hit.form;
}

async function runClient(fixture: Json, mutant: string | undefined): Promise<void> {
  const client = rec(fixture["client"] ?? {}, "client");
  const world = makeWorld(client, mutant);
  const config = await configFor(client, world, mutant);
  const auth = new ClientCredentialsAuth(config);
  const provider = mutate(auth, config, world, mutant);
  let last: Json = {};
  let version: object | null | undefined;
  const header = async () => {
    const r: AuthHeaderResult | undefined = await provider.headerFor(RESOURCE, undefined, { signal: new AbortController().signal });
    version = r?.credentialVersion;
    return r?.authorization ?? null;
  };
  const errors: string[] = [];
  const guard = async (work: () => Promise<Json>) => {
    try { last = await work(); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); last = { error: describeError(error) }; }
  };
  const steps = Array.isArray(fixture["script"]) ? (fixture["script"] as unknown[]) : bad("script");
  for (const raw of steps) {
    const step = rec(raw, "step");
    if (step["do"] === "header") await guard(async () => ({ authorization: await header() }));
    else if (step["do"] === "parallel") {
      await guard(async () => ({ authorizations: await Promise.all(Array.from({ length: Number(step["count"] ?? 2) }, header)) }));
    } else if (step["do"] === "challenge") {
      const challenge: AuthChallenge = {
        status: step["status"] === 403 ? 403 : 401,
        ...(typeof step["challenge"] === "string" ? { wwwAuthenticate: step["challenge"] } : {}),
        ...(version !== undefined ? { credentialVersion: version } : {}),
      };
      await guard(async () => ({ retry: (await provider.onChallenge?.(challenge, new AbortController().signal)) ?? false }));
    } else if (step["do"] === "advance") world.now += Number(step["ms"]);
    else if (step["do"] === "set-prm") world.prm = { ...world.prm, authorization_servers: step["authorization_servers"] };
    else if (step["expect"] === "outcome") eq(last, rec(step["value"], "value"), "outcome");
    else if (step["expect"] === "token-requests") {
      eq(world.requests.filter((r) => r.method === "POST" && r.url.endsWith("/token")).length, step["count"], "token request count");
    } else if (step["expect"] === "fetches") {
      eq(world.requests.map((r) => `${r.method} ${r.url}`), step["values"], "fetches");
    } else if (step["expect"] === "no-requests-to") {
      const host = str(step["host"], "host");
      eq(world.requests.filter((r) => new URL(r.url).host === host).map((r) => `${r.method} ${r.url}`), [], `requests to ${host}`);
    } else if (step["expect"] === "no-registration") {
      eq(world.requests.filter((r) => /register/u.test(r.url)).map((r) => `${r.method} ${r.url}`), [], "registration requests");
    } else if (step["expect"] === "form") {
      const f = form(world, step["index"]);
      for (const [k, v] of Object.entries(rec(step["match"] ?? {}, "match"))) {
        if (v === "*") { if (!f.has(k)) mismatch(`form field ${k} missing`); } else eq(f.get(k), v, `form ${k}`);
      }
      for (const k of (step["absent"] as string[] | undefined) ?? []) if (f.has(k)) mismatch(`form field ${k} must be absent`);
    } else if (step["expect"] === "basic-auth") {
      const hit = world.requests.filter((r) => r.url.endsWith("/token")).at(-1);
      eq(hit?.headers["authorization"], `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString("base64")}`, "basic authorization");
    } else if (step["expect"] === "jwt") {
      const assertion = form(world, step["index"]).get("client_assertion") ?? mismatch("client_assertion missing");
      const { header: h, payload } = decode(assertion);
      for (const [k, v] of Object.entries(rec(step["claims"] ?? {}, "claims"))) eq(payload[k], v, `claim ${k}`);
      for (const k of (step["present"] as string[] | undefined) ?? []) if (payload[k] === undefined) mismatch(`claim ${k} missing`);
      if (typeof payload["iat"] !== "number" || typeof payload["exp"] !== "number" || payload["exp"] <= payload["iat"]) mismatch("exp must follow iat");
      for (const [k, v] of Object.entries(rec(step["header"] ?? {}, "header"))) eq(h[k], v, `jwt header ${k}`);
    } else if (step["expect"] === "no-leak") {
      const secrets = [SECRET, ...world.tokens, ...world.requests.map((r) => r.form?.get("client_assertion")).filter((v): v is string => !!v)];
      const seen = [...world.diagnostics, ...errors, JSON.stringify(last)];
      for (const text of seen) for (const s of secrets) if (text.includes(s)) mismatch("secret material appeared in diagnostics or errors");
    } else bad(`unknown step ${JSON.stringify(step)}`);
  }
}

function wrap(ext: ClientCredentialsExtension, mutant: string | undefined): Extension {
  if (mutant === "ignore-health") return Object.assign(Object.create(ext) as Extension, { capabilities: (w: boolean): ExtensionCapabilities => (w ? { extensions: { [CLIENT_CREDENTIALS_EXTENSION_ID]: {} } } : {}) });
  if (mutant === "ignore-is-working") return Object.assign(Object.create(ext) as Extension, { capabilities: (): ExtensionCapabilities => (ext.health() === "working" ? { extensions: { [CLIENT_CREDENTIALS_EXTENSION_ID]: {} } } : {}) });
  if (mutant === "registers-result-type") {
    return { id: ext.id, capabilities: (w) => ext.capabilities(w), attach(host: ExtensionHost) { host.registerResultType("cc-extra", () => { throw new Error("unused"); }); return { dispose() {} }; } };
  }
  return ext;
}

function runExtension(fixture: Json, mutant: string | undefined): void {
  const configured: ClientCredentialsConfig = { resource: RESOURCE, clientId: CLIENT_ID, secret: SECRET };
  const steps = Array.isArray(fixture["script"]) ? (fixture["script"] as unknown[]) : bad("script");
  for (const raw of steps) {
    const step = rec(raw, "step");
    if (step["expect"] === "capabilities") {
      const ext = new ClientCredentialsExtension(step["config"] === "configured" ? configured : {});
      eq(wrap(ext, mutant).capabilities(step["isWorking"] === true), step["value"], `capabilities(${String(step["config"])}, ${String(step["isWorking"])})`);
      eq(ext.health(), step["config"] === "configured" ? "working" : "unavailable", "health");
    } else if (step["expect"] === "removal") {
      const registry = new ExtensionRegistry();
      const before = JSON.stringify(registry.capabilities());
      const ext = new ClientCredentialsExtension(configured);
      const handle = registry.register(wrap(ext, mutant));
      eq(registry.capabilities(), { extensions: { [CLIENT_CREDENTIALS_EXTENSION_ID]: {} } }, "capabilities while registered");
      eq(registry.resolveResultType("cc-extra"), undefined, "extension registers no result types");
      handle.dispose();
      eq(JSON.stringify(registry.capabilities()), before, "capabilities after removal");
      eq(registry.resolveResultType("cc-extra"), undefined, "result types after removal");
      eq(registry.resolveResultType("complete"), undefined, "core result types untouched");
    } else bad(`unknown step ${JSON.stringify(step)}`);
  }
}

export async function runExchange(fixture: unknown, mutant?: string): Promise<void> {
  const fx = rec(fixture, "fixture");
  if (mutant !== undefined && !supportsMutant(mutant)) throw new Error(`unknown client-credentials mutant '${mutant}'`);
  if (fx["tier"] !== "A" || fx["binding"] !== "http" || !Array.isArray(fx["script"])) bad("tier A http fixture with script required");
  if (typeof fx["client"] === "object" && (fx["client"] as Json)["kind"] === "extension") runExtension(fx, mutant);
  else await runClient(fx, mutant);
}
