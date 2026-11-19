import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { AuthError, ExtensionRegistry } from "@mcp-client/core";
import {
  ENTERPRISE_AUTH_EXTENSION_ID,
  EnterpriseAuthExtension,
  EnterpriseManagedAuth,
  createEnterpriseAuthExtension,
  type EnterpriseAuthConfig,
  type EnterpriseIdentityPort,
} from "../src/index.js";

const RESOURCE = "https://mcp.test/rpc";
const AS_ISSUER = "https://as.test/tenant";
const IDP_ISSUER = "https://idp.test/tenant";

interface Harness {
  config: EnterpriseAuthConfig;
  fetches: { method: string; url: string; form?: Record<string, string> }[];
  diagnostics: string[];
  identityCalls: { resource: string; asIssuer: string; idpIssuer: string }[];
  opens: string[];
}

function harness(overrides: Partial<EnterpriseAuthConfig> & { assertionType?: "id_token" | "saml2"; idpError?: string; grantProfiles?: string[] | null } = {}): Harness {
  const fetches: Harness["fetches"] = [];
  const diagnostics: string[] = [];
  const identityCalls: Harness["identityCalls"] = [];
  const opens: string[] = [];
  const { assertionType, idpError, grantProfiles, ...configOverrides } = overrides;
  const identityPort: EnterpriseIdentityPort = {
    async getIdentityAssertion(ctx) {
      identityCalls.push({ resource: ctx.resource, asIssuer: ctx.asIssuer, idpIssuer: ctx.idpIssuer });
      return { type: assertionType ?? "id_token", value: "assertion-secret-value" };
    },
    healthy: () => true,
  };
  const config: EnterpriseAuthConfig = {
    resource: RESOURCE,
    idpIssuer: IDP_ISSUER,
    identityPort,
    clientId: "client-1",
    clientSecret: "secret-1",
    scopes: ["read", "write"],
    clock: { now: () => 0 },
    onDiagnostic: (m) => diagnostics.push(m),
    fetch: {
      async fetch(url, init) {
        const method = init.method ?? "GET";
        const form = method === "POST" ? Object.fromEntries(new URLSearchParams(String(init.body))) : undefined;
        fetches.push({ method, url, ...(form ? { form } : {}) });
        if (url.includes("/.well-known/oauth-protected-resource")) {
          return Response.json({ resource: RESOURCE, authorization_servers: [AS_ISSUER], scopes_supported: ["read"] });
        }
        if (url.startsWith("https://as.test/.well-known/")) {
          return Response.json({
            issuer: AS_ISSUER,
            authorization_endpoint: "https://as.test/authorize",
            token_endpoint: "https://as.test/token",
            ...(grantProfiles === null ? {} : { authorization_grant_profiles_supported: grantProfiles ?? ["urn:ietf:params:oauth:grant-profile:id-jag"] }),
          });
        }
        if (url.startsWith("https://idp.test/.well-known/")) {
          return Response.json({ issuer: IDP_ISSUER, token_endpoint: "https://idp.test/token" });
        }
        if (url === "https://idp.test/token") {
          if (idpError) return Response.json({ error: idpError }, { status: 400 });
          return Response.json({ access_token: "id-jag-secret", issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", token_type: "Bearer" });
        }
        if (url === "https://as.test/token") {
          return Response.json({ access_token: "access-1", token_type: "Bearer", expires_in: 3600 });
        }
        return new Response(null, { status: 404 });
      },
    },
    ...configOverrides,
  };
  return { config, fetches, diagnostics, identityCalls, opens };
}

it("performs exact RFC 8693 exchange then RFC 7523 redemption, with no authorization-endpoint contact", async () => {
  const h = harness();
  const auth = new EnterpriseManagedAuth(h.config);
  const header = await auth.headerFor(RESOURCE);
  expect(header?.authorization).toBe("Bearer access-1");
  const posts = h.fetches.filter((f) => f.method === "POST");
  expect(posts[0]?.url).toBe("https://idp.test/token");
  expect(posts[0]?.form).toEqual({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
    subject_token: "assertion-secret-value",
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    audience: AS_ISSUER,
    resource: RESOURCE,
    scope: "read write",
    client_id: "client-1",
    client_secret: "secret-1",
  });
  expect(posts[1]?.url).toBe("https://as.test/token");
  expect(posts[1]?.form).toEqual({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: "id-jag-secret",
    resource: RESOURCE,
    client_id: "client-1",
    client_secret: "secret-1",
  });
  expect(h.fetches.some((f) => f.url.includes("/authorize"))).toBe(false);
  expect(h.opens).toEqual([]);
  expect(h.identityCalls).toEqual([{ resource: RESOURCE, asIssuer: AS_ISSUER, idpIssuer: IDP_ISSUER }]);
  // Secrets never in diagnostics.
  expect(h.diagnostics.join(" ")).not.toContain("assertion-secret-value");
  expect(h.diagnostics.join(" ")).not.toContain("id-jag-secret");
  expect(h.diagnostics.join(" ")).not.toContain("access-1");
});

it("handles SAML2 assertions and CIMD client_id on redemption", async () => {
  const h = harness({ assertionType: "saml2" });
  const { clientId: _c, clientSecret: _s, ...rest } = h.config;
  const auth = new EnterpriseManagedAuth({ ...rest, cimdClientId: "https://client.test/metadata.json" });
  // Need the harness fetch from rest; it is included.
  expect((await auth.headerFor(RESOURCE))?.authorization).toBe("Bearer access-1");
  const posts = h.fetches.filter((f) => f.method === "POST");
  expect(posts[0]?.form?.["subject_token_type"]).toBe("urn:ietf:params:oauth:token-type:saml2");
  expect(posts[0]?.form?.["client_id"]).toBeUndefined();
  expect(posts[1]?.form?.["client_id"]).toBe("https://client.test/metadata.json");
  expect(posts[1]?.form?.["client_secret"]).toBeUndefined();
});

it("insufficient_scope from IdP fails cleanly without loop", async () => {
  const h = harness({ idpError: "insufficient_scope" });
  const auth = new EnterpriseManagedAuth(h.config);
  await expect(auth.headerFor(RESOURCE)).rejects.toEqual(new AuthError("auth-failure", "insufficient-scope"));
  expect(h.fetches.filter((f) => f.method === "POST")).toHaveLength(1);
  await expect(auth.onChallenge({ status: 403, resource: RESOURCE, wwwAuthenticate: 'Bearer error="insufficient_scope"' }, new AbortController().signal))
    .rejects.toEqual(new AuthError("auth-failure", "insufficient-scope"));
});

it("checks authorization_grant_profiles_supported when present and proceeds when absent", async () => {
  const bad = harness({ grantProfiles: ["urn:example:other"] });
  await expect(new EnterpriseManagedAuth(bad.config).headerFor(RESOURCE)).rejects.toMatchObject({ reason: "id-jag-unsupported" });
  const absent = harness({ grantProfiles: null });
  expect((await new EnterpriseManagedAuth(absent.config).headerFor(RESOURCE))?.authorization).toBe("Bearer access-1");
});

it("single-flight re-exchange on 401 and expiry; no token-issuing endpoint on client", async () => {
  let now = 0;
  const h = harness();
  const auth = new EnterpriseManagedAuth({ ...h.config, clock: { now: () => now } });
  const [a, b] = await Promise.all([auth.headerFor(RESOURCE), auth.headerFor(RESOURCE)]);
  expect(a?.authorization).toBe("Bearer access-1");
  expect(b?.authorization).toBe("Bearer access-1");
  expect(h.fetches.filter((f) => f.url === "https://idp.test/token" && f.method === "POST")).toHaveLength(1);
  now = 3_700_000;
  await auth.headerFor(RESOURCE);
  expect(h.fetches.filter((f) => f.url === "https://idp.test/token" && f.method === "POST")).toHaveLength(2);
  expect(await auth.onChallenge({ status: 401, resource: RESOURCE }, new AbortController().signal)).toBe(true);
  expect(h.fetches.filter((f) => f.url === "https://idp.test/token" && f.method === "POST")).toHaveLength(3);
  // Client surface has no token endpoint handler.
  expect(Object.getOwnPropertyNames(EnterpriseManagedAuth.prototype)).not.toContain("tokenEndpoint");
});

it("blocks SSRF IdP endpoints before any fetch", async () => {
  const h = harness();
  let fetched = 0;
  expect(() => new EnterpriseManagedAuth({
    ...h.config,
    idpIssuer: "https://169.254.169.254/latest",
    fetch: { async fetch() { fetched++; return new Response(null, { status: 500 }); } },
  })).toThrowError(new AuthError("auth-failure", "ssrf-blocked"));
  expect(fetched).toBe(0);
  expect(() => new EnterpriseManagedAuth({ ...h.config, idpIssuer: "http://idp.test/tenant" })).toThrowError(/invalid-url/);
});

it("capability gating with and without IdentityPort (EXT-ema-1, EXT-CAP-1)", () => {
  const withPort = createEnterpriseAuthExtension(harness().config);
  expect(withPort.id).toBe(ENTERPRISE_AUTH_EXTENSION_ID);
  expect(withPort.stage).toBe("stable");
  expect(withPort.defaultEnabled).toBe(false);
  expect(withPort.health()).toBe("working");
  expect(withPort.settings()).toEqual({});
  expect(withPort.capabilities(true)).toEqual({ extensions: { [ENTERPRISE_AUTH_EXTENSION_ID]: {} } });
  expect(withPort.capabilities(false)).toEqual({});
  expect(withPort.createAuthProvider()).toBeInstanceOf(EnterpriseManagedAuth);

  const without = createEnterpriseAuthExtension({ resource: RESOURCE, idpIssuer: IDP_ISSUER });
  expect(without.health()).toBe("unavailable");
  expect(without.settings()).toBeUndefined();
  expect(without.capabilities(true)).toEqual({});

  const unhealthy = createEnterpriseAuthExtension({
    ...harness().config,
    identityPort: { async getIdentityAssertion() { return { type: "id_token", value: "x" }; }, healthy: () => false },
  });
  expect(unhealthy.health()).toBe("unavailable");
  expect(unhealthy.capabilities(true)).toEqual({});

  const invalid = createEnterpriseAuthExtension({ ...harness().config, idpIssuer: "http://idp.test/tenant" });
  expect(invalid.health()).toBe("unavailable");
});

it("EXT-REG-1: import has no side effects; registry stays empty until use()", () => {
  const registry = new ExtensionRegistry();
  expect(registry.capabilities()).toEqual({});
  const ext = new EnterpriseAuthExtension(harness().config);
  // Merely constructing does not register.
  expect(registry.capabilities()).toEqual({});
  const dispose = registry.register(ext);
  // Registry calls capabilities(true); working extension advertises.
  expect(registry.capabilities()).toEqual({ extensions: { [ENTERPRISE_AUTH_EXTENSION_ID]: {} } });
  dispose.dispose();
  expect(registry.capabilities()).toEqual({});
});

it("PIN.md records the ext-auth pin", () => {
  const pin = readFileSync(new URL("../PIN.md", import.meta.url), "utf8");
  expect(pin).toContain("15ca394e00a66434520b9ade26294999295a43ae");
  expect(pin).toContain("2026-10-23");
  expect(pin).toContain("specification/stable/enterprise-managed-authorization/2026-07-28/enterprise-managed-authorization.mdx");
  expect(pin).toContain("stable");
  expect(pin).toContain("5f5440bb26a62e2cf3440b92da5a667efa03b267");
  expect(pin).toContain("RFC 8693");
  expect(pin).toContain("RFC 7523");
  expect(pin).toContain("ID-JAG");
  const ext = createEnterpriseAuthExtension();
  expect(ext.pin.commit).toBe("15ca394e00a66434520b9ade26294999295a43ae");
});
