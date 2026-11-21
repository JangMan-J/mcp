import { createServer } from "node:http";
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientCredentialsAuth } from "@mcp-client/ext-client-credentials";
import { EnterpriseManagedAuth } from "@mcp-client/ext-enterprise-auth";
import { SafeFetch } from "@mcp-client/auth";
import type { LegacyServerConfig } from "./config.js";
import { createLiveAuth, createPiConsent } from "./live-auth.js";

const signal = () => new AbortController().signal;
const server = { name: "demo", source: "global", trusted: true, transport: "http", enabled: true,
  exposure: "direct", url: "https://mcp.example/mcp" } as const satisfies LegacyServerConfig;
afterEach(() => vi.restoreAllMocks());

it("uses configured bearer only for the configured resource and resolves lazily", async () => {
  const resolveProviderToken = vi.fn(async () => "test-token");
  const descriptor = { ...server, auth: { provider: "example" } };
  await expect(createLiveAuth(descriptor, {})).rejects.toThrow("provider-token-resolver");
  const { provider, signIn } = await createLiveAuth(descriptor, { resolveProviderToken });
  expect(signIn).toBeUndefined();
  expect(await provider?.headerFor("https://other.example/mcp")).toBeUndefined();
  expect(resolveProviderToken).not.toHaveBeenCalled();
  expect(await provider?.headerFor(server.url)).toMatchObject({ authorization: "Bearer test-token" });
  expect(resolveProviderToken).toHaveBeenCalledWith("example");
});

it("wires client-secret, private-key and credential-backed enterprise auth without requiring a UI", async () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
  for (const config of [{ clientSecret: "example" }, { privateKeyPem, alg: "ES256" }]) {
    const descriptor = { ...server, clientCredentials: { clientId: "id", ...config } };
    expect((await createLiveAuth(descriptor, {})).provider).toBeInstanceOf(ClientCredentialsAuth);
  }
  const descriptor = { ...server, enterpriseAuth: { idpIssuer: "https://idp.example", identityAssertionKey: "assertion" } };
  await expect(createLiveAuth(descriptor, {})).rejects.toThrow("invalid-enterprise-auth-config");
  const credentials = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
  expect((await createLiveAuth(descriptor, { credentials })).provider).toBeInstanceOf(EnterpriseManagedAuth);
  expect(credentials.set).not.toHaveBeenCalled();
});

it("signs a private_key_jwt assertion through WebCrypto and rejects mismatched key shapes", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" });
  await expect(createLiveAuth({ ...server, clientCredentials: { clientId: "id", privateKeyPem: ec, alg: "RS256" } }, {}))
    .rejects.toThrow("invalid-signing-key");
  await expect(createLiveAuth({ ...server, clientCredentials: { clientId: "id", privateKeyPem: "nope", alg: "ES256" } }, {}))
    .rejects.toThrow("invalid-signing-key");
  let assertion: string | null = null;
  let origin = "";
  const http = createServer(async (req, res) => {
    const json = (obj: object) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
    if (req.url === "/.well-known/oauth-protected-resource/mcp") json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    else if (req.url === "/.well-known/oauth-authorization-server") json({ issuer: origin, token_endpoint: `${origin}/token`,
      token_endpoint_auth_methods_supported: ["private_key_jwt"], token_endpoint_auth_signing_alg_values_supported: ["RS256"] });
    else if (req.url === "/token") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assertion = new URLSearchParams(Buffer.concat(chunks).toString()).get("client_assertion");
      json({ token_type: "Bearer", access_token: "cc-token" });
    } else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  try {
    const { provider } = await createLiveAuth({ ...server, url: `${origin}/mcp`,
      clientCredentials: { clientId: "id", privateKeyPem, alg: "RS256", kid: "k1" } }, {});
    expect(provider).toBeInstanceOf(ClientCredentialsAuth);
    expect(await provider?.headerFor(`${origin}/mcp`)).toMatchObject({ authorization: "Bearer cc-token" });
    const [header, payload, sig] = assertion!.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT", kid: "k1" });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({ iss: "id", sub: "id", aud: origin });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  } finally {
    http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
  }
});

