import { describe, expect, it } from "vitest";
import { McpClient, type FetchPort, type JsonRpcNotification, type JsonRpcRequest } from "@mcp-client/core";
import { HttpTransport, getHeaderCaseInsensitive } from "../src/index.js";
import { createHttpTestServer } from "./helpers/http-server.js";
import { formatSseComment } from "./helpers/sse.js";

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
      const call: CapturedCall = { url: input, method: init.method ?? "", headers, body, json: JSON.parse(body) as Record<string, unknown> };
      calls.push(call);
      return handler(call, calls.length);
    },
  };
  return { fetchPort, calls };
}

function jsonResponse(status: number, value: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
}

function req(id: number | string, method: string, params: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } };
}

const ctx = (over: Partial<{ idempotent: boolean }> = {}) => ({
  signal: new AbortController().signal,
  idempotent: over.idempotent ?? false,
  timeoutMs: 5000,
});

async function run(t: HttpTransport, r: JsonRpcRequest, c = ctx()) {
  const ex = t.start(r, c);
  const notifications: JsonRpcNotification[] = [];
  const pump = (async () => { for await (const n of ex.notifications) notifications.push(n); })();
  const end = await ex.done;
  await pump;
  return { end, notifications };
}

const URL1 = "http://example.test/mcp";
const ok200 = (call: CapturedCall) => jsonResponse(200, { jsonrpc: "2.0", id: (call.json as { id: unknown }).id, result: { resultType: "complete" } });

