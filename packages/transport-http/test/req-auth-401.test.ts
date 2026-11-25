import { describe, expect, it } from "vitest";
import { McpClient, type AuthProvider } from "@mcp/core";
import { HttpTransport } from "../src/index.js";

const url = "https://mcp.example.test/rpc";
const unauthorized = () => new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
const ok = (id: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result: { content: [] } }), {
  status: 200, headers: { "content-type": "application/json" },
});
const retryingProvider = (counter: { prompts: number }): AuthProvider => ({
  contextId: () => "anonymous",
  headerFor: async () => undefined,
  onChallenge: async () => { counter.prompts++; return true; },
});

describe("HTTP 401 auth retry", () => {
  it("[AUTH-401-1] 401 then onChallenge retry re-issues the request with a new JSON-RPC id and succeeds", async () => {
    const counter = { prompts: 0 };
    const ids: unknown[] = [];
    const transport = new HttpTransport({ url, authProvider: retryingProvider(counter),
      fetchFn: async (_, init) => {
        const id = JSON.parse(String(init.body)).id;
        ids.push(id);
        return ids.length === 1 ? unauthorized() : ok(id);
      },
    });
    const result = await new McpClient({ transport, server: { key: url } }).request("tools/call", { name: "write" });
    expect(result.kind).toBe("ok");
    expect(counter.prompts).toBe(1);
    expect(ids).toHaveLength(2);
    expect(ids[1]).not.toEqual(ids[0]);
  });

  it("[AUTH-401-2] a second 401 after the retry yields auth-failure after exactly one auth retry", async () => {
    const counter = { prompts: 0 };
    const ids: unknown[] = [];
    const transport = new HttpTransport({ url, authProvider: retryingProvider(counter),
      fetchFn: async (_, init) => { ids.push(JSON.parse(String(init.body)).id); return unauthorized(); },
    });
    const result = await new McpClient({ transport, server: { key: url } }).request("tools/call", { name: "write" });
    expect(result.kind).toBe("auth-failure");
    expect(counter.prompts).toBe(1);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
