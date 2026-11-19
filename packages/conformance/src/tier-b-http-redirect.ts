import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpClient } from "@mcp-client/core";
import { HttpTransport } from "@mcp-client/transport-http";
import type { ExchangeFixture } from "@mcp-client/fixtures";
import { writeTranscript, type FixtureResult, type Transcript, type TranscriptFrame } from "./run.js";

/** Fixture id (without the "http/" prefix) -> supported client-side fault injections. */
const OWNED: Record<string, readonly string[]> = {
  "redirect-cross-origin-refused": ["follow-cross-origin-redirect-with-auth"],
  "stream-break-write-uncertain": ["silently-retry-write-after-break"],
};

/**
 * Fixtures whose own expectations cannot kill their mutants (the scripted server never redirects
 * or breaks a stream); this runner adds a per-id observation in a separate client.
 */
export const THIN_FIXTURES: Record<string, string> = {
  "http/redirect-cross-origin-refused":
    "fixture server never redirects; observation: 307 to a second loopback origin must not be followed and Authorization never reaches it (HTTP-REDIR-1)",
  "http/stream-break-write-uncertain":
    "fixture server never breaks the stream; observation: SSE headers then socket destroy on a non-idempotent tools/call yields uncertain-write with exactly one POST (HTTP-AMBIG-1, HTTP-AMBIG-2)",
};

type HttpEndpoint = "mcp" | "oauth" | "registration" | "other";
type HttpTranscriptFrame = TranscriptFrame & { readonly endpoint?: HttpEndpoint };
interface TranscriptSink {
  readonly frames: HttpTranscriptFrame[];
  setEndpoint(url: string): void;
}

interface Recorded { readonly method: string; readonly headers: Record<string, string>; readonly body: string }

function tryParseJson(text: string): unknown | undefined {
  try { return JSON.parse(text); } catch { return undefined; }
}

function parseSseEvent(block: string): unknown | undefined {
  const dataLines: string[] = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith("data:")) {
      const value = rawLine.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (dataLines.length === 0) return undefined;
  return tryParseJson(dataLines.join("\n"));
}

