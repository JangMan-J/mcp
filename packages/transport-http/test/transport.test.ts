import { describe, expect, it } from "vitest";
import { McpClient, type AuthProvider, type FetchPort, type JsonRpcNotification, type JsonRpcRequest } from "@mcp-client/core";
import { HttpTransport } from "../src/index.js";
import { createHttpTestServer, respondError, respondJson } from "../../fixtures/server/http-main.ts";
import { formatSseComment, formatSseJson } from "../../fixtures/server/sse.ts";

interface CapturedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly json: Record<string, unknown>;
}

function capture(handler: (call: CapturedCall, n: number) => Response | Promise<Response>): {
  fetchPort: FetchPort;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchPort: FetchPort = {
    fetch: async (input, init) => {
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((v, k) => (headers[k] = v));
      const body = String(init.body ?? "");
      const call: CapturedCall = {
        url: input,
        method: init.method ?? "",
        headers,
        body,
        json: JSON.parse(body) as Record<string, unknown>,
      };
      calls.push(call);
      return handler(call, calls.length);
    },
  };
  return { fetchPort, calls };
}

function jsonResponse(status: number, value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function sseResponse(streamText: string, chunkBytes = 5): Response {
  const bytes = new TextEncoder().encode(streamText);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if ((this as { off?: number }).off === undefined) (this as { off?: number }).off = 0;
      const off = (this as { off?: number }).off!;
      if (off >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(bytes.length, off + chunkBytes);
      (this as { off?: number }).off = end;
      controller.enqueue(bytes.subarray(off, end));
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function req(id: number | string, method: string, params: Record<string, unknown> = {}): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method,
    params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
  };
}

const ctx = (over: Partial<{ idempotent: boolean; timeoutMs: number }> = {}) => ({
  signal: new AbortController().signal,
  idempotent: over.idempotent ?? false,
  timeoutMs: over.timeoutMs ?? 5000,
});

async function run(
  t: HttpTransport,
  r: JsonRpcRequest,
  c = ctx(),
): Promise<{ end: Awaited<ReturnType<HttpTransport["start"]>["done"]>; notifications: JsonRpcNotification[] }> {
  const ex = t.start(r, c);
  const notifications: JsonRpcNotification[] = [];
  const pump = (async () => {
    for await (const n of ex.notifications) notifications.push(n);
  })();
  const end = await ex.done;
  await pump;
  return { end, notifications };
}

const URL1 = "http://example.test/mcp";

describe("HttpTransport request construction", () => {
  it("POSTs one JSON message with all required headers, never session/resume headers", async () => {
    const { fetchPort, calls } = capture((call) =>
      jsonResponse(200, { jsonrpc: "2.0", id: (call.json as { id: unknown }).id, result: { resultType: "complete", ok: true } }),
    );
    const t = new HttpTransport({ url: URL1, fetchPort });
    const { end } = await run(t, req(1, "tools/call", { name: "echo", arguments: { x: 1 } }));
    expect(end.kind).toBe("response");
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.headers["content-type"]).toContain("application/json");
    expect(c.headers["accept"]).toBe("application/json, text/event-stream");
    expect(c.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(c.headers["mcp-method"]).toBe("tools/call");
    expect(c.headers["mcp-name"]).toBe("echo");
    const wire = JSON.stringify(c.headers).toLowerCase();
    expect(wire).not.toContain("mcp-session-id");
    expect(wire).not.toContain("last-event-id");
  });

  it("derives Mcp-Name for resources/read (uri) and prompts/get, base64-encodes non-ASCII (HTTP-HDR-3/ENC-3)", async () => {
    const { fetchPort, calls } = capture((call) =>
      jsonResponse(200, { jsonrpc: "2.0", id: (call.json as { id: unknown }).id, result: { resultType: "complete" } }),
    );
    const t = new HttpTransport({ url: URL1, fetchPort });
    await run(t, req(1, "resources/read", { uri: "file:///tmp/café.txt" }));
    expect(calls[0]!.headers["mcp-name"]).toMatch(/^=\?base64\?.*\?=$/);
    await run(t, req(2, "prompts/get", { name: "greet" }));
    expect(calls[1]!.headers["mcp-name"]).toBe("greet");
    await run(t, req(3, "tools/list"));
    expect(calls[2]!.headers["mcp-name"]).toBeUndefined();
  });

  it("headersHint supplies Mcp-Name / Mcp-Param values", async () => {
    const { fetchPort, calls } = capture((call) =>
      jsonResponse(200, { jsonrpc: "2.0", id: (call.json as { id: unknown }).id, result: { resultType: "complete" } }),
    );
    const t = new HttpTransport({ url: URL1, fetchPort });
    const ex = t.start(req(1, "tools/call", { name: "x" }), {
      ...ctx(),
      headersHint: { name: "hinted", params: { Region: "eu", Count: 3, Flag: true } },
    });
    await ex.done;
    expect(calls[0]!.headers["mcp-name"]).toBe("hinted");
    expect(calls[0]!.headers["mcp-param-region"]).toBe("eu");
    expect(calls[0]!.headers["mcp-param-count"]).toBe("3");
    expect(calls[0]!.headers["mcp-param-flag"]).toBe("true");
  });
});

describe("HttpTransport response handling", () => {
  it("accepts JSON responses and rejects id mismatches, batches, empty and bad content-type", async () => {
    const mk = (resp: Response) => new HttpTransport({ url: URL1, fetchPort: capture(() => resp).fetchPort });
    expect((await run(mk(jsonResponse(200, { jsonrpc: "2.0", id: 1, result: {} })), req(1, "tools/list"), ctx({ idempotent: true }))).end.kind).toBe("response");
    const mismatch = await run(mk(jsonResponse(200, { jsonrpc: "2.0", id: 999, result: {} })), req(1, "tools/list"), ctx({ idempotent: true }));
    expect(mismatch.end.kind).toBe("failure");
    const batch = await run(mk(jsonResponse(200, [{ jsonrpc: "2.0", id: 1, result: {} }])), req(1, "tools/list"), ctx({ idempotent: true }));
    expect(batch.end.kind).toBe("failure");
    const empty = await run(mk(new Response("", { status: 200, headers: { "content-type": "application/json" } })), req(1, "tools/call", { name: "w" }));
    expect(empty.end).toMatchObject({ kind: "failure", delivery: "delivered-no-response" });
    const badCt = await run(mk(new Response("hi", { status: 200, headers: { "content-type": "text/plain" } })), req(1, "tools/list"), ctx({ idempotent: true }));
    expect(badCt.end.kind).toBe("failure");
  });

  it("202 to a request is a failure; notify() expects 202 and tolerates other 2xx", async () => {
    const { fetchPort, calls } = capture((_c, n) =>
      n === 1 ? new Response(null, { status: 202 }) : new Response(null, { status: 204 }),
    );
    const t = new HttpTransport({ url: URL1, fetchPort });
    const { end } = await run(t, req(1, "tools/call", { name: "w" }));
    expect(end).toMatchObject({ kind: "failure", delivery: "delivered-no-response" });
    await expect(t.notify({ jsonrpc: "2.0", method: "notifications/custom", params: {} }, ctx())).resolves.toBeUndefined();
    expect(calls[1]!.method).toBe("POST");
  });

  it("maps status codes: legacy 400/404, modern -32601/-32022 as responses, 413 too-large, 403 forbidden", async () => {
    const cases: Array<[Response, string]> = [
      [new Response("", { status: 400 }), "legacy-or-malformed"],
      [new Response("nope", { status: 404 }), "legacy-or-wrong-endpoint"],
      [new Response("", { status: 413 }), "too large"],
    ];
    for (const [resp, frag] of cases) {
      const t = new HttpTransport({ url: URL1, fetchPort: capture(() => resp).fetchPort });
      const { end } = await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
      expect(end.kind).toBe("failure");
      if (end.kind === "failure") expect(end.failure.message).toContain(frag);
    }
    const notFound = new HttpTransport({
      url: URL1,
      fetchPort: capture(() => jsonResponse(404, { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no method" } })).fetchPort,
    });
    expect((await run(notFound, req(1, "tools/list"), ctx({ idempotent: true }))).end).toMatchObject({
      kind: "response",
      message: { error: { code: -32601 } },
    });
    const ver = new HttpTransport({
      url: URL1,
      fetchPort: capture(() => jsonResponse(400, { jsonrpc: "2.0", id: 1, error: { code: -32022, message: "bad version", data: { supported: ["2026-07-28"] } } })).fetchPort,
    });
    expect((await run(ver, req(1, "tools/list"), ctx({ idempotent: true }))).end).toMatchObject({
      kind: "response",
      message: { error: { code: -32022 } },
    });
    const tooLarge = new HttpTransport({ url: URL1, fetchPort: capture(() => new Response("", { status: 431 })).fetchPort });
    const tl = await run(tooLarge, req(1, "tools/call", { name: "w" }));
    expect(tl.end).toMatchObject({ kind: "failure", failure: { kind: "too-large" }, delivery: "not-sent" });
    const forb = new HttpTransport({ url: URL1, fetchPort: capture(() => new Response("", { status: 403 })).fetchPort });
    expect((await run(forb, req(1, "tools/list"), ctx({ idempotent: true }))).end).toMatchObject({
      kind: "failure",
      failure: { kind: "forbidden", status: 403 },
    });
  });

  it("5xx is delivered-no-response with Retry-After recorded (HTTP-ERR-8); connect errors are connect failures", async () => {
    const t = new HttpTransport({
      url: URL1,
      fetchPort: capture(() => new Response("boom", { status: 503, headers: { "retry-after": "9" } })).fetchPort,
    });
    const { end } = await run(t, req(1, "tools/call", { name: "w" }));
    expect(end).toMatchObject({ kind: "failure", failure: { kind: "http-status", status: 503 }, delivery: "delivered-no-response" });
    expect(t.lastRetryAfter).toBe("9");
    const down = new HttpTransport({
      url: URL1,
      fetchPort: { fetch: async () => { throw new TypeError("fetch failed"); } },
    });
    const d = await run(down, req(1, "tools/list"), ctx({ idempotent: true }));
    expect(d.end).toMatchObject({ kind: "failure", failure: { kind: "connect" } });
  });

  it("follows same-origin 307 at most 3 hops; refuses cross-origin and 302 (HTTP-REDIR-1)", async () => {
    const same = capture((_c, n) =>
      n === 1
        ? new Response(null, { status: 307, headers: { location: "/mcp2" } })
        : jsonResponse(200, { jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }),
    );
    const t = new HttpTransport({ url: URL1, fetchPort: same.fetchPort });
    expect((await run(t, req(1, "tools/list"), ctx({ idempotent: true }))).end.kind).toBe("response");
    expect(same.calls[1]!.url).toBe("http://example.test/mcp2");
    expect(same.calls[1]!.method).toBe("POST");

    const cross = new HttpTransport({
      url: URL1,
      fetchPort: capture(() => new Response(null, { status: 308, headers: { location: "https://evil.test/mcp" } })).fetchPort,
    });
    expect((await run(cross, req(1, "tools/call", { name: "w" }))).end).toMatchObject({
      kind: "failure",
      failure: { kind: "forbidden" },
      delivery: "not-sent",
    });
    const found = new HttpTransport({
      url: URL1,
      fetchPort: capture(() => new Response(null, { status: 302, headers: { location: "/elsewhere" } })).fetchPort,
    });
    expect((await run(found, req(1, "tools/list"), ctx({ idempotent: true }))).end.kind).toBe("failure");
  });

  it("enforces JSON body size limit (HTTP-LIMIT-1)", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { blob: "x".repeat(500) } });
    const t = new HttpTransport({ url: URL1, fetchPort: capture(() => new Response(big, { status: 200, headers: { "content-type": "application/json" } })).fetchPort, maxJsonBytes: 64 });
    const { end } = await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
    expect(end).toMatchObject({ kind: "failure", failure: { kind: "too-large" } });
  });
});

describe("HttpTransport SSE handling", () => {
  it("routes related progress, then settles on the final response split across tiny chunks", async () => {
    const text =
      formatSseComment() +
      formatSseJson({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1, total: 2 } }) +
      formatSseJson({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "other", progress: 1 } }) +
      formatSseJson({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", via: "sse" } });
    const t = new HttpTransport({ url: URL1, fetchPort: capture(() => sseResponse(text, 3)).fetchPort });
    const { end, notifications } = await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
    expect(end.kind).toBe("response");
    expect(notifications.map((n) => n.method)).toEqual(["notifications/progress"]);
    expect(t.diagnosticsSnapshot().some((d) => d.message.includes("unrelated"))).toBe(true);
  });

  it("ignores events after the final response and non-message events", async () => {
    const text =
      "event: ping\ndata: {}\n\n" +
      formatSseJson({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }) +
      formatSseJson({ jsonrpc: "2.0", id: 1, result: { resultType: "complete", second: true } });
    const t = new HttpTransport({ url: URL1, fetchPort: capture(() => sseResponse(text, 1024)).fetchPort });
    const { end } = await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
    expect(end).toMatchObject({ kind: "response", message: { result: { resultType: "complete" } } });
  });

  it("fails on a server request on the stream, and on stream end without a response", async () => {
    const reqOnStream = new HttpTransport({
      url: URL1,
      fetchPort: capture(() => sseResponse(formatSseJson({ jsonrpc: "2.0", id: "srv-1", method: "ping", params: {} }), 1024)).fetchPort,
    });
    expect((await run(reqOnStream, req(1, "tools/list"), ctx({ idempotent: true }))).end.kind).toBe("failure");
    const noFinal = new HttpTransport({
      url: URL1,
      fetchPort: capture(() => sseResponse(formatSseComment(), 1024)).fetchPort,
    });
    expect((await run(noFinal, req(1, "tools/call", { name: "w" }))).end).toMatchObject({
      kind: "failure",
      failure: { kind: "stream-broken" },
      delivery: "delivered-no-response",
    });
  });

  it("enforces SSE event and stream size limits", async () => {
    const bigEvent = `data: ${"x".repeat(200)}\n\n`;
    const t1 = new HttpTransport({ url: URL1, fetchPort: capture(() => sseResponse(bigEvent, 1024)).fetchPort, maxSseEventBytes: 32 });
    expect((await run(t1, req(1, "tools/list"), ctx({ idempotent: true }))).end).toMatchObject({ failure: { kind: "too-large" } });
    const many = formatSseComment("a".repeat(40)).repeat(10);
    const t2 = new HttpTransport({ url: URL1, fetchPort: capture(() => sseResponse(many, 16)).fetchPort, maxSseStreamBytes: 64 });
    expect((await run(t2, req(1, "tools/list"), ctx({ idempotent: true }))).end).toMatchObject({ failure: { kind: "too-large" } });
  });

  it("abort closes the stream with no notifications/cancelled POST (HTTP-CANCEL-1)", async () => {
    const srv = await createHttpTestServer({
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(formatSseComment());
        // never ends: the client abort must tear the stream down
      },
    });
    try {
      const t = new HttpTransport({ url: srv.url });
      const ac = new AbortController();
      const ex = t.start(req(1, "tools/call", { name: "w" }), { signal: ac.signal, idempotent: false, timeoutMs: 60_000 });
      setTimeout(() => ac.abort("user"), 30);
      const end = await ex.done;
      expect(end.kind).toBe("failure");
      expect(srv.requests).toHaveLength(1); // no second POST for notifications/cancelled
    } finally {
      await srv.close();
    }
  });
});

