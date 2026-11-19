import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuthError, MemoryCredentialStore } from "@mcp-client/auth";
import type { FetchPort } from "@mcp-client/core";
import { ClientCredentialsAuth, ClientCredentialsExtension, createClientCredentialsExtension, createWebCryptoAssertionSigner } from "../src/index.js";
import { ObservationMismatch, runExchange, supportsMutant } from "../src/conformance.js";

const dir = new URL("../../fixtures/exchanges/ext/cc/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".exchange.json"));
const fixtures = files.map((f) => JSON.parse(readFileSync(new URL(f, dir), "utf8")) as { id: string; requirements: string[]; mutants: string[] });
const reqs = JSON.parse(readFileSync(new URL("../../conformance/requirements.json", import.meta.url), "utf8")) as { rows: { id: string; disposition: string }[] };
const RES = "https://mcp.test/rpc";
const ISS = "https://as.test/tenant";

describe("fixtures", () => {
  it("covers the eight slices", () => {
    expect(fixtures.map((f) => f.id).sort()).toEqual(["jwt-claims-core", "expiry-single-flight", "issuer-pinned", "secret-not-logged", "no-dcr", "step-up-cc-abort", "omit-when-unavailable", "removal-core-unchanged"].map((n) => `ext/cc/${n}`).sort());
  });
  it.each(fixtures.map((f) => [f.id, f] as const))("%s passes baseline and every mutant fails with ObservationMismatch", async (_id, fx) => {
    await runExchange(fx);
    expect(fx.mutants.length).toBeGreaterThan(0);
    for (const m of fx.mutants) {
      expect(supportsMutant(m)).toBe(true);
      await expect(runExchange(fx, m), m).rejects.toBeInstanceOf(ObservationMismatch);
    }
  });
  it("requirement ids resolve and none is unresolved", () => {
    const byId = new Map(reqs.rows.map((r) => [r.id, r.disposition]));
    for (const fx of fixtures) for (const id of fx.requirements) {
      expect(byId.has(id), id).toBe(true);
      expect(byId.get(id)).not.toMatch(/^unresolved/);
    }
  });
  it("unknown mutants and malformed fixtures are plain errors", async () => {
    await expect(runExchange(JSON.parse(readFileSync(new URL(files[0]!, dir), "utf8")), "nope")).rejects.not.toBeInstanceOf(ObservationMismatch);
    await expect(runExchange({ tier: "A", binding: "http", script: [{ bogus: 1 }] })).rejects.not.toBeInstanceOf(ObservationMismatch);
  });
});

describe("signing", () => {
  const decode = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString());
  it("ES256 and RS256 WebCrypto assertions verify", async () => {
    const es = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const rs = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, false, ["sign", "verify"]);
    for (const [alg, pair, params] of [["ES256", es, { name: "ECDSA", hash: "SHA-256" }], ["RS256", rs, { name: "RSASSA-PKCS1-v1_5" }]] as const) {
      const signer = createWebCryptoAssertionSigner(alg, pair.privateKey, "kid-1");
      let assertion = "";
      const fetch = fakeFetch((form) => { assertion = form.get("client_assertion") ?? ""; });
      await new ClientCredentialsAuth({ resource: RES, clientId: "c", signer, fetch }).headerFor(RES);
      const [h, p, s] = assertion.split(".") as [string, string, string];
      expect(decode(h)).toEqual({ alg, typ: "JWT", kid: "kid-1" });
      expect(decode(p).aud).toBe(ISS);
      expect(await crypto.subtle.verify(params, pair.publicKey, Buffer.from(s, "base64url"), new TextEncoder().encode(`${h}.${p}`))).toBe(true);
    }
  });
  it("rejects a public key", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    expect(() => createWebCryptoAssertionSigner("ES256", pair.publicKey)).toThrow();
  });
});

function fakeFetch(onToken: (form: URLSearchParams, headers: Headers) => void, meta: Record<string, unknown> = {}, log: string[] = []): FetchPort {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  return {
    async fetch(url, init) {
      log.push(`${init.method} ${url}`);
      if (url.includes("oauth-protected-resource")) return json({ resource: RES, authorization_servers: [ISS] });
      if (url.includes("oauth-authorization-server")) return json({ issuer: ISS, token_endpoint: "https://as.test/token", ...meta });
      if (url === "https://as.test/token") { onToken(new URLSearchParams(String(init.body)), new Headers(init.headers)); return json({ access_token: "t", token_type: "Bearer", expires_in: 100 }); }
      return new Response(null, { status: 404 });
    },
  };
}

