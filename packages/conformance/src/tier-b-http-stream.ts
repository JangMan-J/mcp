import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpClient } from "@mcp-client/core";
import { HttpTransport } from "@mcp-client/transport-http";
import type { ExchangeFixture } from "@mcp-client/fixtures";
import type { FixtureResult } from "./run.js";

/** Fixture id (without the "http/" prefix) -> supported client-side fault injections. */
const OWNED: Record<string, readonly string[]> = {
  "abort-closes-stream": ["send-notifications-cancelled-on-abort"],
  "sse-request-on-stream-violation": ["reply-to-server-request-on-stream"],
  "stream-break-read-reissue-new-id": ["reuse-id-after-stream-break"],
};

/**
 * Fixture files that script only a plain c1 round trip; the per-id behavior is exercised by this
 * runner as a separate request phase after c1 is asserted.
 */
export const THIN_FIXTURES: Record<string, string> = {
  "http/abort-closes-stream": "script has no abort; runner aborts an in-flight SSE tools/call separately (HTTP-CANCEL-1)",
  "http/sse-request-on-stream-violation": "script has no server request on SSE; runner sends one separately (HTTP-SSE-4)",
  "http/stream-break-read-reissue-new-id": "script has no stream break; runner breaks an SSE read and reissues separately (HTTP-RETRY-1)",
};

interface Recorded { readonly method: string; readonly headers: Record<string, string>; readonly body: string }
type Handler = (req: IncomingMessage, res: ServerResponse, msg: { id?: unknown; method?: string }, wire: Recorded[]) => void;
type Fetch = (input: string, init: RequestInit) => Promise<Response>;

class AssertionMismatch extends Error {}
function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new AssertionMismatch(msg); }

async function bounded<T>(p: PromiseLike<T>, operation: string, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${operation}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const base: Fetch = (input, init) => fetch(input, init);
const sse = (msg: unknown, id?: string) => `${id !== undefined ? `id: ${id}\n` : ""}data: ${JSON.stringify(msg)}\n\n`;

/** Wraps the real fetch with the mutant's fault injection. */
function faultyFetch(mutant: string | undefined): Fetch {
  switch (mutant) {
    case undefined: return base;
    case "send-notifications-cancelled-on-abort":
      return (input, init) => {
        const id = (() => { try { return (JSON.parse(String(init.body)) as { id?: unknown }).id; } catch { return undefined; } })();
        init.signal?.addEventListener("abort", () => {
          const body = JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } });
          void base(input, { method: "POST", headers: new Headers(init.headers), body }).then(r => r.arrayBuffer()).catch(() => undefined);
        }, { once: true });
        return base(input, init);
      };
    case "reply-to-server-request-on-stream":
      return async (input, init) => {
        const res = await base(input, init);
        if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
        const text = await res.text();
        for (const line of text.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const m = JSON.parse(line.slice(5)) as { id?: unknown; method?: string };
          if (m.method !== undefined && m.id !== undefined) {
            const reply = JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} });
            await (await base(input, { method: "POST", headers: new Headers(init.headers), body: reply })).arrayBuffer().catch(() => undefined);
          }
        }
        return new Response(text, { status: res.status, headers: res.headers });
      };
    case "reuse-id-after-stream-break": {
      let firstId: unknown;
      return (input, init) => {
        const msg = JSON.parse(String(init.body)) as { id?: unknown };
        if (msg.id !== undefined) {
          if (firstId === undefined) firstId = msg.id;
          else init = { ...init, body: JSON.stringify({ ...msg, id: firstId }) };
        }
        return base(input, init);
      };
    }
    default:
      throw new Error(`Unsupported mutant ${mutant}`);
  }
}

