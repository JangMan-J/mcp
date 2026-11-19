import { describe, expect, it } from "vitest";
import { McpClient, type FetchPort, type JsonRpcNotification, type JsonRpcRequest } from "@mcp-client/core";
import { HttpTransport, SseParser } from "../src/index.js";

const URL1 = "http://example.test/mcp";

function fetchOf(handler: (json: Record<string, unknown>, headers: Record<string, string>) => Response): {
  fetchPort: FetchPort;
  headers: Record<string, string>[];
} {
  const headers: Record<string, string>[] = [];
  return {
    headers,
    fetchPort: {
      fetch: async (_input, init) => {
        const h: Record<string, string> = {};
        new Headers(init.headers).forEach((v, k) => (h[k] = v));
        headers.push(h);
        return handler(JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>, h);
      },
    },
  };
}

function chunkedSse(chunks: Uint8Array[]): Response {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= chunks.length) c.close();
      else c.enqueue(chunks[i++]!);
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function req(id: number, method: string, params: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } };
}
const ctx = (idempotent = false) => ({ signal: new AbortController().signal, idempotent, timeoutMs: 5000 });

async function run(t: HttpTransport, r: JsonRpcRequest, c = ctx()) {
  const ex = t.start(r, c);
  const notes: JsonRpcNotification[] = [];
  const pump = (async () => { for await (const n of ex.notifications) notes.push(n); })();
  const end = await ex.done;
  await pump;
  return { end, notes };
}

describe("edge cases part 2 (http)", () => {
  it("[EDGE-19] SSE data split mid-UTF-8 across chunks is reassembled into one event", async () => {
    const text = "data: {\"t\":\"é🌍日本\"}\n\n";
    const bytes = new TextEncoder().encode(text);
    const cut = text.indexOf("é") + 1; // inside the 2-byte é
    const p = new SseParser();
    const evs = [...p.push(bytes.subarray(0, cut)), ...p.push(bytes.subarray(cut, cut + 3)), ...p.push(bytes.subarray(cut + 3)), ...p.end()];
    expect(evs).toHaveLength(1);
    expect(JSON.parse((evs[0] as { data: string }).data)).toEqual({ t: "é🌍日本" });

    // Through the transport, byte-at-a-time chunks.
    const full = new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{"resultType":"complete","t":"é🌍"}}\n\n');
    const chunks = Array.from(full, (b) => Uint8Array.of(b));
    const t = new HttpTransport({ url: URL1, fetchPort: fetchOf(() => chunkedSse(chunks)).fetchPort });
    const { end } = await run(t, req(1, "tools/list"), ctx(true));
    expect(end).toMatchObject({ kind: "response", message: { result: { t: "é🌍" } } });
  });

  it("[EDGE-20] a non-JSON SSE data payload is dropped; request fails only if no response arrives", async () => {
    const enc = new TextEncoder();
    const good = 'data: not json {\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"resultType":"complete","ok":true}}\n\n';
    const t1 = new HttpTransport({ url: URL1, fetchPort: fetchOf(() => chunkedSse([enc.encode(good)])).fetchPort });
    const r1 = await run(t1, req(1, "tools/list"), ctx(true));
    expect(r1.end).toMatchObject({ kind: "response", message: { result: { ok: true } } });

    const bad = "data: not json {\n\n";
    const t2 = new HttpTransport({ url: URL1, fetchPort: fetchOf(() => chunkedSse([enc.encode(bad)])).fetchPort });
    const r2 = await run(t2, req(1, "tools/list"), ctx(true));
    expect(r2.end.kind).toBe("failure");
  });

  it("[EDGE-21] HTTP 200 with an empty body: failure for reads, uncertain-write for writes", async () => {
    const empty = () => new Response("", { status: 200, headers: { "content-type": "application/json" } });
    const client = new McpClient({ transport: new HttpTransport({ url: URL1, fetchPort: fetchOf(empty).fetchPort }), server: { key: "e" } });
    const write = await client.request("tools/call", { name: "w", arguments: {} });
    expect(write.kind).toBe("uncertain-write");
    const read = await client.request("tools/list", {}, { idempotent: true });
    expect(read.kind).not.toBe("ok");
    expect(read.kind).not.toBe("uncertain-write");
    await client.close();
  });

  it("[EDGE-22] non-ASCII Mcp-Name uses the base64 sentinel", async () => {
    const f = fetchOf((json) => new Response(JSON.stringify({ jsonrpc: "2.0", id: json["id"], result: { resultType: "complete" } }), { status: 200, headers: { "content-type": "application/json" } }));
    const t = new HttpTransport({ url: URL1, fetchPort: f.fetchPort });
    await run(t, req(1, "tools/call", { name: "工具", arguments: {} }));
    await run(t, req(2, "tools/call", { name: "plain", arguments: {} }));
    expect(f.headers[0]!["mcp-name"]).toBe("=?base64?5bel5YW3?=");
    expect(f.headers[1]!["mcp-name"]).toBe("plain");
  });
});
