import { describe, expect, it } from "vitest";
import {
  assertOutboundRequest,
  createMonotonicIdGenerator,
  DEFAULT_MAX_DIAGNOSTICS,
  DiagnosticChannel,
  McpClient,
  McpOutcomeError,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  parseInboundMessage,
  SUPPORTED_PROTOCOL_VERSION,
  unwrapOutcome,
  validateMetaEntries,
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

describe("@mcp/core S1.0 contracts", () => {
  it("generates 1e5 unique safe-integer request ids without null (WIRE-ID-1)", () => {
    const gen = createMonotonicIdGenerator();
    const seen = new Set<string | number>();
    for (let i = 0; i < 100_000; i++) {
      const id = gen();
      expect(id).not.toBeNull();
      expect(typeof id).toBe("number");
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });

  it("rejects outbound response envelopes (WIRE-DIR-1) and reserved _meta overrides (WIRE-META-4/5)", () => {
    expect(() =>
      assertOutboundRequest({ jsonrpc: "2.0", id: 1, result: {} }),
    ).toThrow(/response/i);
    expect(() =>
      validateMetaEntries({ [META_PROTOCOL_VERSION]: "2025-11-25" }),
    ).toThrow(/reserved/i);
    expect(() =>
      validateMetaEntries({ [META_CLIENT_CAPABILITIES]: {} }),
    ).toThrow(/reserved/i);
    expect(() =>
      validateMetaEntries({ "bad key with spaces": 1 }),
    ).toThrow(/syntax/i);
  });

  it("treats absent resultType as complete (WIRE-RT-2) and rejects unknown resultType (WIRE-RT-3)", async () => {
    const { transport } = makeScriptedTransport((req) => {
      if (req.method === "tools/list") {
        return {
          kind: "response",
          message: { jsonrpc: "2.0", id: req.id, result: { tools: [] } },
        };
      }
      return {
        kind: "response",
        message: { jsonrpc: "2.0", id: req.id, result: { resultType: "mystery_ext" } },
      };
    });
    const client = new McpClient({ transport, server: { key: "s1" } });
    const okOut = await client.request("tools/list", {}, { idempotent: true });
    expect(okOut.kind).toBe("ok");
    expect(unwrapOutcome(okOut)).toEqual({ tools: [] });

    const badOut = await client.request("tools/call", { name: "x" });
    expect(badOut.kind).toBe("protocol-violation");
    expect(() => unwrapOutcome(badOut)).toThrow(McpOutcomeError);
  });

  it("retries once on -32022 when server offers a supported version (VER-2/VER-4)", async () => {
    let calls = 0;
    const { transport, sent } = makeScriptedTransport((req) => {
      calls += 1;
      if (calls === 1) {
        return {
          kind: "response",
          message: {
            jsonrpc: "2.0",
            id: req.id,
            error: {
              code: -32022,
              message: "Unsupported version",
              data: { requested: "2026-07-28", supported: [SUPPORTED_PROTOCOL_VERSION] },
            },
          },
        };
      }
      return {
        kind: "response",
        message: { jsonrpc: "2.0", id: req.id, result: { resultType: "complete", ok: true } },
      };
    });
    const client = new McpClient({ transport, server: { key: "s1" } });
    const out = await client.request("ping", {}, { idempotent: true });
    expect(out.kind).toBe("ok");
    expect(out.meta.attempts).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.id).not.toBe(sent[1]!.id);
  });

  it("emits zero wire traffic when aborted before send (EDGE-6)", async () => {
    const { transport, sent } = makeScriptedTransport((req) => ({
      kind: "response",
      message: { jsonrpc: "2.0", id: req.id, result: {} },
    }));
    const client = new McpClient({ transport, server: { key: "s1" } });
    const ac = new AbortController();
    ac.abort("pre-aborted");
    const out = await client.request("tools/call", { name: "write" }, { signal: ac.signal });
    expect(out.kind).toBe("cancelled");
    if (out.kind === "cancelled") {
      expect(out.wasSent).toBe(false);
    }
    expect(sent).toHaveLength(0);
  });

  it("preserves id types strictly in parseInboundMessage (EDGE-3)", () => {
    const num = parseInboundMessage({ jsonrpc: "2.0", id: 1, result: {} });
    const str = parseInboundMessage({ jsonrpc: "2.0", id: "1", result: {} });
    expect("error" in num).toBe(false);
    expect("error" in str).toBe(false);
    if (!("error" in num) && !("error" in str) && "id" in num.message && "id" in str.message) {
      expect(typeof num.message.id).toBe("number");
      expect(typeof str.message.id).toBe("string");
    }
  });

  it("bounds DiagnosticChannel snapshot and live stream to DEFAULT_MAX_DIAGNOSTICS", async () => {
    expect(DEFAULT_MAX_DIAGNOSTICS).toBe(1000);
    const ch = new DiagnosticChannel(3);
    for (let i = 0; i < 5; i++) ch.emit({ kind: "noise", message: `m${i}`, atMs: i });
    ch.close();
    expect(ch.snapshot().map((d) => d.message)).toEqual(["m2", "m3", "m4"]);
    const streamed: string[] = [];
    for await (const d of ch) streamed.push(d.message);
    expect(streamed).toEqual(["m2", "m3", "m4"]);
  });
});