function serialize(r: Recorded): string {
  return [r.method, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`), r.body].join("\n");
}

function checkNever(needles: readonly string[], wire: readonly Recorded[]) {
  for (const needle of needles) {
    for (const r of wire) {
      const hit = r.method === needle
        || Object.entries(r.headers).some(([k, v]) => `${k}: ${v}`.toLowerCase().includes(needle.toLowerCase()))
        || r.body.includes(needle);
      check(!hit, `wire contains forbidden ${JSON.stringify(needle)}: ${serialize(r)}`);
    }
  }
}

/** Runs `body` against a loopback server driven by `handler`, recording every inbound request. */
async function withServer<T>(handler: Handler, mutant: string | undefined, body: (client: McpClient, wire: Recorded[]) => Promise<T>): Promise<T> {
  const wire: Recorded[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString("utf8");
    const headers: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i]!] = req.rawHeaders[i + 1]!;
    wire.push({ method: req.method ?? "", headers, body: text });
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let msg: { id?: unknown; method?: string };
    try { msg = JSON.parse(text); } catch { res.writeHead(400).end(); return; }
    if (msg.id === undefined || msg.method === undefined) { res.writeHead(202).end(); return; }
    handler(req, res, msg, wire);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no server address");
  let id = 0;
  const transport = new HttpTransport({ url: `http://127.0.0.1:${addr.port}/mcp`, fetchFn: faultyFetch(mutant) });
  const client = new McpClient({ transport, server: { key: "fixture" }, idGenerator: () => ++id });
  try {
    return await body(client, wire);
  } finally {
    try { await bounded(client.close(), "client close"); } finally {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await bounded(stopped, "server close");
    }
  }
}

/** c1: the fixture's own script and expectations (plain SSE round trip). */
async function runScript(fx: ExchangeFixture, mutant: string | undefined) {
  const scripted = fx.script.find(s => "server" in s) as Record<string, unknown> | undefined;
  const reply = scripted?.["server"] === "error" ? { error: scripted["error"] } : { result: scripted?.["result"] ?? {} };
  await withServer((_req, res, msg) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse({ jsonrpc: "2.0", id: msg.id, ...reply }));
  }, mutant, async (client, wire) => {
    const outcomes: Record<string, Record<string, unknown>> = {};
    for (const step of fx.script) {
      if ("do" in step && step.do === "call") {
        outcomes[step.as] = await bounded(client.request(step.method, step.params ?? {}, { idempotent: step.idempotent ?? false }), step.method) as unknown as Record<string, unknown>;
      }
    }
    for (const [as, expected] of Object.entries(fx.expect.outcome ?? {})) {
      const actual = outcomes[as];
      check(actual, `missing outcome ${as}`);
      for (const [k, v] of Object.entries(expected)) {
        check(JSON.stringify(actual[k]) === JSON.stringify(v), `outcome ${as}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`);
      }
    }
    const w = fx.expect.wire;
    if (w?.totalRequests !== undefined) check(wire.length === w.totalRequests, `totalRequests: expected ${w.totalRequests}, got ${wire.length}`);
    checkNever(w?.never ?? [], wire);
    let index = 0;
    for (const step of fx.script) {
      if (!("expect" in step)) continue;
      const r = wire[step.index ?? index++];
      check(r, `no wire request at index ${step.index ?? index - 1}`);
      const m = JSON.parse(r.body) as Record<string, unknown>;
      for (const [k, v] of Object.entries(step.match ?? {})) {
        check(JSON.stringify(m[k]) === JSON.stringify(v), `wire.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(m[k])}`);
      }
    }
  });
}

/** HTTP-CANCEL-1: abort closes that request's response stream and does not send notifications/cancelled. */
async function abortClosesStream(fx: ExchangeFixture, mutant: string | undefined) {
  let received!: () => void;
  const gotRequest = new Promise<void>(resolve => { received = resolve; });
  let closed!: () => void;
  const streamClosed = new Promise<void>(resolve => { closed = resolve; });
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": open\n\n");
    res.on("close", () => closed());
    received();
  }, mutant, async (client, wire) => {
    const ac = new AbortController();
    const call = client.request("tools/call", { name: "slow" }, { idempotent: false, signal: ac.signal });
    await bounded(gotRequest, "server saw tools/call");
    ac.abort();
    const outcome = await bounded(call, "aborted tools/call") as unknown as Record<string, unknown>;
    check(outcome["kind"] !== "ok", `aborted call settled ok`);
    await bounded(streamClosed, "server observed response stream close").catch(e => { throw new AssertionMismatch(String(e)); });
    await delay(150); // let any stray cancel notification arrive
    check(!wire.some(r => r.body.includes("notifications/cancelled")), "client sent notifications/cancelled on HTTP abort (HTTP-CANCEL-1)");
    check(wire.length === 1, `abort phase: expected 1 request, got ${wire.length}`);
    checkNever(fx.expect.wire?.never ?? [], wire);
  });
}

