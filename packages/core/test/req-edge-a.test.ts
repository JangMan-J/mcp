import { describe, expect, it } from "vitest";
import {
  createMonotonicIdGenerator,
  McpClient,
  parseInboundMessage,
  type Exchange,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type Transport,
  type TransportDiagnostic,
} from "../src/index.js";

function makeScriptedTransport(
  handler: (req: JsonRpcRequest) => ExchangeEnd | Promise<ExchangeEnd>,
): { transport: Transport; sent: JsonRpcRequest[] } {
  const sent: JsonRpcRequest[] = [];
  const transport: Transport = {
    binding: "stdio",
    start(msg) {
      sent.push(msg);
      const notifications: AsyncIterable<JsonRpcNotification> = {
        async *[Symbol.asyncIterator]() {},
      };
      const done: Promise<ExchangeEnd> = Promise.resolve(handler(msg));
      const ex: Exchange = { notifications, done };
      return ex;
    },
    async notify() {},
    async close() {},
    diagnostics: {
      async *[Symbol.asyncIterator](): AsyncIterator<TransportDiagnostic> {},
    },
  };
  return { transport, sent };
}

describe("core edge cases part A", () => {
  it("[EDGE-3] string id '1' and integer id 1 keep distinct types", () => {
    const num = parseInboundMessage({ jsonrpc: "2.0", id: 1, result: {} });
    const str = parseInboundMessage({ jsonrpc: "2.0", id: "1", result: {} });
    if ("error" in num || "error" in str) throw new Error("parse failed");
    expect((num.message as { id: unknown }).id).toBe(1);
    expect((str.message as { id: unknown }).id).toBe("1");
    expect((num.message as { id: unknown }).id).not.toBe((str.message as { id: unknown }).id);
  });

  it("[EDGE-4] error response with id null yields a diagnostic only", () => {
    const p = parseInboundMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "x" } });
    if ("error" in p) throw new Error("parse failed");
    expect(p.kind).toBe("error");
    expect(p.diagnostics).toContain("error-response-null-id");
  });

  it("[EDGE-12] generated ids are safe integers; inbound id past 2^53 is flagged, not converted", () => {
    const gen = createMonotonicIdGenerator();
    for (let i = 0; i < 1000; i++) expect(Number.isSafeInteger(gen())).toBe(true);
    const big = 2 ** 53 + 2;
    const p = parseInboundMessage({ jsonrpc: "2.0", id: big, error: { code: 1, message: "x" } });
    if ("error" in p) throw new Error("parse failed");
    expect(p.diagnostics.some((d) => d.startsWith("unsafe-integer-id:"))).toBe(true);
    expect(typeof (p.message as { id: unknown }).id).toBe("number");
    const safe = parseInboundMessage({ jsonrpc: "2.0", id: 7, result: {} });
    if ("error" in safe) throw new Error("parse failed");
    expect(safe.diagnostics).toEqual([]);
  });

  it("[EDGE-10] resultType task without a Tasks extension is a protocol-violation", async () => {
    const { transport } = makeScriptedTransport((req) => ({
      kind: "response",
      message: { jsonrpc: "2.0", id: req.id, result: { resultType: "task", taskId: "t1" } },
    }));
    const client = new McpClient({ transport, server: { key: "s1" } });
    const out = await client.request("tools/call", { name: "x" });
    expect(out.kind).toBe("protocol-violation");
  });

  it("[EDGE-13] result without _meta serverInfo is accepted", async () => {
    const { transport } = makeScriptedTransport((req) => ({
      kind: "response",
      message: { jsonrpc: "2.0", id: req.id, result: { resultType: "complete", tools: [] } },
    }));
    const client = new McpClient({ transport, server: { key: "s1" } });
    const out = await client.request("tools/list", {}, { idempotent: true });
    expect(out.kind).toBe("ok");
    if (out.kind === "ok") expect(out.value).toMatchObject({ tools: [] });
  });

  it("[EDGE-5] cancel after the response was observed settles ok with no error", async () => {
    const ac = new AbortController();
    const { transport } = makeScriptedTransport((req) => ({
      kind: "response",
      message: { jsonrpc: "2.0", id: req.id, result: { resultType: "complete", v: 1 } },
    }));
    const client = new McpClient({ transport, server: { key: "s1" } });
    const out = await client.request("tools/call", { name: "x" }, { signal: ac.signal });
    ac.abort("late");
    expect(out.kind).toBe("ok");
  });
});