function instrumentResponse(res: ServerResponse, endpoint: HttpEndpoint, sink: TranscriptSink) {
  const responseHeaders: Record<string, string> = {};
  const bodyChunks: Buffer[] = [];
  let sseBuffer = "";
  let emittedServerFrame = false;

  const isSse = () => Object.entries(responseHeaders).some(([k, v]) => k.toLowerCase() === "content-type" && v.includes("text/event-stream"));

  const emitSseBlocks = (flush: boolean) => {
    const parts = sseBuffer.split(/\r?\n\r?\n/);
    sseBuffer = flush ? "" : (parts.pop() ?? "");
    for (const block of parts) {
      if (!block.trim()) continue;
      const parsed = parseSseEvent(block);
      if (parsed !== undefined) {
        sink.frames.push({
          direction: "server",
          endpoint,
          ...(Object.keys(responseHeaders).length > 0 && { headers: { ...responseHeaders } }),
          message: parsed,
        });
        emittedServerFrame = true;
      }
    }
  };

  const recordChunk = (chunk: unknown, encoding?: BufferEncoding) => {
    if (chunk === undefined || chunk === null || typeof chunk === "function") return;
    const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk as Uint8Array);
    if (isSse()) {
      sseBuffer += buf.toString("utf8");
      emitSseBlocks(false);
    } else {
      bodyChunks.push(buf);
    }
  };

  const flushOnClose = () => {
    if (emittedServerFrame || Object.keys(responseHeaders).length === 0) return;
    sink.frames.push({ direction: "server", endpoint, headers: { ...responseHeaders } });
    emittedServerFrame = true;
  };
  res.once("close", flushOnClose);

  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = ((statusCode: number, ...args: unknown[]) => {
    const rawHeaders = typeof args[0] === "string" ? args[1] : args[0];
    if (rawHeaders && typeof rawHeaders === "object") {
      if (Array.isArray(rawHeaders)) {
        for (let i = 0; i < rawHeaders.length; i += 2) responseHeaders[String(rawHeaders[i])] = String(rawHeaders[i + 1] ?? "");
      } else {
        for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
          if (v !== undefined) responseHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
        }
      }
    }
    return (origWriteHead as (...a: unknown[]) => ServerResponse)(statusCode, ...args);
  }) as ServerResponse["writeHead"];

  const origWrite = res.write.bind(res);
  res.write = ((chunk: unknown, ...args: unknown[]) => {
    recordChunk(chunk, typeof args[0] === "string" ? (args[0] as BufferEncoding) : undefined);
    return (origWrite as (...a: unknown[]) => boolean)(chunk, ...args);
  }) as ServerResponse["write"];

  const origEnd = res.end.bind(res);
  res.end = ((...args: unknown[]) => {
    const chunk = typeof args[0] === "function" ? undefined : args[0];
    const encoding = typeof args[1] === "string" ? (args[1] as BufferEncoding) : undefined;
    recordChunk(chunk, encoding);
    if (isSse()) {
      emitSseBlocks(true);
      if (!emittedServerFrame && Object.keys(responseHeaders).length > 0) {
        sink.frames.push({ direction: "server", endpoint, headers: { ...responseHeaders } });
        emittedServerFrame = true;
      }
    } else {
      const text = Buffer.concat(bodyChunks).toString("utf8");
      const parsed = text ? tryParseJson(text) : undefined;
      if (Object.keys(responseHeaders).length > 0 || parsed !== undefined) {
        sink.frames.push({
          direction: "server",
          endpoint,
          ...(Object.keys(responseHeaders).length > 0 && { headers: { ...responseHeaders } }),
          ...(parsed !== undefined && { message: parsed }),
        });
        emittedServerFrame = true;
      }
    }
    return (origEnd as (...a: unknown[]) => ServerResponse)(...args);
  }) as ServerResponse["end"];
}

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

/** Wraps the real fetch with the mutant's fault injection. */
function faultyFetch(mutant: string | undefined): Fetch {
  const base: Fetch = (input, init) => fetch(input, init);
  switch (mutant) {
    case undefined: return base;
    case "follow-cross-origin-redirect-with-auth":
      // Follows any redirect itself, carrying the original headers (including Authorization).
      return async (input, init) => {
        const res = await base(input, init);
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          await res.arrayBuffer().catch(() => undefined);
          return base(new URL(location, input).toString(), init);
        }
        return res;
      };
    case "silently-retry-write-after-break":
      // Buffers the body; if the stream breaks, re-POSTs the same write.
      return async (input, init) => {
        const res = await base(input, init);
        try {
          const buf = await res.arrayBuffer();
          return new Response(buf, { status: res.status, headers: res.headers });
        } catch {
          return base(input, init);
        }
      };
    default:
      throw new Error(`Unsupported mutant ${mutant}`);
  }
}

