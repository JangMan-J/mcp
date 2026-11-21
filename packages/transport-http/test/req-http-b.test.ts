import { describe, expect, it } from "vitest";
import { McpClient, type FetchPort, type JsonRpcNotification, type JsonRpcRequest } from "@mcp-client/core";
import {
  DEFAULT_MAX_JSON_BYTES,
  DEFAULT_MAX_SSE_EVENT_BYTES,
  DEFAULT_MAX_SSE_STREAM_BYTES,
  HttpTransport,
  SseEventTooLargeError,
  SseParser,
} from "../src/index.js";

const URL1 = "http://example.test/mcp";
const enc = new TextEncoder();

interface Call {
  readonly json: Record<string, unknown>;
}

function capture(handler: (call: Call, n: number) => Response | Promise<Response>): { fetchPort: FetchPort; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetchPort: {
      fetch: async (_input, init) => {
        const call = { json: JSON.parse(String(init.body ?? "")) as Record<string, unknown> };
        calls.push(call);
        return handler(call, calls.length);
      },
    },
  };
}

/** SSE response from explicit chunks; records whether the consumer cancelled the body and how many chunks were pulled. */
function sseChunks(chunks: readonly string[], opts: { errorAtEnd?: boolean } = {}) {
  const state = { cancelled: false, pulled: 0 };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) {
        state.pulled++;
        c.enqueue(enc.encode(chunks[i++]!));
      } else if (opts.errorAtEnd) c.error(new Error("connection reset"));
      else c.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const response = new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  return { response, state };
}

const sse = (v: unknown, event?: string) => `${event !== undefined ? `event: ${event}\n` : ""}data: ${JSON.stringify(v)}\n\n`;
const ok = (id: unknown, extra: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, result: { resultType: "complete", ...extra } });

function req(id: number | string, method: string, params: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } };
}

const ctx = () => ({ signal: new AbortController().signal, idempotent: false, timeoutMs: 5000 });

async function run(t: HttpTransport, r: JsonRpcRequest) {
  const ex = t.start(r, ctx());
  const notifications: JsonRpcNotification[] = [];
  const pump = (async () => {
    for await (const n of ex.notifications) notifications.push(n);
  })();
  const end = await ex.done;
  await pump;
  return { end, notifications };
}

const failureKind = (end: Awaited<ReturnType<typeof run>>["end"]) => (end.kind === "failure" ? end.failure.kind : `response`);

describe("HTTP size limits", () => {
  it("[HTTP-LIMIT-1] JSON response bodies are capped (default 64 MiB, configurable) and over-cap bodies fail too-large", async () => {
    expect(DEFAULT_MAX_JSON_BYTES).toBe(64 * 1024 * 1024);
    const big = JSON.stringify(ok(1, { pad: "x".repeat(2000) }));
    const mk = (cap: number) => {
      const { fetchPort } = capture(() => new Response(big, { status: 200, headers: { "content-type": "application/json" } }));
      return new HttpTransport({ url: URL1, fetchPort, maxJsonBytes: cap });
    };
    const under = await run(mk(big.length), req(1, "tools/call", { name: "w" }));
    expect(under.end.kind).toBe("response");
    const over = await run(mk(big.length - 1), req(1, "tools/call", { name: "w" }));
    expect(failureKind(over.end)).toBe("too-large");
    if (over.end.kind === "failure") expect(over.end.delivery).toBe("delivered-no-response");
  });

  it("[HTTP-LIMIT-2] a single SSE event over the event cap (default 4 MiB, configurable) fails too-large and cancels the body", async () => {
    expect(DEFAULT_MAX_SSE_EVENT_BYTES).toBe(4 * 1024 * 1024);
    // Parser-level: cap is enforced while the data buffer grows across chunks.
    const p = new SseParser(16);
    expect(p.push("data: 0123456789\n")).toEqual([]);
    expect(() => p.push("data: abcdefghij\n")).toThrow(SseEventTooLargeError);
    // Transport-level: one event, delivered in small chunks, exceeds maxSseEventBytes.
    // Multi-line data (JSON tolerates the newline joins) so the cap trips before the event completes.
    const lines = JSON.stringify(ok(1, { pad: "y".repeat(500) }), null, 1).split("\n");
    const chunks = [...lines.map((l) => `data: ${l}\n`), "\n"];
    const { response, state } = sseChunks(chunks);
    const t = new HttpTransport({ url: URL1, fetchPort: capture(() => response).fetchPort, maxSseEventBytes: 200 });
    const { end } = await run(t, req(1, "tools/call", { name: "w" }));
    expect(failureKind(end)).toBe("too-large");
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(chunks.length);
    // Same stream under a sufficient cap succeeds.
    const t2 = new HttpTransport({ url: URL1, fetchPort: capture(() => sseChunks(chunks).response).fetchPort, maxSseEventBytes: 4096 });
    expect((await run(t2, req(1, "tools/call", { name: "w" }))).end.kind).toBe("response");
  });

  it("[HTTP-LIMIT-3] total SSE bytes per request are capped (default 64 MiB, configurable) even when every event is small", async () => {
    expect(DEFAULT_MAX_SSE_STREAM_BYTES).toBe(64 * 1024 * 1024);
    const progress = (i: number) => sse({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: i } });
    const chunks = Array.from({ length: 50 }, (_, i) => progress(i));
    chunks.push(sse(ok(1)));
    const total = chunks.reduce((n, c) => n + enc.encode(c).byteLength, 0);
    const { response, state } = sseChunks(chunks);
    const t = new HttpTransport({ url: URL1, fetchPort: capture(() => response).fetchPort, maxSseStreamBytes: 1000, maxSseEventBytes: 1000 });
    const { end, notifications } = await run(t, req(1, "tools/call", { name: "w" }));
    expect(failureKind(end)).toBe("too-large");
    expect(state.cancelled).toBe(true);
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications.length).toBeLessThan(50);
    const t2 = new HttpTransport({ url: URL1, fetchPort: capture(() => sseChunks(chunks).response).fetchPort, maxSseStreamBytes: total });
    expect((await run(t2, req(1, "tools/call", { name: "w" }))).end.kind).toBe("response");
  });
});