describe("x-mcp-header mirroring (HTTP-PARAM-*)", () => {
  const toolList = {
    tools: [
      {
        name: "good",
        inputSchema: {
          type: "object",
          properties: {
            tenant: { type: "string", "x-mcp-header": "Tenant" },
            count: { type: "integer", "x-mcp-header": "Count" },
            flag: { type: "boolean", "x-mcp-header": "Flag" },
            outer: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } },
            plain: { type: "string" },
          },
        },
      },
      { name: "bad", inputSchema: { type: "object", properties: { x: { type: "number", "x-mcp-header": "X" } } } },
    ],
  };

  function setup() {
    return capture((call) => {
      const body = call.json as { id: unknown; method: string };
      if (body.method === "tools/list") return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ...toolList } });
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", called: true } });
    });
  }

  it("excludes invalid tools on tools/list, caches valid schemas, mirrors values and omits absent/null", async () => {
    const { fetchPort, calls } = setup();
    const t = new HttpTransport({ url: URL1, fetchPort });
    const list = await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
    expect(list.end.kind).toBe("response");
    if (list.end.kind === "response" && !("error" in list.end.message)) {
      const tools = (list.end.message.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((x) => x.name)).toEqual(["good"]);
    }
    expect(t.diagnosticsSnapshot().some((d) => d.message.includes("bad"))).toBe(true);

    await run(t, req(2, "tools/call", { name: "good", arguments: { tenant: "acme", count: 3, flag: false, outer: { region: "eu" }, plain: "p" } }));
    const callHeaders = calls[1]!.headers;
    expect(callHeaders["mcp-param-tenant"]).toBe("acme");
    expect(callHeaders["mcp-param-count"]).toBe("3");
    expect(callHeaders["mcp-param-flag"]).toBe("false");
    expect(callHeaders["mcp-param-region"]).toBe("eu");
    expect(callHeaders["mcp-param-plain"]).toBeUndefined();

    await run(t, req(3, "tools/call", { name: "good", arguments: { tenant: null } }));
    expect(calls[2]!.headers["mcp-param-tenant"]).toBeUndefined();
  });

  it("sends no Mcp-Param when the schema was never obtained (HTTP-PARAM-5)", async () => {
    const { fetchPort, calls } = setup();
    const t = new HttpTransport({ url: URL1, fetchPort });
    await run(t, req(1, "tools/call", { name: "good", arguments: { tenant: "acme" } }));
    expect(Object.keys(calls[0]!.headers).filter((k) => k.startsWith("mcp-param-"))).toEqual([]);
  });

  it("refreshes tools/list and retries once on HeaderMismatch with a new wire id (HTTP-PARAM-6)", async () => {
    const { fetchPort, calls } = capture((call, n) => {
      const body = call.json as { id: unknown; method: string };
      if (body.method === "tools/list") return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", ...toolList } });
      if (n === 1) return jsonResponse(400, { jsonrpc: "2.0", id: body.id, error: { code: -32020, message: "HeaderMismatch" } });
      return jsonResponse(200, { jsonrpc: "2.0", id: body.id, result: { resultType: "complete", retried: true } });
    });
    const t = new HttpTransport({ url: URL1, fetchPort });
    const { end } = await run(t, req(7, "tools/call", { name: "good", arguments: { tenant: "acme" } }));
    expect(end.kind).toBe("response");
    if (end.kind === "response") expect(end.message.id).toBe(7); // mapped back to the caller's id
    expect(calls.map((c) => (c.json as { method: string }).method)).toEqual(["tools/call", "tools/list", "tools/call"]);
    expect(calls[2]!.json["id"]).not.toBe(calls[0]!.json["id"]);
    expect(calls[2]!.headers["mcp-param-tenant"]).toBe("acme");
  });
});

