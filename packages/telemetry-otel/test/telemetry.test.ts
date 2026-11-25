import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  McpClient,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type Transport,
  type TransportDiagnostic,
} from "@mcp/core";
import { describe, expect, it } from "vitest";
import {
  OtelSpanKind,
  OtelSpanStatusCode,
  createOtelTelemetry,
  instrumentTransport,
  mapNetworkTransport,
  sanitizeSecretString,
} from "../src/index.js";
import { RecordingTracer } from "./recording-tracer.js";

const coreSrcDir = new URL("../../core/src/", import.meta.url);

function makeMemoryTransport(opts: {
  binding: "stdio" | "streamable-http" | (string & {});
  onStart?: (msg: JsonRpcRequest) => void;
  notifications?: readonly JsonRpcNotification[];
  diagnostics?: readonly TransportDiagnostic[];
  reply?: (msg: JsonRpcRequest) => Promise<ExchangeEnd>;
}): Transport {
  const diags = opts.diagnostics ?? [];
  const notifs = opts.notifications ?? [];
  return {
    binding: opts.binding,
    diagnostics: {
      async *[Symbol.asyncIterator]() {
        for (const d of diags) yield d;
      },
    },
    async notify() {},
    async close() {},
    start(msg) {
      opts.onStart?.(msg);
      return {
        notifications: {
          async *[Symbol.asyncIterator]() {
            for (const n of notifs) yield n;
          },
        },
        done: opts.reply
          ? opts.reply(msg)
          : Promise.resolve({
              kind: "response" as const,
              message: { jsonrpc: "2.0" as const, id: msg.id, result: { ok: true } },
            }),
      };
    },
  };
}