describe("requirement evidence H1", () => {
  it("[HTTP-SSEOLD-1] excluded: no legacy HTTP+SSE transport — every wire call is a POST to the configured endpoint, never a GET SSE endpoint", async () => {
    const { fetchPort, calls } = capture(ok200);
    const t = new HttpTransport({ url: URL1, fetchPort });
    await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
    await t.notify({ jsonrpc: "2.0", method: "notifications/custom", params: {} }, ctx());
    // A 2024-11-05 HTTP+SSE client would open a GET stream (typically /sse) and POST elsewhere.
    expect(calls).toHaveLength(2); // the request plus the extension notification, both POSTs
    expect(calls.every((c) => c.method === "POST")).toBe(true);
    expect(calls.every((c) => c.url === URL1)).toBe(true);
    expect(calls.some((c) => c.method === "GET")).toBe(false);
  });

  it("[HTTP-CASE-1] header names compare case-insensitively while values stay case-sensitive", async () => {
    const rec = { "McP-MeThOd": "Tools/Call", "X-CuStOm": "MiXeD-Value" };
    expect(getHeaderCaseInsensitive(rec, "mcp-method")).toBe("Tools/Call");
    expect(getHeaderCaseInsensitive(rec, "MCP-METHOD")).toBe("Tools/Call");
    expect(getHeaderCaseInsensitive(rec, "x-custom")).toBe("MiXeD-Value");
    // Value case is preserved / significant: a lowercased comparison must not match.
    expect(getHeaderCaseInsensitive(rec, "mcp-method")).not.toBe("tools/call");
    expect(getHeaderCaseInsensitive(rec, "absent")).toBeUndefined();
    const h = new Headers({ "Content-Type": "Application/JSON; Charset=UTF-8" });
    expect(getHeaderCaseInsensitive(h, "content-type")).toBe("Application/JSON; Charset=UTF-8");
    // Transport itself honours a differently-cased Content-Type from the peer.
    const t = new HttpTransport({
      url: URL1,
      fetchPort: capture(() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } }), { status: 200, headers: { "CoNtEnT-TyPe": "application/json" } })).fetchPort,
    });
    expect((await run(t, req(1, "tools/list"), ctx({ idempotent: true }))).end.kind).toBe("response");
  });

  it("[HTTP-PARAM-5] tools/call with no inputSchema ever obtained sends no Mcp-Param-* header", async () => {
    const { fetchPort, calls } = capture(ok200);
    const t = new HttpTransport({ url: URL1, fetchPort });
    const { end } = await run(t, req(1, "tools/call", { name: "good", arguments: { tenant: "acme", count: 3 } }));
    expect(end.kind).toBe("response");
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.headers).filter((k) => k.startsWith("mcp-param-"))).toEqual([]);
    expect(t.cachedToolParams("good")).toBeUndefined();
  });

  it("[HTTP-NOTIF-1] cancelling an in-flight request POSTs no notifications/cancelled (abort only)", async () => {
    const srv = await createHttpTestServer({
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(formatSseComment());
      },
    });
    try {
      const t = new HttpTransport({ url: srv.url });
      const ac = new AbortController();
      const ex = t.start(req(1, "tools/call", { name: "w" }), { signal: ac.signal, idempotent: false, timeoutMs: 60_000 });
      setTimeout(() => ac.abort("user"), 30);
      const end = await ex.done;
      expect(end.kind).toBe("failure");
      expect(srv.requests).toHaveLength(1);
      expect((srv.requests[0]!.json as { method?: string }).method).toBe("tools/call");
      expect(JSON.stringify(srv.requests)).not.toContain("notifications/cancelled");
    } finally {
      await srv.close();
    }
  });

  it("[HTTP-RESP-3] 202 to a request is not a result: failure (delivered-no-response), for reads and writes alike", async () => {
    for (const [method, params, idem] of [["tools/list", {}, true], ["tools/call", { name: "w" }, false]] as const) {
      const t = new HttpTransport({ url: URL1, fetchPort: capture(() => new Response(null, { status: 202 })).fetchPort });
      const { end } = await run(t, req(1, method, params), ctx({ idempotent: idem }));
      expect(end).toMatchObject({ kind: "failure", failure: { kind: "http-status", status: 202 }, delivery: "delivered-no-response" });
      if (end.kind === "failure") expect(end.failure.message).toContain("202");
    }
  });

  it("[HTTP-RESP-4] a 2xx whose content-type is neither JSON nor SSE is a protocol-violation failure", async () => {
    for (const ct of ["text/plain", "text/html"]) {
      const t = new HttpTransport({ url: URL1, fetchPort: capture(() => new Response("hi", { status: 200, headers: { "content-type": ct } })).fetchPort });
      const { end } = await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
      expect(end.kind).toBe("failure");
      if (end.kind === "failure") expect(end.failure.message).toContain("protocol-violation");
      expect(end.kind === "failure" && end.failure.message).not.toContain("complete");
    }
  });

  it("[HTTP-ERR-2] 400 with -32021 surfaces as jsonrpc-error refined missing-client-capability, not a transport failure", async () => {
    const make = () => new HttpTransport({
      url: URL1,
      fetchPort: capture((call) => jsonResponse(400, { jsonrpc: "2.0", id: (call.json as { id: unknown }).id, error: { code: -32021, message: "missing capability", data: { requiredCapabilities: ["sampling"] } } })).fetchPort,
    });
    const { end } = await run(make(), req(1, "tools/list"), ctx({ idempotent: true }));
    expect(end).toMatchObject({ kind: "response", message: { error: { code: -32021, data: { requiredCapabilities: ["sampling"] } } } });
    const client = new McpClient({ transport: make(), server: { key: "err2" } });
    const out = await client.request("tools/list", {}, { idempotent: true });
    expect(out).toMatchObject({ kind: "jsonrpc-error", code: -32021, refined: "missing-client-capability" });
    await client.close();
  });

  it("[HTTP-ERR-5] 404 with JSON-RPC -32601 is method-not-found by code/message, not a transport failure", async () => {
    const make = () => new HttpTransport({
      url: URL1,
      fetchPort: capture((call) => jsonResponse(404, { jsonrpc: "2.0", id: (call.json as { id: unknown }).id, error: { code: -32601, message: "no such method" } })).fetchPort,
    });
    const { end } = await run(make(), req(1, "tools/list"), ctx({ idempotent: true }));
    expect(end).toMatchObject({ kind: "response", message: { error: { code: -32601, message: "no such method" } } });
    const client = new McpClient({ transport: make(), server: { key: "err5" } });
    const out = await client.request("tools/list", {}, { idempotent: true });
    expect(out).toMatchObject({ kind: "jsonrpc-error", code: -32601, message: "no such method" });
    expect(out.kind).not.toBe("transport-failure");
    await client.close();
  });

  it("[HTTP-ERR-6] 404/405 without a modern JSON-RPC body yields legacy-or-wrong-endpoint and no initialize fallback", async () => {
    for (const [status, body] of [[404, "nope"], [405, ""]] as const) {
      const { fetchPort, calls } = capture(() => new Response(body, { status }));
      const t = new HttpTransport({ url: URL1, fetchPort });
      const { end } = await run(t, req(1, "tools/list"), ctx({ idempotent: true }));
      expect(end.kind).toBe("failure");
      if (end.kind === "failure") {
        expect(end.failure.message).toContain("legacy-or-wrong-endpoint");
        expect(end.delivery).toBe("not-sent");
      }
      expect(calls).toHaveLength(1); // modern-only: no initialize retry was sent
      expect(JSON.stringify(calls)).not.toContain("initialize");
    }
  });

  it("[HTTP-ERR-7] 413 and 431 are definitive not-executed too-large failures", async () => {
    for (const status of [413, 431]) {
      const t = new HttpTransport({ url: URL1, fetchPort: capture(() => new Response("", { status })).fetchPort });
      const { end } = await run(t, req(1, "tools/call", { name: "w" }));
      expect(end).toMatchObject({ kind: "failure", failure: { kind: "too-large", status }, delivery: "not-sent" });
    }
  });
});
