import { createServer } from "node:http";
import { McpClient, META_PROGRESS_TOKEN } from "@mcp-client/core";
import { HttpTransport } from "@mcp-client/transport-http";
import type { ExchangeFixture } from "@mcp-client/fixtures";
import { writeTranscript, type FixtureResult, type Transcript, type TranscriptFrame } from "./run.js";

/** Fixture id (without the "http/" prefix) -> supported client-side fault injections. */
const OWNED: Record<string, readonly string[]> = {
  "sse-comment-keepalive": ["comment-treated-as-malformed"],
  "sse-id-retry-ignored": ["store-and-resume-with-last-event-id"],
  "sse-multiline-data": ["only-first-data-line-used"],
  "sse-response-progress-then-final": ["drop-progress-notifications", "treat-sse-as-error"],
};

interface Recorded { readonly method: string; readonly headers: Record<string, string>; readonly body: string }

class AssertionMismatch extends Error {}
function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new AssertionMismatch(msg); }

async function bounded<T>(p: PromiseLike<T>, operation: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${operation}`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Reads a whole SSE body and rebuilds the response with `edit` applied to its text. */
async function rewrite(res: Response, edit: (text: string) => string): Promise<Response> {
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
  const text = await res.text();
  return new Response(edit(text), { status: res.status, headers: res.headers });
}

/** Wraps the real fetch with the mutant's fault injection on the SSE response stream. */
function faultyFetch(mutant: string | undefined): Fetch {
  const base: Fetch = (input, init) => fetch(input, init);
  switch (mutant) {
    case undefined: return base;
    case "comment-treated-as-malformed":
      // A parser that rejects comment lines breaks the stream at the first ": ..." line.
      return async (input, init) => {
        const res = await base(input, init);
        if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
        const text = await res.text();
        const at = text.search(/^:/m);
        if (at < 0) return new Response(text, { status: res.status, headers: res.headers });
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(text.slice(0, at)));
            c.error(new TypeError("mutant: SSE comment treated as malformed"));
          },
        });
        return new Response(body, { status: res.status, headers: res.headers });
      };
    case "store-and-resume-with-last-event-id":
      // Stores the event id and reconnects with GET + Last-Event-ID after honoring retry.
      return async (input, init) => {
        const res = await base(input, init);
        return rewrite(res, text => {
          const id = /^id: ?(.*)$/m.exec(text)?.[1];
          if (id !== undefined) {
            void base(input, { method: "GET", headers: { Accept: "text/event-stream", "Last-Event-ID": id } })
              .then(r => r.arrayBuffer()).catch(() => undefined);
          }
          return text;
        });
      };
    case "only-first-data-line-used":
      return async (input, init) => rewrite(await base(input, init), text =>
        text.split(/\n\n/).map(ev => {
          let seen = false;
          return ev.split("\n").filter(l => !l.startsWith("data:") || (!seen && (seen = true))).join("\n");
        }).join("\n\n"));
    case "drop-progress-notifications":
      return async (input, init) => rewrite(await base(input, init), text =>
        text.split(/\n\n/).filter(ev => !ev.includes("notifications/progress")).join("\n\n"));
    case "treat-sse-as-error":
      return async (input, init) => {
        const res = await base(input, init);
        if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
        await res.arrayBuffer().catch(() => undefined);
        throw new TypeError("mutant: text/event-stream responses rejected");
      };
    default:
      throw new Error(`Unsupported mutant ${mutant}`);
  }
}

/** SSE body the server streams for each fixture: the final response event is always last. */
function sseBody(name: string, id: unknown, progressToken: unknown, result: unknown): string[] {
  const final = JSON.stringify({ jsonrpc: "2.0", id, result });
  switch (name) {
    case "sse-comment-keepalive":
      return [": keepalive\n\n", ": keepalive\n", `data: ${final}\n\n`];
    case "sse-id-retry-ignored":
      return [`id: evt-1\nretry: 10\ndata: ${final}\n\n`];
    case "sse-multiline-data": {
      // Split mid-object so that no single data line is valid JSON on its own.
      const cut = final.indexOf(",") + 1;
      return [`data: ${final.slice(0, cut)}\ndata: ${final.slice(cut)}\n\n`];
    }
    case "sse-response-progress-then-final": {
      const progress = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: 1, total: 2 } });
      return [`data: ${progress}\n\n`, `data: ${final}\n\n`];
    }
    default:
      throw new Error(`no SSE body for ${name}`);
  }
}

function serialize(r: Recorded): string {
  return [r.method, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`), r.body].join("\n");
}