describe("@mcp/telemetry-otel", () => {
  it("packages/core/src has zero @opentelemetry imports", () => {
    const checkDir = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) checkDir(full);
        else if (entry.name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          expect(text).not.toMatch(/@opentelemetry/);
        }
      }
    };
    checkDir(coreSrcDir.pathname);
  });

  it("validates W3C trace context, drops oversized tracestate/baggage with diagnostics, and never fabricates absent context", async () => {
    const empty = createOtelTelemetry({ tracer: new RecordingTracer() });
    expect(empty.activeContext()).toBeUndefined();

    const diagnostics: string[] = [];
    const invalid = createOtelTelemetry({
      tracer: new RecordingTracer(),
      contextSource: {
        activeSpanContext: () => ({
          traceId: "00000000000000000000000000000000",
          spanId: "00f067aa0ba902b7",
          traceFlags: 1,
        }),
      },
      onDiagnostic: (d) => diagnostics.push(d),
    });
    expect(invalid.activeContext()).toBeUndefined();
    expect(diagnostics).toEqual(["invalid-traceparent"]);

    const overDiagnostics: string[] = [];
    const oversized = createOtelTelemetry({
      tracer: new RecordingTracer(),
      contextSource: {
        activeSpanContext: () => ({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          traceFlags: 1,
          traceState: "a=" + "z".repeat(520),
        }),
        activeBaggage: () => Array.from({ length: 65 }, (_, i) => `k${i}=v${i}`).join(","),
      },
      onDiagnostic: (d) => overDiagnostics.push(d),
    });
    expect(oversized.activeContext()).toEqual({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    });
    expect(overDiagnostics).toEqual(["tracestate-truncated-or-dropped", "baggage-dropped"]);

    const sent: JsonRpcRequest[] = [];
    const validTelemetry = createOtelTelemetry({
      tracer: new RecordingTracer(),
      contextSource: {
        activeSpanContext: () => ({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: "00f067aa0ba902b7",
          traceFlags: 1,
          traceState: "congo=t61rcWkgMzE",
        }),
        activeBaggage: () => "userId=alice",
      },
    });
    const client = new McpClient({
      transport: makeMemoryTransport({
        binding: "streamable-http",
        onStart: (msg) => sent.push(msg),
      }),
      server: { key: "tel-ctx" },
      ports: { telemetry: validTelemetry },
    });
    await client.request("tools/list", {});
    const meta = (sent[0]!.params as Record<string, unknown>)._meta as Record<string, unknown>;
    expect(meta["traceparent"]).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01");
    expect(meta["tracestate"]).toBe("congo=t61rcWkgMzE");
    expect(meta["baggage"]).toBe("userId=alice");
    await client.close();
  });

  it("defaults captureContent to false and scrubs secrets from attributes and exceptions", () => {
    expect(
      sanitizeSecretString("https://alice:hunter2@example.com/cb?access_token=tok123&client_secret=cs123 Bearer eyJhbGci"),
    ).toBe("https://[REDACTED]@example.com/cb?access_token=[REDACTED]&client_secret=[REDACTED] Bearer [REDACTED]");

    const tracer = new RecordingTracer();
    const defaultPort = createOtelTelemetry({ tracer });
    expect(defaultPort.captureContent).toBe(false);

    const s1 = defaultPort.startClientSpan("mcp.client tools/call", {
      "mcp.method.name": "tools/call",
      "mcp.session.id": "sess-1",
      "mcp.tool.arguments": '{"secret":"pw"}',
      "mcp.tool.result": "secret-output",
      requestState: "state-123",
      authorization: "Bearer eyJhbGciOiJIUzI1NiJ9",
      "url.full": "https://alice:hunter2@example.com/cb?access_token=tok123&client_secret=cs123&assertion=asrt123",
    });
    s1.setAttribute("mcp.session.id", "sess-late");
    s1.recordException(
      new Error("failed at https://alice:hunter2@example.com/cb?access_token=tok123 requestState=state-123"),
    );
    s1.end({ ok: false, errorKind: "transport-failure" });

    const r1 = tracer.spans[0]!;
    expect(r1.attributes["mcp.method.name"]).toBe("tools/call");
    expect(r1.attributes["mcp.session.id"]).toBeUndefined();
    expect(r1.attributes["mcp.tool.arguments"]).toBeUndefined();
    expect(r1.attributes["mcp.tool.result"]).toBeUndefined();
    expect(r1.attributes["requestState"]).toBeUndefined();
    expect(r1.attributes["authorization"]).toBeUndefined();
    expect(String(r1.attributes["url.full"])).not.toMatch(/hunter2|tok123|cs123|asrt123/);
    expect((r1.exceptions[0] as Error).message).not.toMatch(/hunter2|tok123|state-123/);

    const optInPort = createOtelTelemetry({ tracer, captureContent: true });
    const s2 = optInPort.startClientSpan("mcp.client tools/call", {
      "mcp.tool.arguments": '{"q":"hello"}',
      authorization: "Bearer secret-jwt",
      "url.full": "https://u:p@example.com/?client_secret=cs&assertion=as",
    });
    s2.end({ ok: true });
    const r2 = tracer.spans[1]!;
    expect(r2.attributes["mcp.tool.arguments"]).toBe('{"q":"hello"}');
    expect(r2.attributes["authorization"]).toBeUndefined();
    expect(String(r2.attributes["url.full"])).not.toMatch(/:p@|=cs|=as/);
  });

  it("instrumentTransport records client spans across ok, jsonrpc-error, failure, and rejection without extra spans for progress or diagnostics", async () => {
    expect(mapNetworkTransport("stdio")).toBe("pipe");
    expect(mapNetworkTransport("streamable-http")).toBe("tcp");
    expect(mapNetworkTransport("custom")).toBe("custom");

    const tracer = new RecordingTracer();
    const telemetry = createOtelTelemetry({ tracer });

    // 1. Ok + channel separation
    const okTransport = instrumentTransport(
      makeMemoryTransport({
        binding: "streamable-http",
        notifications: [
          {
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: "p1", progress: 50, total: 100 },
          },
        ],
        diagnostics: [{ kind: "stderr", message: "diag", atMs: 1 }],
      }),
      telemetry,
      { protocolVersion: "2025-11-25" },
    );

    const exOk = okTransport.start(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } },
      { signal: new AbortController().signal, idempotent: false, timeoutMs: 1000 },
    );
    const seenNotifs: JsonRpcNotification[] = [];
    for await (const n of exOk.notifications) seenNotifs.push(n);
    const endOk = await exOk.done;
    const seenDiags: TransportDiagnostic[] = [];
    for await (const d of okTransport.diagnostics) seenDiags.push(d);

    expect(endOk.kind).toBe("response");
    expect(seenNotifs).toHaveLength(1);
    expect(seenDiags).toHaveLength(1);
    expect(tracer.spans).toHaveLength(1);
    expect(tracer.spans[0]).toMatchObject({
      name: "mcp.client tools/call",
      kind: OtelSpanKind.CLIENT,
      ended: true,
      status: { code: OtelSpanStatusCode.OK },
      events: [],
    });
    expect(tracer.spans[0]!.attributes).toEqual({
      "mcp.method.name": "tools/call",
      "network.transport": "tcp",
      "mcp.protocol.version": "2025-11-25",
      "mcp.outcome.kind": "ok",
    });

    // 2. JSON-RPC error
    const errTransport = instrumentTransport(
      makeMemoryTransport({
        binding: "stdio",
        reply: async (msg) => ({
          kind: "response",
          message: { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } },
        }),
      }),
      telemetry,
      { spanName: (m) => `custom.${m}` },
    );
    await errTransport.start(
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { signal: new AbortController().signal, idempotent: true, timeoutMs: 1000 },
    ).done;
    expect(tracer.spans[1]).toMatchObject({
      name: "custom.ping",
      ended: true,
      status: { code: OtelSpanStatusCode.ERROR, message: "jsonrpc-error" },
    });
    expect(tracer.spans[1]!.attributes).toEqual({
      "mcp.method.name": "ping",
      "network.transport": "pipe",
      "mcp.outcome.kind": "jsonrpc-error",
    });

    // 3. Transport failure with secret scrubbing
    const failTransport = instrumentTransport(
      makeMemoryTransport({
        binding: "stdio",
        reply: async () => ({
          kind: "failure",
          failure: { kind: "http-status", status: 500, message: "GET https://u:pw@host/?token=abc failed" },
          delivery: "not-sent",
        }),
      }),
      telemetry,
    );
    await failTransport.start(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { signal: new AbortController().signal, idempotent: true, timeoutMs: 1000 },
    ).done;
    expect(tracer.spans[2]!.status).toEqual({ code: OtelSpanStatusCode.ERROR, message: "http-status" });
    expect(tracer.spans[2]!.attributes["mcp.outcome.kind"]).toBe("http-status");
    expect((tracer.spans[2]!.exceptions[0] as Error).message).not.toMatch(/pw|abc/);

    // 4. Rejected transport promise
    const throwTransport = instrumentTransport(
      makeMemoryTransport({
        binding: "stdio",
        reply: async () => {
          throw new Error("boom authorization=Bearer xyz");
        },
      }),
      telemetry,
    );
    await expect(
      throwTransport.start(
        { jsonrpc: "2.0", id: 4, method: "tools/list" },
        { signal: new AbortController().signal, idempotent: true, timeoutMs: 1000 },
      ).done,
    ).rejects.toThrow(/boom/);
    expect(tracer.spans[3]!.status).toEqual({ code: OtelSpanStatusCode.ERROR, message: "transport-error" });
    expect(tracer.spans[3]!.attributes["mcp.outcome.kind"]).toBe("transport-error");
    expect((tracer.spans[3]!.exceptions[0] as Error).message).not.toContain("xyz");
  });
});
