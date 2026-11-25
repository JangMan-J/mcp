import { expect, it, vi } from "vitest";
import { ResultCache } from "@mcp/mrtr-cache";
import { McpClient, SUPPORTED_PROTOCOL_VERSION, type ExchangeEnd, type JsonRpcRequest, type Transport } from "../src/index.js";

function scriptedClient(reply: (req: JsonRpcRequest) => ExchangeEnd | Promise<ExchangeEnd>) {
  const sent: JsonRpcRequest[] = [];
  const transport: Transport = {
    binding: "stdio",
    start(req) {
      sent.push(req);
      return {
        done: Promise.resolve(reply(req)),
        notifications: { async *[Symbol.asyncIterator]() {} },
      };
    },
    diagnostics: { async *[Symbol.asyncIterator]() {} },
    async notify() {},
    async close() {},
  };
  const client = new McpClient({ transport, server: { key: "edge" } });
  return { client, sent };
}

function result(req: JsonRpcRequest, value: Record<string, unknown>): ExchangeEnd {
  return { kind: "response", message: { jsonrpc: "2.0", id: req.id, result: value } };
}

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

function cachedTools(client: McpClient) {
  const cache = new ResultCache();
  return () => cache.run({ serverRef: client.server.key, authContextId: "anonymous" },
    "tools/list", {}, { idempotent: true }, client.request.bind(client));
}

it("[EDGE-34] returns -32042 as an ordinary JSON-RPC error without retrying", async () => {
  const error = { code: -32042, message: "Unassigned server error", data: { supported: [SUPPORTED_PROTOCOL_VERSION] } };
  const { client, sent } = scriptedClient(req => ({
    kind: "response", message: { jsonrpc: "2.0", id: req.id, error },
  }));
  try {
    const out = await client.request("tools/list", {}, { idempotent: true });
    expect(out).toMatchObject({ kind: "jsonrpc-error", ...error, meta: { attempts: 1 } });
    // A generic reserved-range label is not a special interpretation of this code.
    if (out.kind === "jsonrpc-error") expect([undefined, "unknown-reserved"]).toContain(out.refined);
    expect(sent.map(req => req.method)).toEqual(["tools/list"]);
  } finally {
    await client.close();
  }
});

it("[EDGE-36] expires a cached tools list on monotonic time despite a backward wall-clock jump", async () => {
  const monotonic = vi.spyOn(performance, "now").mockReturnValue(1_000);
  const wall = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  let revision = 0;
  const { client, sent } = scriptedClient(req =>
    result(req, { resultType: "complete", ttlMs: 100, tools: [{ name: `tool-${++revision}` }] }));
  try {
    const list = cachedTools(client);
    expect(await list()).toMatchObject({ kind: "ok", value: { tools: [{ name: "tool-1" }] }, meta: { cache: "miss" } });
    wall.mockReturnValue(10_000);
    monotonic.mockReturnValue(1_099);
    expect(await list()).toMatchObject({ kind: "ok", value: { tools: [{ name: "tool-1" }] }, meta: { cache: "hit" } });
    expect(sent).toHaveLength(1);
    monotonic.mockReturnValue(1_101);
    expect(await list()).toMatchObject({ kind: "ok", value: { tools: [{ name: "tool-2" }] }, meta: { cache: "miss" } });
    expect(sent.map(req => req.method)).toEqual(["tools/list", "tools/list"]);
  } finally {
    wall.mockRestore();
    monotonic.mockRestore();
    await client.close();
  }
});

it("[EDGE-37] shares one wire fetch between concurrent identical tools/list cache misses", async () => {
  const arrived = gate();
  const response = gate();
  const value = { resultType: "complete", ttlMs: 100, tools: [{ name: "shared" }] };
  const { client, sent } = scriptedClient(async req => {
    arrived.release();
    await response.wait;
    return result(req, value);
  });
  try {
    const list = cachedTools(client);
    const a = list();
    await arrived.wait;
    const b = list();
    response.release();
    for (const out of await Promise.all([a, b])) {
      expect(out).toMatchObject({ kind: "ok", value, meta: { cache: "miss" } });
    }
    expect(sent.map(req => req.method)).toEqual(["tools/list"]);
  } finally {
    response.release();
    await client.close();
  }
});

it("[EDGE-39] rejects an extension resultType unregistered after send and before reply", async () => {
  const arrived = gate();
  const response = gate();
  const value = { resultType: "test-pending", payload: "received" };
  const { client, sent } = scriptedClient(async req => {
    if (req.method === "test/pending") {
      arrived.release();
      await response.wait;
    }
    return result(req, value);
  });
  const handler = vi.fn((value: Record<string, unknown>) => ({
    kind: "ok" as const, value, meta: { binding: "stdio", method: "test/control", requestId: 1, attempts: 1 },
  }));
  const extension = client.use({
    id: "test/pending",
    capabilities: () => ({}),
    attach: host => host.registerResultType("test-pending", handler),
  });
  try {
    expect(await client.request("test/control")).toMatchObject({ kind: "ok", value });
    expect(handler).toHaveBeenCalledTimes(1);
    // Start consuming the request before waiting for the transport barrier.
    const pending = Promise.resolve(client.request("test/pending"));
    await arrived.wait;
    extension.dispose();
    response.release();
    expect(await pending).toMatchObject({
      kind: "protocol-violation", detail: { reason: "unknown-resultType", resultType: "test-pending" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sent.map(req => req.method)).toEqual(["test/control", "test/pending"]);
  } finally {
    response.release();
    await client.close();
  }
});