interface Observed {
  readonly outcomes: Record<string, Record<string, unknown>>;
  readonly wire: readonly Recorded[];
  /** Ordered client-side events: "progress" and "settled:<as>". */
  readonly events: readonly string[];
  readonly results: ReadonlyMap<string, unknown>;
  readonly frames: readonly TranscriptFrame[];
  readonly mcpEndpoint: string;
}

function verify(name: string, fx: ExchangeFixture, { outcomes, wire, events, results }: Observed) {
  for (const [as, expected] of Object.entries(fx.expect.outcome ?? {})) {
    const actual = outcomes[as];
    check(actual, `missing outcome ${as}`);
    for (const [k, v] of Object.entries(expected)) {
      check(JSON.stringify(actual[k]) === JSON.stringify(v), `outcome ${as}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`);
    }
    // The decoded SSE payload must be the scripted result verbatim (HTTP-RESP-2).
    if (actual["kind"] === "ok" && results.has(as)) {
      check(JSON.stringify(actual["value"]) === JSON.stringify(results.get(as)), `outcome ${as}.value: expected ${JSON.stringify(results.get(as))}, got ${JSON.stringify(actual["value"])}`);
    }
  }
  const w = fx.expect.wire;
  if (w?.totalRequests !== undefined) check(wire.length === w.totalRequests, `totalRequests: expected ${w.totalRequests}, got ${wire.length}`);
  for (const needle of w?.never ?? []) {
    for (const r of wire) {
      const hit = r.method === needle
        || Object.entries(r.headers).some(([k, v]) => `${k}: ${v}`.toLowerCase().includes(needle.toLowerCase()))
        || r.body.includes(needle);
      check(!hit, `wire contains forbidden ${JSON.stringify(needle)}: ${serialize(r)}`);
    }
  }
  let index = 0;
  for (const step of fx.script) {
    if (!("expect" in step)) continue;
    const r = wire[step.index ?? index++];
    check(r, `no wire request at index ${step.index ?? index - 1}`);
    const msg = JSON.parse(r.body) as Record<string, unknown>;
    for (const [k, v] of Object.entries(step.match ?? {})) {
      check(JSON.stringify(msg[k]) === JSON.stringify(v), `wire[${step.index}].${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(msg[k])}`);
    }
  }
  // HTTP-SSE-3 / HTTP-NORESUME-1: id/retry are discarded; only POSTs, never Last-Event-ID.
  for (const r of wire) {
    check(r.method === "POST", `non-POST request ${r.method} after SSE stream`);
    check(!Object.keys(r.headers).some(k => k.toLowerCase() === "last-event-id"), "Last-Event-ID sent");
  }
  // HTTP-SSE-5 / HTTP-RESP-2: progress on the request's stream is delivered before the final result.
  if (name === "sse-response-progress-then-final") {
    const p = events.indexOf("progress");
    const s = events.findIndex(e => e.startsWith("settled:"));
    check(p >= 0, "progress notification not delivered");
    check(s < 0 || p < s, "progress delivered after the final result");
  }
}

function parseJson(body: string): unknown {
  if (body.length === 0) return undefined;
  try { return JSON.parse(body); } catch { return undefined; }
}

function parseSseMessages(raw: string): unknown[] {
  const out: unknown[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        dataLines.push(line.startsWith("data: ") ? line.slice(6) : line.slice(5));
      }
    }
    if (dataLines.length === 0) continue;
    try { out.push(JSON.parse(dataLines.join("\n"))); } catch { /* ignore non-JSON SSE event */ }
  }
  return out;
}