it("signs in against the real resource challenge and callback without authorizing ordinary requests first", async () => {
  const seen: string[] = [];
  let resource: string;
  let issuer: string;
  const http = createServer(async (req, res) => {
    const path = req.url!;
    seen.push(`${req.method} ${path}`);
    const json = (obj: object) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
    if (path === "/mcp") {
      res.writeHead(401, { "WWW-Authenticate": `Bearer resource_metadata="${issuer}/prm", scope="read"` }).end();
    } else if (path === "/prm") {
      json({ resource, authorization_servers: [issuer] });
    } else if (path === "/.well-known/oauth-authorization-server") {
      json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, code_challenge_methods_supported: ["S256"] });
    } else if (path === "/token") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      if (form.get("code") !== "sample-code" || form.get("grant_type") !== "authorization_code" || !form.get("code_verifier")) {
        res.writeHead(400).end(); return;
      }
      json({ token_type: "Bearer", access_token: "oauth-token" });
    } else { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const addr = http.address() as { port: number };
  issuer = `http://127.0.0.1:${addr.port}`;
  resource = `${issuer}/mcp`;
  const request = vi.fn(async () => ({ decision: "accept" as const }));
  const browser = { open: vi.fn(async (url: string, signal: AbortSignal) => {
    const params = new URL(url).searchParams;
    expect(params.get("scope")).toBe("read");
    expect(params.get("code_challenge_method")).toBe("S256");
    const callback = new URL(params.get("redirect_uri")!);
    callback.searchParams.set("state", params.get("state")!);
    callback.searchParams.set("code", "sample-code");
    expect((await fetch(callback, { signal })).ok).toBe(true);
  }) };
  const auth = await createLiveAuth({ ...server, url: resource, oauth: { clientId: "pi" } }, { authorizationConsent: { request }, browser });
  try {
    expect(await auth.provider?.headerFor(resource)).toBeUndefined();
    expect(await auth.provider?.onChallenge?.({ status: 401 }, signal())).toBe(false);
    expect(seen).toEqual([]);
    await auth.signIn?.(signal());
    expect(seen).toEqual(["POST /mcp", "GET /prm", "GET /.well-known/oauth-authorization-server", "POST /token"]);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: "authorize", resource, scopes: ["read"] }), expect.any(AbortSignal));
    expect(await auth.provider?.headerFor(resource)).toMatchObject({ authorization: "Bearer oauth-token" });
  } finally {
    await auth.close?.();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(err => err ? reject(err) : resolve()));
  }
  expect(await auth.provider?.headerFor(resource)).toBeUndefined();
});

it("fails closed without a UI or a genuine bearer challenge", async () => {
  const probe = vi.spyOn(SafeFetch.prototype, "fetch").mockResolvedValue(new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="test"' } }));
  const browser = { open: vi.fn() };
  const { authorizationConsent } = createPiConsent(() => ({ hasUI: false }));
  const headless = await createLiveAuth(server, { authorizationConsent, browser });
  await expect(headless.signIn!(signal())).rejects.toThrow("interactive-sign-in-unavailable");
  expect(probe).not.toHaveBeenCalled();
  const request = vi.fn();
  const live = await createLiveAuth(server, { authorizationConsent: { request }, browser });
  await expect(live.signIn!(signal())).rejects.toThrow("no-bearer-challenge");
  expect(request).not.toHaveBeenCalled();
  expect(browser.open).not.toHaveBeenCalled();
});

describe("Pi consent", () => {
  it("shows the full URL and does not open a declined URL", async () => {
    const confirm = vi.fn(async () => false);
    const { consent } = createPiConsent(() => ({ hasUI: true, ui: { confirm } }));
    const url = "https://example.test/consent?state=abc&scope=files#start";
    expect(await consent.request({ kind: "url-elicitation", serverLabel: "demo", url }, signal())).toEqual({ decision: "decline" });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("demo"), expect.stringContaining(url), expect.anything());
  });

  it("collects typed flat forms through Pi input, confirm and select", async () => {
    const input = vi.fn().mockResolvedValueOnce("Ada").mockResolvedValueOnce("3");
    const confirm = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const select = vi.fn().mockResolvedValueOnce("y");
    const { consent } = createPiConsent(() => ({ hasUI: true, ui: { input, confirm, select } }));
    expect(await consent.request({ kind: "form-elicitation", serverLabel: "demo", schema: { type: "object", properties: {
      name: { type: "string" }, count: { type: "integer" }, agree: { type: "boolean" }, choice: { type: "string", enum: ["x", "y"] },
    } } }, signal())).toEqual({ decision: "accept", content: { name: "Ada", count: 3, agree: false, choice: "y" } });
    expect(select).toHaveBeenCalledWith("choice", ["x", "y"], expect.anything());
  });

  it("shows approval details and cancels an in-flight prompt", async () => {
    const abort = new AbortController();
    let shown!: () => void;
    const entered = new Promise<void>(resolve => { shown = resolve; });
    const confirm = vi.fn(() => { shown(); return new Promise<boolean>(() => {}); });
    const { authorizationConsent } = createPiConsent(() => ({ hasUI: true, ui: { confirm } }));
    const pending = authorizationConsent.request({ kind: "authorize", serverLabel: "demo", issuerHost: "issuer.test", resource: server.url,
      redirectHost: "127.0.0.1", localhostWarning: true, scopes: ["write"] }, abort.signal);
    await entered;
    abort.abort();
    expect(await pending).toEqual({ decision: "cancel" });
    expect(confirm).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("Scopes: write"), { signal: abort.signal });
  });
});