function serialize(r: Recorded): string {
  return [r.method, ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`), r.body].join("\n");
}

function verify(fx: ExchangeFixture, outcomes: Record<string, Record<string, unknown>>, wire: readonly Recorded[]) {
  for (const [as, expected] of Object.entries(fx.expect.outcome ?? {})) {
    const actual = outcomes[as];
    check(actual, `missing outcome ${as}`);
    for (const [k, v] of Object.entries(expected)) {
      check(JSON.stringify(actual[k]) === JSON.stringify(v), `outcome ${as}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual[k])}`);
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
}

type Handler = (req: IncomingMessage, res: ServerResponse, msg: { id?: unknown; method?: string }) => void;

/** Loopback server that records every request, then hands JSON-RPC requests to `handle`. */
async function startServer(
  wire: Recorded[],
  handle: Handler,
  recording?: { sink: TranscriptSink; endpoint: HttpEndpoint },
): Promise<{ server: Server; url: string }> {
  let serverUrl = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const headers: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i]!] = req.rawHeaders[i + 1]!;
    wire.push({ method: req.method ?? "", headers, body });
    if (recording) {
      const parsed = body ? tryParseJson(body) : undefined;
      recording.sink.frames.push({
        direction: "client",
        endpoint: recording.endpoint,
        ...(req.method ? { method: req.method } : {}),
        url: new URL(req.url ?? "/mcp", serverUrl).toString(),
        headers,
        ...(parsed !== undefined && { message: parsed }),
      });
      instrumentResponse(res, recording.endpoint, recording.sink);
    }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let msg: { id?: unknown; method?: string };
    try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    handle(req, res, msg);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const addr = server.address();
  if (!addr || typeof addr !== "object") throw new Error("no server address");
  serverUrl = `http://127.0.0.1:${addr.port}/mcp`;
  if (recording?.endpoint === "mcp") recording.sink.setEndpoint(serverUrl);
  return { server, url: serverUrl };
}

async function stopServer(server: Server): Promise<void> {
  const stopped = new Promise<void>(resolve => server.close(() => resolve()));
  server.closeAllConnections();
  await bounded(stopped, "server close");
}

function replyJson(res: ServerResponse, id: unknown, scripted: Record<string, unknown>) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, ...scripted }));
}

function scriptedResult(fx: ExchangeFixture): Record<string, unknown> {
  for (const step of fx.script) if ("server" in step && step.for) return step.server === "result" ? { result: step.result } : { error: step.error };
  return { result: {} };
}

async function withClient<T>(url: string, mutant: string | undefined, extra: Record<string, string>, run: (c: McpClient) => Promise<T>, servers: Server[]): Promise<T> {
  let id = 0;
  const transport = new HttpTransport({ url, fetchFn: faultyFetch(mutant), extraHeaders: extra });
  const client = new McpClient({ transport, server: { key: "fixture" }, idGenerator: () => ++id });
  try {
    return await run(client);
  } finally {
    try { await bounded(client.close(), "client close"); } finally {
      await Promise.all(servers.map(stopServer));
    }
  }
}

/** The fixture's own (thin) script against a well-behaved loopback server. */
async function exercise(fx: ExchangeFixture, mutant: string | undefined, sink?: TranscriptSink) {
  const wire: Recorded[] = [];
  const scripted = scriptedResult(fx);
  const { server, url } = await startServer(wire, (_req, res, msg) => replyJson(res, msg.id, scripted), sink ? { sink, endpoint: "mcp" } : undefined);
  const outcomes: Record<string, Record<string, unknown>> = {};
  await withClient(url, mutant, {}, async client => {
    for (const step of fx.script) {
      if ("do" in step && step.do === "call") {
        const out = await bounded(client.request(step.method, step.params ?? {}, { idempotent: step.idempotent ?? false }), step.method);
        outcomes[step.as] = out as unknown as Record<string, unknown>;
      }
    }
  }, [server]);
  return { outcomes, wire };
}