async function exercise(name: string, fx: ExchangeFixture, mutant: string | undefined): Promise<Observed> {
  const wire: Recorded[] = [];
  const frames: TranscriptFrame[] = [];
  let mcpEndpoint = "";
  const events: string[] = [];
  const results = new Map<string, unknown>();
  for (const step of fx.script) if ("server" in step && step.for && step.server === "result") results.set(step.for, step.result);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const headers: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i]!] = req.rawHeaders[i + 1]!;
    wire.push({ method: req.method ?? "", headers, body });
    const parsed = parseJson(body);
    frames.push({
      direction: "client",
      endpoint: "mcp",
      ...(req.method ? { method: req.method } : {}),
      url: new URL(req.url ?? "/mcp", mcpEndpoint).toString(),
      headers,
      ...(parsed !== undefined ? { message: parsed } : {}),
    } as TranscriptFrame);
    if (req.method !== "POST") {
      frames.push({ direction: "server", endpoint: "mcp", headers: {} } as TranscriptFrame);
      res.writeHead(405).end();
      return;
    }
    const accept = req.headers.accept ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      frames.push({ direction: "server", endpoint: "mcp", headers: {} } as TranscriptFrame);
      res.writeHead(406).end();
      return;
    }
    let msg: { id?: unknown; params?: { _meta?: Record<string, unknown> } };
    try { msg = JSON.parse(body); } catch {
      frames.push({ direction: "server", endpoint: "mcp", headers: {} } as TranscriptFrame);
      res.writeHead(400).end();
      return;
    }
    if (msg.id === undefined) {
      frames.push({ direction: "server", endpoint: "mcp", headers: {} } as TranscriptFrame);
      res.writeHead(202).end();
      return;
    }
    const result = [...results.values()][0] ?? {};
    const resHeaders = { "content-type": "text/event-stream", "cache-control": "no-cache" };
    const parts = sseBody(name, msg.id, msg.params?._meta?.[META_PROGRESS_TOKEN] ?? msg.id, result);
    const sseMsgs = parseSseMessages(parts.join(""));
    if (sseMsgs.length === 0) {
      frames.push({ direction: "server", endpoint: "mcp", headers: resHeaders } as TranscriptFrame);
    } else {
      for (const sseMsg of sseMsgs) {
        frames.push({ direction: "server", endpoint: "mcp", headers: resHeaders, message: sseMsg } as TranscriptFrame);
      }
    }
    res.writeHead(200, resHeaders);
    for (const part of parts) res.write(part);
    res.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no server address");
  mcpEndpoint = `http://127.0.0.1:${addr.port}/mcp`;
  let id = 0;
  const transport = new HttpTransport({ url: mcpEndpoint, fetchFn: faultyFetch(mutant) });
  const client = new McpClient({ transport, server: { key: "fixture" }, idGenerator: () => ++id });
  const outcomes: Record<string, Record<string, unknown>> = {};
  try {
    for (const step of fx.script) {
      if ("do" in step && step.do === "call") {
        const out = await bounded(client.request(step.method, step.params ?? {}, {
          idempotent: step.idempotent ?? false,
          onProgress: () => { events.push("progress"); },
        }), step.method);
        events.push(`settled:${step.as}`);
        outcomes[step.as] = out as unknown as Record<string, unknown>;
      }
    }
    // Let any stray reconnect reach the server before the wire is judged.
    await new Promise(resolve => setTimeout(resolve, 50));
    return { outcomes, wire, events, results, frames, mcpEndpoint };
  } finally {
    try { await bounded(client.close(), "client close"); } finally {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await bounded(stopped, "server close");
    }
  }
}

export async function runTierBHttpSseFixture(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  const name = fixture.id.startsWith("http/") ? fixture.id.slice(5) : undefined;
  const supported = name !== undefined ? OWNED[name] : undefined;
  if (name === undefined || !supported) return undefined;
  const base = { id: fixture.id, ...(mutant !== undefined && { mutant }) };
  if (mutant !== undefined && !supported.includes(mutant)) return { ...base, ok: false, error: `Unsupported mutant ${mutant}` };
  try {
    if (!fixture.script.some(s => "do" in s && s.do === "call")) throw new Error("fixture script has no call");
    const observed = await exercise(name, fixture, mutant);
    if (mutant === undefined) {
      writeTranscript({ fixture: fixture.id, mcpEndpoint: observed.mcpEndpoint, frames: observed.frames } as Transcript);
    }
    verify(name, fixture, observed);
    return { ...base, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof AssertionMismatch
      ? { ...base, ok: false, failure: "assertion", error: message }
      : { ...base, ok: false, error: message };
  }
}
