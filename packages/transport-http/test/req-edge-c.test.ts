import { expect, it, vi } from "vitest";
import { McpClient, type FetchPort } from "@mcp-client/core";
import { HttpTransport } from "../src/index.js";

const url = "https://service.test/mcp";

it("[EDGE-29] handles a discover 401 through the auth challenge and retries discovery", async () => {
  const challenge = 'Bearer resource_metadata="https://service.test/metadata"';
  let token = "initial";
  const onChallenge = vi.fn(async (_challenge: unknown) => {
    token = "renewed";
    return true;
  });
  const calls: Array<{ method: string; authorization: string | null }> = [];
  const fetchPort: FetchPort = {
    async fetch(_input, init) {
      const req = JSON.parse(String(init.body));
      calls.push({ method: req.method, authorization: new Headers(init.headers).get("authorization") });
      if (calls.length === 1) return new Response(null, { status: 401, headers: { "www-authenticate": challenge } });
      return Response.json({ jsonrpc: "2.0", id: req.id, result: { capabilities: {}, serverInfo: { name: "test", version: "1" } } });
    },
  };
  const transport = new HttpTransport({ url, fetchPort, authProvider: {
    contextId: () => "grant",
    headerFor: async () => ({ authorization: `Bearer ${token}`, contextId: "grant" }),
    onChallenge,
  } });
  const client = new McpClient({ transport, server: { key: "discover-auth" } });
  try {
    expect(await client.discover()).toMatchObject({ kind: "ok", value: { serverInfo: { name: "test" } } });
    expect(onChallenge).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: 401, resource: url, operation: "server/discover", wwwAuthenticate: challenge }),
      expect.any(AbortSignal), expect.anything(),
    );
    expect(calls).toEqual([
      { method: "server/discover", authorization: "Bearer initial" },
      { method: "server/discover", authorization: "Bearer renewed" },
    ]);
  } finally {
    await client.close();
  }
});

it("[EDGE-40] mirrors a multiline tool argument only as a base64 header value", async () => {
  const value = "one\r\ntwo";
  const calls: Array<{ method: string; params: unknown; headers: Headers }> = [];
  const fetchPort: FetchPort = {
    async fetch(_input, init) {
      const req = JSON.parse(String(init.body));
      calls.push({ method: req.method, params: req.params, headers: new Headers(init.headers) });
      const result = req.method === "tools/list" ? { tools: [{
        name: "echo",
        inputSchema: { type: "object", properties: { text: { type: "string", "x-mcp-header": "Text" } } },
      }] } : { content: [{ type: "text", text: "accepted" }] };
      return Response.json({ jsonrpc: "2.0", id: req.id, result });
    },
  };
  const client = new McpClient({ transport: new HttpTransport({ url, fetchPort }), server: { key: "header-encoding" } });
  try {
    expect(await client.request("tools/list")).toMatchObject({ kind: "ok", value: { tools: [{ name: "echo" }] } });
    expect(await client.request("tools/call", { name: "echo", arguments: { text: value } })).toMatchObject({
      kind: "ok", value: { content: [{ type: "text", text: "accepted" }] },
    });
    expect(calls.map(call => call.method)).toEqual(["tools/list", "tools/call"]);
    expect(calls[1]?.params).toMatchObject({ arguments: { text: value } });
    expect(calls[1]?.headers.get("mcp-param-text")).toBe("=?base64?b25lDQp0d28=?=");
  } finally {
    await client.close();
  }
});