describe("grants", () => {
  it("client_secret_post form with resource and scope, secret from the store", async () => {
    const credentials = new MemoryCredentialStore();
    await credentials.set("k", "pw");
    let form = new URLSearchParams();
    const fetch = fakeFetch((f) => { form = f; }, { token_endpoint_auth_methods_supported: ["client_secret_post"] });
    await new ClientCredentialsAuth({ resource: RES, clientId: "c", credentialKey: "k", credentials, scopes: ["a", "b"], fetch }).headerFor(RES);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "client_credentials", resource: RES, scope: "a b", client_id: "c", client_secret: "pw" });
  });
  it("client_secret_basic is the default", async () => {
    let auth: string | null = null; let form = new URLSearchParams();
    const fetch = fakeFetch((f, h) => { form = f; auth = h.get("authorization"); });
    await new ClientCredentialsAuth({ resource: RES, clientId: "c", secret: "pw", fetch }).headerFor(RES);
    expect(auth).toBe(`Basic ${Buffer.from("c:pw").toString("base64")}`);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "client_credentials", resource: RES });
  });
  it("refuses an AS that lists neither JWT nor secret methods it can use", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const signer = createWebCryptoAssertionSigner("ES256", pair.privateKey);
    const fetch = fakeFetch(() => {}, { token_endpoint_auth_methods_supported: ["client_secret_basic"] });
    await expect(new ClientCredentialsAuth({ resource: RES, clientId: "c", signer, fetch }).headerFor(RES)).rejects.toMatchObject({ reason: "auth-method-unsupported" });
    const fetch2 = fakeFetch(() => {}, { token_endpoint_auth_methods_supported: ["private_key_jwt"], token_endpoint_auth_signing_alg_values_supported: ["RS256"] });
    await expect(new ClientCredentialsAuth({ resource: RES, clientId: "c", signer, fetch: fetch2 }).headerFor(RES)).rejects.toMatchObject({ reason: "signing-alg-unsupported" });
  });
  it("mid-flow AS change is an auth-failure", async () => {
    let now = 0; let adv = [ISS];
    const base = fakeFetch(() => {});
    const fetch: FetchPort = { fetch: async (u, i) => u.includes("oauth-protected-resource") ? new Response(JSON.stringify({ resource: RES, authorization_servers: adv })) : base.fetch(u, i) };
    const auth = new ClientCredentialsAuth({ resource: RES, clientId: "c", secret: "pw", fetch, clock: { now: () => now } });
    await auth.headerFor(RES);
    adv = ["https://other.test"]; now = 1e7;
    await expect(auth.headerFor(RES)).rejects.toEqual(new AuthError("auth-failure", "issuer-mismatch"));
  });
  it("is not sent to other resources", async () => {
    const auth = new ClientCredentialsAuth({ resource: RES, clientId: "c", secret: "pw", fetch: fakeFetch(() => {}) });
    expect(await auth.headerFor("https://other.test/rpc")).toBeUndefined();
  });
});

describe("extension", () => {
  it("metadata and health", () => {
    const ext = createClientCredentialsExtension({ resource: RES, clientId: "c", secret: "pw" });
    expect([ext.id, ext.stage, ext.defaultEnabled]).toEqual(["io.modelcontextprotocol/oauth-client-credentials", "stable", false]);
    expect(ext.health()).toBe("working");
    expect(ext.settings()).toEqual({});
    expect(ext.capabilities(true)).toEqual({ extensions: { [ext.id]: {} } });
    expect(ext.capabilities(false)).toEqual({});
    const none = new ClientCredentialsExtension();
    expect([none.health(), none.settings(), none.capabilities(true)]).toEqual(["unavailable", undefined, {}]);
    expect(new ClientCredentialsExtension({ resource: RES, clientId: "c", credentialKey: "k" }).health()).toBe("unavailable");
  });
  it("importing has no side effects (EXT-REG-1)", async () => {
    const before = Object.keys(globalThis).sort();
    const mod = await import("../src/index.js");
    expect(Object.keys(globalThis).sort()).toEqual(before);
    expect(typeof mod.createClientCredentialsExtension).toBe("function");
  });
  it("does not import transports", () => {
    for (const f of readdirSync(new URL("../src/", import.meta.url))) {
      expect(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")).not.toMatch(/transport-(http|stdio)/u);
    }
  });
  it("has PIN.md recording the upstream commit (EXT-PIN-1)", () => {
    const url = new URL("../PIN.md", import.meta.url);
    expect(existsSync(url)).toBe(true);
    expect(readFileSync(url, "utf8")).toContain("15ca394e00a66434520b9ade26294999295a43ae");
  });
});