/** HTTP-REDIR-1: a 307 to another origin is refused; Authorization never reaches the other origin. */
async function observeRedirect(fx: ExchangeFixture, mutant: string | undefined, sink?: TranscriptSink) {
  const primaryWire: Recorded[] = [];
  const otherWire: Recorded[] = [];
  const scripted = scriptedResult(fx);
  const other = await startServer(otherWire, (_req, res, msg) => replyJson(res, msg.id, scripted), sink ? { sink, endpoint: "other" } : undefined);
  let primary: { server: Server; url: string };
  try {
    primary = await startServer(primaryWire, (_req, res) => { res.writeHead(307, { location: other.url }).end(); }, sink ? { sink, endpoint: "mcp" } : undefined);
  } catch (error) { await stopServer(other.server); throw error; }
  const token = "redirect-observation-token";
  const out = await withClient(primary.url, mutant, { Authorization: `Bearer ${token}` },
    client => bounded(client.request("tools/list", {}, { idempotent: true }), "redirect observation"),
    [primary.server, other.server]) as unknown as Record<string, unknown>;
  check(primaryWire.length === 1, `HTTP-REDIR-1: expected 1 request to primary origin, got ${primaryWire.length}`);
  for (const r of otherWire) {
    check(!Object.entries(r.headers).some(([k, v]) => k.toLowerCase() === "authorization" || v.includes(token)),
      `HTTP-REDIR-1: Authorization forwarded cross-origin: ${serialize(r)}`);
  }
  check(otherWire.length === 0, `HTTP-REDIR-1: cross-origin redirect followed (${otherWire.length} request(s) to other origin)`);
  check(out["kind"] !== "ok", `HTTP-REDIR-1: expected non-ok outcome for refused cross-origin redirect, got ${JSON.stringify(out["kind"])}`);
}

/** HTTP-AMBIG-1/2: an SSE stream that breaks on a write yields uncertain-write and no second POST. */
async function observeStreamBreak(fx: ExchangeFixture, mutant: string | undefined, sink?: TranscriptSink) {
  const wire: Recorded[] = [];
  const scripted = scriptedResult(fx);
  let posts = 0;
  const { server, url } = await startServer(wire, (_req, res, msg) => {
    if (++posts > 1) { replyJson(res, msg.id, scripted); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    setTimeout(() => res.socket?.destroy(), 20);
  }, sink ? { sink, endpoint: "mcp" } : undefined);
  const out = await withClient(url, mutant, {},
    client => bounded(client.request("tools/call", { name: "write", arguments: {} }, { idempotent: false }), "stream-break observation"),
    [server]) as unknown as Record<string, unknown>;
  const calls = wire.filter(r => r.method === "POST" && r.body.includes("\"tools/call\""));
  check(calls.length === 1, `HTTP-AMBIG-1: expected exactly 1 POST for the write, got ${calls.length}`);
  check(out["kind"] === "uncertain-write", `HTTP-AMBIG-2: expected uncertain-write, got ${JSON.stringify(out["kind"])}`);
}

const OBSERVE: Record<string, (fx: ExchangeFixture, mutant: string | undefined, sink?: TranscriptSink) => Promise<void>> = {
  "redirect-cross-origin-refused": observeRedirect,
  "stream-break-write-uncertain": observeStreamBreak,
};

export async function runTierBHttpRedirectFixture(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  const name = fixture.id.startsWith("http/") ? fixture.id.slice(5) : undefined;
  const supported = name !== undefined ? OWNED[name] : undefined;
  if (!name || !supported) return undefined;
  const base = { id: fixture.id, ...(mutant !== undefined && { mutant }) };
  if (mutant !== undefined && !supported.includes(mutant)) return { ...base, ok: false, error: `Unsupported mutant ${mutant}` };
  const frames: HttpTranscriptFrame[] = [];
  let mcpEndpoint: string | undefined;
  const sink: TranscriptSink | undefined = mutant === undefined
    ? { frames, setEndpoint: (u) => { mcpEndpoint ??= u; } }
    : undefined;
  try {
    if (!fixture.script.some(s => "do" in s && s.do === "call")) throw new Error("fixture script has no call");
    const { outcomes, wire } = await exercise(fixture, mutant, sink);
    verify(fixture, outcomes, wire);
    await OBSERVE[name]!(fixture, mutant, sink);
    return { ...base, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof AssertionMismatch
      ? { ...base, ok: false, failure: "assertion", error: message }
      : { ...base, ok: false, error: message };
  } finally {
    if (mutant === undefined && frames.length > 0) {
      writeTranscript({ fixture: fixture.id, ...(mcpEndpoint !== undefined && { mcpEndpoint }), frames } as Transcript);
    }
  }
}