describe("AuthProvider interceptor hook", () => {
  it("attaches Authorization on every request and retries once on 401 after onChallenge", async () => {
    let token = "token-1";
    const provider: AuthProvider = {
      contextId: () => "ctx-1",
      headerFor: async () => ({ authorization: `Bearer ${token}`, contextId: "ctx-1" }),
      onChallenge: async (ch) => {
        expect(ch.status).toBe(401);
        token = "token-2";
        return true;
      },
    };
    const { fetchPort, calls } = capture((call, n) =>
      n === 1
        ? new Response("", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://as.test/prm"' } })
        : jsonResponse(200, { jsonrpc: "2.0", id: (call.json as { id: unknown }).id, result: { resultType: "complete" } }),
    );
    const t = new HttpTransport({ url: URL1, fetchPort, authProvider: provider });
    const { end } = await run(t, req(5, "tools/call", { name: "w" }));
    expect(end.kind).toBe("response");
    if (end.kind === "response") expect(end.message.id).toBe(5);
    expect(calls[0]!.headers["authorization"]).toBe("Bearer token-1");
    expect(calls[1]!.headers["authorization"]).toBe("Bearer token-2");
    expect(calls[1]!.json["id"]).not.toBe(calls[0]!.json["id"]);
  });

  it("surfaces 401 as a definitive failure when there is no provider / no retry", async () => {
    const t = new HttpTransport({ url: URL1, fetchPort: capture(() => new Response("", { status: 401 })).fetchPort });
    const { end } = await run(t, req(1, "tools/call", { name: "w" }));
    expect(end).toMatchObject({ kind: "failure", failure: { kind: "forbidden", status: 401 }, delivery: "not-sent" });
  });
});

describe("synthetic HTTP server (fixtures/server/http-main.ts)", () => {
  it("serves JSON and SSE modes and records a POST-only, session-free wire", async () => {
    const srv = await createHttpTestServer({ mode: "sse-progress" });
    try {
      const t = new HttpTransport({ url: srv.url });
      const { end, notifications } = await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
      expect(end.kind).toBe("response");
      expect(notifications).toHaveLength(1);
      expect(srv.requests).toHaveLength(1);
      const wire = JSON.stringify(srv.requests).toLowerCase();
      expect(srv.requests[0]!.method).toBe("POST");
      expect(wire).not.toContain("last-event-id");
      expect(wire).not.toContain("mcp-session-id");
    } finally {
      await srv.close();
    }
  });

  it("sse-id-retry mode: client never resumes with Last-Event-ID on the next request", async () => {
    const srv = await createHttpTestServer({ mode: "sse-id-retry" });
    try {
      const t = new HttpTransport({ url: srv.url });
      await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
      await run(t, req(2, "tools/list"), ctx({ idempotent: true }));
      expect(srv.requests).toHaveLength(2);
      for (const r of srv.requests) {
        expect(r.method).toBe("POST");
        expect(r.headers["last-event-id"]).toBeUndefined();
        expect(r.headers["mcp-session-id"]).toBeUndefined();
      }
    } finally {
      await srv.close();
    }
  });

  it("custom handler can return modern JSON-RPC errors over HTTP status", async () => {
    const srv = await createHttpTestServer({
      handler: (_req, res, rec) => {
        const id = (rec.json as { id: number }).id;
        respondError(res, 400, id, -32021, "missing capability");
      },
    });
    try {
      const t = new HttpTransport({ url: srv.url });
      const { end } = await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
      expect(end).toMatchObject({ kind: "response", message: { error: { code: -32021 } } });
    } finally {
      await srv.close();
    }
  });

  it("wire-scan: a batch of operations against the real server emits only POSTs without forbidden headers", async () => {
    const srv = await createHttpTestServer({ mode: "json" });
    try {
      const t = new HttpTransport({ url: srv.url });
      await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
      await run(t, req(2, "tools/call", { name: "echo", arguments: {} }));
      await run(t, req(3, "resources/read", { uri: "file:///a" }), ctx({ idempotent: true }));
      await t.notify({ jsonrpc: "2.0", method: "notifications/custom", params: {} }, ctx());
      expect(srv.requests.length).toBeGreaterThanOrEqual(4);
      for (const r of srv.requests) {
        expect(r.method).toBe("POST");
        const names = Object.keys(r.headers).map((h) => h.toLowerCase());
        expect(names).not.toContain("last-event-id");
        expect(names).not.toContain("mcp-session-id");
      }
      expect(respondJson).toBeTypeOf("function");
    } finally {
      await srv.close();
    }
  });
});

describe("McpClient integration over HttpTransport", () => {
  it("returns ok outcomes over JSON, and uncertain-write for a 5xx write but safe transport-failure for reads", async () => {
    const srv = await createHttpTestServer({ mode: "json" });
    try {
      const client = new McpClient({ transport: new HttpTransport({ url: srv.url }), server: { key: "http-test" } });
      const ok = await client.request("tools/list", {}, { idempotent: true });
      expect(ok.kind).toBe("ok");
      await client.close();
    } finally {
      await srv.close();
    }

    const failing = await createHttpTestServer({ mode: "status-500" });
    try {
      const client = new McpClient({ transport: new HttpTransport({ url: failing.url }), server: { key: "http-500" } });
      const write = await client.request("tools/call", { name: "w", arguments: {} });
      expect(write.kind).toBe("uncertain-write");
      const read = await client.request("tools/list", {}, { idempotent: true });
      expect(read.kind).toBe("transport-failure");
      if (read.kind === "transport-failure") expect(read.safeToRetry).toBe(true);
      await client.close();
    } finally {
      await failing.close();
    }
  });

  it("stream break on a write becomes uncertain-write and is never silently re-issued (HTTP-AMBIG-1)", async () => {
    const srv = await createHttpTestServer({ mode: "sse-break" });
    try {
      const client = new McpClient({ transport: new HttpTransport({ url: srv.url }), server: { key: "http-break" } });
      const out = await client.request("tools/call", { name: "w", arguments: {} });
      expect(out.kind).toBe("uncertain-write");
      expect(srv.requests.filter((r) => (r.json as { method?: string })?.method === "tools/call")).toHaveLength(1);
      await client.close();
    } finally {
      await srv.close();
    }
  });
});
