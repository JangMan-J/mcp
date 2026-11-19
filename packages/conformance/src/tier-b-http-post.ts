import { createServer } from "node:http";
import { McpClient } from "@mcp-client/core";
import { HttpTransport } from "@mcp-client/transport-http";
import type { ExchangeFixture } from "@mcp-client/fixtures";
import type { FixtureResult } from "./run.js";
import { writeTranscript, type Transcript, type TranscriptFrame } from "./transcript.js";

/** Fixture id (without the "http/" prefix) -> supported client-side fault injections. */
const OWNED: Record<string, readonly string[]> = {
  "400-modern-error-vs-legacy": ["fall-back-to-legacy-initialize"],
  "5xx-write-uncertain": ["silently-retry-5xx-write"],
  "accept-both": ["accept-json-only"],
  "header-mismatch-refresh-retry-once": ["retry-without-tools-list-refresh", "retry-more-than-once"],
  "headers-base64-vectors": ["send-raw-non-ascii-header", "uppercase-base64-sentinel"],
  "json-response": ["reject-json-response"],
  "no-get-no-delete-no-session": ["open-get-stream", "echo-session-id"],
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

/** Wraps the real fetch with the mutant's fault injection. */
function faultyFetch(mutant: string | undefined): Fetch {
  const base: Fetch = (input, init) => fetch(input, init);
  const withHeaders = (init: RequestInit, edit: (h: Headers) => void): RequestInit => {
    const h = new Headers(init.headers);
    edit(h);
    return { ...init, headers: h };
  };
  switch (mutant) {
    case undefined: return base;
    case "fall-back-to-legacy-initialize":
      return async (input, init) => {
        const legacy = JSON.stringify({ jsonrpc: "2.0", id: "legacy-init", method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
        await (await base(input, { ...init, body: legacy, signal: null })).arrayBuffer().catch(() => undefined);
        return base(input, init);
      };
    case "silently-retry-5xx-write":
    case "retry-without-tools-list-refresh":
      return async (input, init) => {
        await (await base(input, init)).arrayBuffer().catch(() => undefined);
        return base(input, init);
      };
    case "retry-more-than-once":
      return async (input, init) => {
        for (let i = 0; i < 2; i++) await (await base(input, init)).arrayBuffer().catch(() => undefined);
        return base(input, init);
      };
    case "accept-json-only":
      return (input, init) => base(input, withHeaders(init, h => h.set("Accept", "application/json")));
    case "send-raw-non-ascii-header":
      return (input, init) => base(input, withHeaders(init, h => h.set("Mcp-Name", "caf\u00e9")));
    case "uppercase-base64-sentinel":
      return (input, init) => base(input, withHeaders(init, h => h.set("Mcp-Name", `=?BASE64?${Buffer.from("caf\u00e9").toString("base64")}?=`)));
    case "reject-json-response":
      return async (input, init) => {
        const res = await base(input, init);
        if ((res.headers.get("content-type") ?? "").includes("application/json")) {
          await res.arrayBuffer().catch(() => undefined);
          throw new TypeError("mutant: JSON responses rejected");
        }
        return res;
      };
    case "open-get-stream":
      return async (input, init) => {
        const ac = new AbortController();
        const get = await base(input, { method: "GET", headers: { Accept: "text/event-stream" }, signal: ac.signal }).catch(() => undefined);
        ac.abort();
        void get?.body?.cancel().catch(() => undefined);
        return base(input, init);
      };
    case "echo-session-id":
      return (input, init) => base(input, withHeaders(init, h => h.set("Mcp-Session-Id", "sess-1")));
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
      // Methods compare exactly, header names case-insensitively, bodies verbatim.
      const hit = r.method === needle
        || Object.entries(r.headers).some(([k, v]) => `${k}: ${v}`.toLowerCase().includes(needle.toLowerCase()))
        || r.body.includes(needle);
      check(!hit, `wire contains forbidden ${JSON.stringify(needle)}: ${serialize(r)}`);
    }
  }
  // Wire-index matches for scripted expect steps.
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
  // HTTP header encoding invariants (HTTP-ENC-*): header values are ASCII; base64 sentinel is lowercase.
  for (const r of wire) {
    for (const [k, v] of Object.entries(r.headers)) {
      check(/^[\x20-\x7e]*$/.test(v), `non-ASCII header ${k}`);
      check(!/=\?base64\?/i.test(v) || v.includes("=?base64?"), `non-canonical base64 sentinel in ${k}`);
    }
  }
}

function parseJson(body: string): unknown {
  if (body.length === 0) return undefined;
  try { return JSON.parse(body); } catch { return undefined; }
}

async function exercise(fx: ExchangeFixture, mutant: string | undefined) {
  const wire: Recorded[] = [];
  const frames: TranscriptFrame[] = [];
  let mcpEndpoint = "";
  const results = new Map<string, Record<string, unknown>>();
  for (const step of fx.script) if ("server" in step && step.for) results.set(step.for, step.server === "result" ? { result: step.result } : { error: step.error });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const headers: Record<string, string> = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i]!] = Buffer.from(req.rawHeaders[i + 1]!, "latin1").toString("latin1");
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
    let msg: { id?: unknown; method?: string };
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
    // Results are scripted in call order; this runner's fixtures each script one call.
    const scripted = [...results.values()][0] ?? { result: {} };
    const resHeaders = { "content-type": "application/json" };
    const resMsg = { jsonrpc: "2.0", id: msg.id, ...scripted };
    frames.push({ direction: "server", endpoint: "mcp", headers: resHeaders, message: resMsg } as TranscriptFrame);
    res.writeHead(200, resHeaders);
    res.end(JSON.stringify(resMsg));
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
        const out = await bounded(client.request(step.method, step.params ?? {}, { idempotent: step.idempotent ?? false }), step.method);
        outcomes[step.as] = out as unknown as Record<string, unknown>;
      }
    }
    return { outcomes, wire, frames, mcpEndpoint };
  } finally {
    try { await bounded(client.close(), "client close"); } finally {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await bounded(stopped, "server close");
    }
  }
}

export async function runTierBHttpPostFixture(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  const name = fixture.id.startsWith("http/") ? fixture.id.slice(5) : undefined;
  const supported = name !== undefined ? OWNED[name] : undefined;
  if (!supported) return undefined;
  const base = { id: fixture.id, ...(mutant !== undefined && { mutant }) };
  if (mutant !== undefined && !supported.includes(mutant)) return { ...base, ok: false, error: `Unsupported mutant ${mutant}` };
  try {
    if (!fixture.script.some(s => "do" in s && s.do === "call")) throw new Error("fixture script has no call");
    const { outcomes, wire, frames, mcpEndpoint } = await exercise(fixture, mutant);
    if (mutant === undefined) {
      writeTranscript({ fixture: fixture.id, mcpEndpoint, frames } as Transcript);
    }
    verify(fixture, outcomes, wire);
    return { ...base, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof AssertionMismatch
      ? { ...base, ok: false, failure: "assertion", error: message }
      : { ...base, ok: false, error: message };
  }
}
