import { expect, it } from "vitest";
import { AuthError, McpClient, type AuthProvider } from "@mcp-client/core";
import { HttpTransport } from "../src/index.js";

const url = "https://mcp.example.test/rpc";
const rejection = (status: number, challenge = "Bearer") => new Response(null, {
  status, headers: { "WWW-Authenticate": challenge },
});
const provider = (onChallenge: AuthProvider["onChallenge"]): AuthProvider => ({
  contextId: () => "anonymous",
  headerFor: async () => undefined,
  ...(onChallenge ? { onChallenge } : {}),
});

it("does not invoke the provider again after a rejected 401 replay", async () => {
  let prompts = 0;
  const ids: unknown[] = [];
  const transport = new HttpTransport({ url, authProvider: provider(async () => { prompts++; return true; }),
    fetchFn: async (_, init) => { ids.push(JSON.parse(String(init.body)).id); return rejection(401); },
  });
  const result = await new McpClient({ transport, server: { key: url } }).request("tools/call", { name: "write" });
  expect(result.kind).toBe("auth-failure");
  expect(prompts).toBe(1);
  expect(ids).toHaveLength(2);
  expect(new Set(ids).size).toBe(2);
});

it("does not step up on an insufficient_scope string in an unrelated challenge parameter", async () => {
  let prompts = 0;
  const transport = new HttpTransport({ url, authProvider: provider(async () => { prompts++; return true; }),
    fetchFn: async () => rejection(403, 'Basic realm="a", Bearer error_description="insufficient_scope"'),
  });
  const result = await new McpClient({ transport, server: { key: url } }).discover();
  expect(result).toMatchObject({ kind: "transport-failure", failure: { kind: "forbidden" } });
  expect(prompts).toBe(0);
});

it("bounds actual Bearer step-up attempts and uses a fresh id each time", async () => {
  let prompts = 0;
  const ids: unknown[] = [];
  const transport = new HttpTransport({ url, authProvider: provider(async () => { prompts++; return true; }),
    fetchFn: async (_, init) => {
      ids.push(JSON.parse(String(init.body)).id);
      return rejection(403, 'Basic realm="other", bEaReR ERROR="insufficient_scope", scope="write"');
    },
  });
  const result = await new McpClient({ transport, server: { key: url } }).request("tools/call", { name: "write" });
  expect(result).toMatchObject({ kind: "auth-failure", detail: { reason: "insufficient-scope" } });
  expect(prompts).toBe(3);
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(4);
});

it("never sends an unauthenticated fallback or exposes provider error text", async () => {
  let sent = 0;
  const secret = "private-access-token";
  const transport = new HttpTransport({ url,
    authProvider: { ...provider(undefined), headerFor: async () => { throw Error(secret); } },
    extraHeaders: { Authorization: "Bearer stale-token" },
    fetchFn: async () => { sent++; return rejection(401); },
  });
  const result = await new McpClient({ transport, server: { key: url } }).discover();
  expect(result.kind).toBe("auth-failure");
  expect(sent).toBe(0);
  expect(JSON.stringify([result, transport.diagnosticsSnapshot()])).not.toContain(secret);
});

it("cancels a rejected write during the auth wait without replay or uncertain execution", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<boolean>();
  let sent = 0;
  const transport = new HttpTransport({ url,
    authProvider: provider(async () => { entered.resolve(); return release.promise; }),
    fetchFn: async () => { sent++; return rejection(401); },
  });
  const client = new McpClient({ transport, server: { key: url } });
  const call = client.request("tools/call", { name: "write" });
  await entered.promise;
  call.cancel();
  expect(await call).toMatchObject({ kind: "cancelled", wasSent: false });
  release.resolve(true);
  expect(sent).toBe(1);
});

it("does not reuse an authorization header across resources on the same origin", async () => {
  const headers: (string | null)[] = [];
  const transport = new HttpTransport({ url,
    authProvider: { ...provider(undefined), headerFor: async resource => resource === url
      ? { authorization: "Bearer rpc-token", contextId: "rpc" } : undefined },
    fetchFn: async (resource, init) => {
      headers.push(new Headers(init.headers).get("Authorization"));
      if (resource === url) return new Response(null, { status: 307, headers: { location: "/other" } });
      return rejection(401);
    },
  });
  await new McpClient({ transport, server: { key: url } }).discover();
  expect(headers).toEqual(["Bearer rpc-token", null]);
});

it("passes host consent to auth and never replays a declined or cancelled write", async () => {
  const bodies: unknown[] = [];
  const decisions = ["decline", "cancel"] as const;
  let prompts = 0;
  const transport = new HttpTransport({ url, authProvider: {
    ...provider(undefined),
    async onChallenge(_, signal, context) {
      if (!context?.consent) throw new AuthError("auth-unavailable", "authorize");
      const decision = await context.consent.request({ kind: "authorize", serverLabel: context.serverLabel!, resource: url }, signal);
      if (decision.decision !== "accept") throw new AuthError("auth-failure", decision.decision === "decline" ? "declined" : "cancelled");
      return true;
    },
  }, fetchFn: async (_, init) => { bodies.push(JSON.parse(String(init.body))); return rejection(401); } });
  const client = new McpClient({ transport, server: { key: url, label: "Example" }, ports: { consent: {
    async request(prompt) {
      expect(prompt).toEqual({ kind: "authorize", serverLabel: "Example", resource: url });
      return { decision: decisions[prompts++]! };
    },
  } } });
  for (const reason of ["declined", "cancelled"]) {
    expect(await client.request("tools/call", { name: "write" })).toMatchObject({ kind: "auth-failure", detail: { reason } });
  }
  expect(bodies).toHaveLength(2);
  expect(prompts).toBe(2);
});

it("does not send a redirect that puts the bearer into the query string", async () => {
  const urls: string[] = [];
  const transport = new HttpTransport({ url,
    authProvider: { ...provider(undefined), headerFor: async () => ({ authorization: "Bearer private-token", contextId: "rpc" }) },
    fetchFn: async resource => {
      urls.push(resource);
      return resource === url ? new Response(null, { status: 307, headers: { location: "/next?access_token=private-token" } }) : rejection(401);
    },
  });
  expect(await new McpClient({ transport, server: { key: url } }).discover()).toMatchObject({ kind: "auth-failure", detail: { reason: "credentials-in-query" } });
  expect(urls).toEqual([url]);
});

it("does not expose a fetch error that includes the outgoing authorization header", async () => {
  const secret = "private-access-token";
  const transport = new HttpTransport({ url,
    authProvider: { ...provider(undefined), headerFor: async () => ({ authorization: `Bearer ${secret}`, contextId: "rpc" }) },
    fetchFn: async (_, init) => { throw new Error(String(new Headers(init.headers).get("Authorization"))); },
  });
  const result = await new McpClient({ transport, server: { key: url } }).discover();
  expect(result).toMatchObject({ kind: "transport-failure", failure: { kind: "connect" } });
  expect(JSON.stringify([result, transport.diagnosticsSnapshot()])).not.toContain(secret);
});