describe("HTTP SSE dispatch", () => {
  it("[HTTP-SSE-2] absent event field and event:message dispatch; other event types are ignored and diagnosed", async () => {
    const note = (tag: string) => ({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: tag } });
    const chunks = [
      sse(note("absent")),
      sse(note("custom"), "custom"),
      sse(ok(1, { from: "ping" }), "ping"),
      sse(note("message"), "message"),
      sse(ok(1, { from: "final" })),
    ];
    const t = new HttpTransport({ url: URL1, fetchPort: capture(() => sseChunks(chunks).response).fetchPort });
    const { end, notifications } = await run(t, req(1, "tools/call", { name: "w" }));
    expect(notifications.map((n) => (n.params as { data: string }).data)).toEqual(["absent", "message"]);
    expect(end.kind).toBe("response");
    if (end.kind === "response" && "result" in end.message) expect(end.message.result["from"]).toBe("final");
    expect(t.diagnosticsSnapshot().filter((d) => d.message.includes("non-message SSE event"))).toHaveLength(2);
  });

  it("[HTTP-SSE-6] after the final response, later events are ignored and the body is cancelled", async () => {
    const late = { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "late" } };
    const chunks = [sse(ok(1, { n: 1 })) + sse(late), sse(late), sse(late), sse(late)];
    const { response, state } = sseChunks(chunks);
    const t = new HttpTransport({ url: URL1, fetchPort: capture(() => response).fetchPort });
    const { end, notifications } = await run(t, req(1, "tools/call", { name: "w" }));
    expect(end.kind).toBe("response");
    expect(notifications).toHaveLength(0);
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(chunks.length);
  });

  it("[HTTP-SSE-7] a second response for the same id never replaces the first", async () => {
    const chunks = [sse(ok(1, { n: "first" })) + sse(ok(1, { n: "second" })), sse(ok(1, { n: "third" }))];
    const t = new HttpTransport({ url: URL1, fetchPort: capture(() => sseChunks(chunks).response).fetchPort });
    const { end } = await run(t, req(1, "tools/call", { name: "w" }));
    expect(end.kind).toBe("response");
    if (end.kind === "response" && "result" in end.message) expect(end.message.result["n"]).toBe("first");
  });

  it("[HTTP-SSE-8] request-scoped progress is dropped on a subscriptions/listen stream but delivered on a request stream", async () => {
    const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 0.5 } };
    const chunks = [sse(progress), sse(ok(1))];
    const listen = new HttpTransport({ url: URL1, fetchPort: capture(() => sseChunks(chunks).response).fetchPort });
    const l = await run(listen, req(1, "subscriptions/listen"));
    expect(l.end.kind).toBe("response");
    expect(l.notifications).toHaveLength(0);
    expect(listen.diagnosticsSnapshot().some((d) => d.message.includes("unrelated SSE notification"))).toBe(true);
    const call = new HttpTransport({ url: URL1, fetchPort: capture(() => sseChunks(chunks).response).fetchPort });
    const c = await run(call, req(1, "tools/call", { name: "w" }));
    expect(c.notifications.map((n) => n.method)).toEqual(["notifications/progress"]);
  });
});

describe("HTTP ambiguous breaks", () => {
  it("[HTTP-AMBIG-5] a break during an MRTR retry carrying inputResponses is uncertain-write, not silently retried", async () => {
    const { fetchPort, calls } = capture((call, n) => {
      if (n === 1) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: call.json["id"], result: { resultType: "input_required", requestState: "s1", inputRequests: { q: { method: "elicitation/create", params: {} } } } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const progress = { jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: call.json["id"], progress: 0.1 } };
      return sseChunks([sse(progress)], { errorAtEnd: true }).response;
    });
    const client = new McpClient({ transport: new HttpTransport({ url: URL1, fetchPort }), server: { key: "ambig5" } });
    try {
      const first = await client.request("tools/call", { name: "w", arguments: {} });
      expect(first.kind).toBe("mrtr-interim");
      if (first.kind !== "mrtr-interim") return;
      expect("resume" in first).toBe(false);
      const second = await client.request("tools/call", {
        name: "w",
        arguments: {},
        ...(first.requestState !== undefined ? { requestState: first.requestState } : {}),
        inputResponses: { q: { action: "accept" } },
      });
      expect(second.kind).toBe("uncertain-write");
      expect(calls).toHaveLength(2);
      const params = calls[1]!.json["params"] as Record<string, unknown>;
      expect(params["inputResponses"]).toEqual({ q: { action: "accept" } });
      expect(params["requestState"]).toBe("s1");
    } finally {
      await client.close();
    }
  });
});