/** HTTP-SSE-4: an independent JSON-RPC request on the response SSE stream is a violation; no reply. */
async function requestOnStream(fx: ExchangeFixture, mutant: string | undefined) {
  const serverRequestId = "srv-req-1";
  await withServer((_req, res, msg) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(sse({ jsonrpc: "2.0", id: serverRequestId, method: "sampling/createMessage", params: {} }));
    res.end(sse({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }));
  }, mutant, async (client, wire) => {
    const outcome = await bounded(client.request("tools/list", {}, { idempotent: true }), "tools/list") as unknown as Record<string, unknown>;
    check(outcome["kind"] !== "ok", "server request on SSE stream was accepted (HTTP-SSE-4)");
    check(JSON.stringify(outcome).includes("protocol-violation"), `expected protocol-violation, got ${JSON.stringify(outcome)}`);
    await delay(100);
    check(!wire.some(r => r.body.includes(serverRequestId)), "client replied to a server request on the SSE stream (HTTP-SSE-4)");
    check(wire.length === 1, `violation phase: expected 1 request, got ${wire.length}`);
    checkNever(fx.expect.wire?.never ?? [], wire);
  });
}

/** HTTP-RETRY-1: a broken response stream loses the request; a reissued read uses a new id (no resume). */
async function streamBreakReissue(fx: ExchangeFixture, mutant: string | undefined) {
  let posts = 0;
  await withServer((_req, res, msg) => {
    posts += 1;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (posts === 1) {
      // An SSE event id invites resumption; the client must not use it (no GET / Last-Event-ID).
      res.write(sse({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } }, "evt-1"));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(sse({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } }));
  }, mutant, async (client, wire) => {
    const first = await bounded(client.request("tools/list", {}, { idempotent: true }), "tools/list") as unknown as Record<string, unknown>;
    check(first["kind"] === "transport-failure", `broken stream: expected transport-failure, got ${JSON.stringify(first)}`);
    check(first["safeToRetry"] === true, "broken read not marked safeToRetry");
    const second = await bounded(client.request("tools/list", {}, { idempotent: true }), "tools/list reissue") as unknown as Record<string, unknown>;
    check(wire.length === 2, `reissue phase: expected 2 requests, got ${wire.length}`);
    const ids = wire.map(r => (JSON.parse(r.body) as { id?: unknown }).id);
    check(ids[0] !== undefined && JSON.stringify(ids[0]) !== JSON.stringify(ids[1]), `reissued read reused id ${JSON.stringify(ids[1])} (HTTP-RETRY-1)`);
    check(second["kind"] === "ok", `reissued read: expected ok, got ${JSON.stringify(second)}`);
    checkNever(fx.expect.wire?.never ?? [], wire);
  });
}

const OBSERVE: Record<string, (fx: ExchangeFixture, mutant: string | undefined) => Promise<void>> = {
  "abort-closes-stream": abortClosesStream,
  "sse-request-on-stream-violation": requestOnStream,
  "stream-break-read-reissue-new-id": streamBreakReissue,
};

export async function runTierBHttpStreamFixture(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  const name = fixture.id.startsWith("http/") ? fixture.id.slice(5) : undefined;
  const supported = name !== undefined ? OWNED[name] : undefined;
  if (!name || !supported) return undefined;
  const base = { id: fixture.id, ...(mutant !== undefined && { mutant }) };
  if (mutant !== undefined && !supported.includes(mutant)) return { ...base, ok: false, error: `Unsupported mutant ${mutant}` };
  try {
    if (!fixture.script.some(s => "do" in s && s.do === "call")) throw new Error("fixture script has no call");
    await runScript(fixture, mutant);
    await OBSERVE[name]!(fixture, mutant);
    return { ...base, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof AssertionMismatch
      ? { ...base, ok: false, failure: "assertion", error: message }
      : { ...base, ok: false, error: message };
  }
}
