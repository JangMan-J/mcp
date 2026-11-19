import { createServer } from "node:http";
import { McpClient } from "@mcp-client/core";
import { HttpTransport } from "@mcp-client/transport-http";
import type { ExchangeFixture } from "@mcp-client/fixtures";
import type { FixtureResult } from "./run.js";
import { writeTranscript, type Transcript, type TranscriptFrame } from "./transcript.js";

/** Fixture id (without the "http/" prefix) -> supported client-side fault injections. */
const OWNED: Record<string, readonly string[]> = {
  "post-headers-required": ["send-get-instead-of-post", "omit-mcp-method-header"],
  "session-id-header-ignored": ["echo-session-id-header"],
  "x-mcp-header-valid": ["ignore-x-mcp-header-annotation"],
  "x-mcp-header-invalid-tool-excluded": ["keep-invalid-tool-in-list"],
};

/** Fixtures whose own script is thin; this runner adds a per-id observation (requirement ids cited). */
export const THIN_FIXTURES: Record<string, string> = {
  "http/post-headers-required": "HTTP-REQ-1/HTTP-HDR-1/HTTP-HDR-2: POST carries Content-Type application/json, Accept json+sse, MCP-Protocol-Version, Mcp-Method",
  "http/session-id-header-ignored": "HTTP-NOSESS-1: server-sent Mcp-Session-Id is ignored; a later request never echoes it",
  "http/x-mcp-header-valid": "HTTP-PARAM-1/HTTP-PARAM-4: valid x-mcp-header from tools/list is mirrored as Mcp-Param-{name} on tools/call",
  "http/x-mcp-header-invalid-tool-excluded": "HTTP-PARAM-2: a tool with an invalid x-mcp-header is omitted from the tools/list result",
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

const SESSION_ID = "sess-observed-1";
const VALID_TOOL = { name: "regional", inputSchema: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" } } } };
const INVALID_TOOL = { name: "broken", inputSchema: { type: "object", properties: { cfg: { type: "object", "x-mcp-header": "bad header" } } } };

function stripAnnotations(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripAnnotations);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "x-mcp-header").map(([k, x]) => [k, stripAnnotations(x)]));
  return v;
}

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
    case "send-get-instead-of-post":
      return (input, init) => base(input, { ...withHeaders(init, h => h.delete("Content-Type")), method: "GET", body: null });
    case "omit-mcp-method-header":
      return (input, init) => base(input, withHeaders(init, h => h.delete("Mcp-Method")));
    case "echo-session-id-header": {
      let seen: string | undefined;
      return async (input, init) => {
        const res = await base(input, seen === undefined ? init : withHeaders(init, h => h.set("Mcp-Session-Id", seen!)));
        seen = res.headers.get("mcp-session-id") ?? seen;
        return res;
      };
    }
    case "ignore-x-mcp-header-annotation":
      return (input, init) => base(input, withHeaders(init, h => {
        for (const k of [...h.keys()]) if (k.toLowerCase().startsWith("mcp-param-")) h.delete(k);
      }));
    case "keep-invalid-tool-in-list":
      return async (input, init) => {
        const res = await base(input, init);
        const text = await res.text();
        const body = text ? JSON.stringify(stripAnnotations(JSON.parse(text))) : text;
        return new Response(body, { status: res.status, headers: res.headers });
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

type Responder = (msg: { id?: unknown; method?: string }) => Record<string, unknown>;

interface Observation {
  /** Server responses for observation-phase requests, keyed by JSON-RPC method. */
  readonly responses?: Record<string, Record<string, unknown>>;
  readonly responseHeaders?: Record<string, string>;
  readonly calls?: readonly { method: string; params: Record<string, unknown> }[];
  readonly verify: (scriptWire: readonly Recorded[], extraWire: readonly Recorded[], extraOutcomes: readonly Record<string, unknown>[]) => void;
}

const header = (r: Recorded, name: string): string | undefined =>
  Object.entries(r.headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];

const OBSERVE: Record<string, Observation> = {
  // HTTP-REQ-1, HTTP-HDR-1, HTTP-HDR-2
  "post-headers-required": {
    verify: scriptWire => {
      for (const r of scriptWire) {
        check(r.method === "POST", `HTTP-REQ-1: expected POST, got ${r.method}`);
        check((header(r, "content-type") ?? "").includes("application/json"), "HTTP-REQ-1: Content-Type application/json missing");
        const accept = header(r, "accept") ?? "";
        check(accept.includes("application/json") && accept.includes("text/event-stream"), `Accept must list json and sse, got ${accept}`);
        check(header(r, "mcp-protocol-version"), "HTTP-HDR-1: MCP-Protocol-Version missing");
        const method = (JSON.parse(r.body || "{}") as { method?: string }).method;
        check(header(r, "mcp-method") === method, `HTTP-HDR-2: Mcp-Method expected ${method}, got ${header(r, "mcp-method")}`);
      }
    },
  },
  // HTTP-NOSESS-1
  "session-id-header-ignored": {
    responseHeaders: { "Mcp-Session-Id": SESSION_ID },
    calls: [{ method: "tools/list", params: {} }],
    verify: (_s, extra) => {
      check(extra.length >= 1, "HTTP-NOSESS-1: no follow-up request observed");
      for (const r of extra) check(header(r, "mcp-session-id") === undefined, `HTTP-NOSESS-1: request echoed Mcp-Session-Id ${header(r, "mcp-session-id")}`);
    },
  },
  // HTTP-PARAM-1, HTTP-PARAM-4
  "x-mcp-header-valid": {
    responses: { "tools/list": { result: { tools: [VALID_TOOL] } }, "tools/call": { result: { content: [] } } },
    calls: [{ method: "tools/list", params: {} }, { method: "tools/call", params: { name: "regional", arguments: { region: "us-west" } } }],
    verify: (_s, extra) => {
      const call = extra.find(r => (JSON.parse(r.body || "{}") as { method?: string }).method === "tools/call");
      check(call, "HTTP-PARAM-4: no tools/call observed");
      check(header(call, "mcp-param-region") === "us-west", `HTTP-PARAM-4: Mcp-Param-Region expected us-west, got ${header(call, "mcp-param-region")}`);
    },
  },
  // HTTP-PARAM-2
  "x-mcp-header-invalid-tool-excluded": {
    responses: { "tools/list": { result: { tools: [VALID_TOOL, INVALID_TOOL] } } },
    calls: [{ method: "tools/list", params: {} }],
    verify: (_s, _w, outcomes) => {
      const out = outcomes[0] as { kind?: string; value?: { tools?: { name?: string }[] } } | undefined;
      check(out?.kind === "ok", `HTTP-PARAM-2: tools/list failed: ${JSON.stringify(out)}`);
      const names = (out.value?.tools ?? []).map(t => t.name);
      check(names.includes("regional"), `HTTP-PARAM-2: valid tool missing: ${names.join(",")}`);
      check(!names.includes("broken"), `HTTP-PARAM-2: invalid tool not excluded: ${names.join(",")}`);
    },
  },
};

function parseJson(body: string): unknown {
  if (body.length === 0) return undefined;
  try { return JSON.parse(body); } catch { return undefined; }
}

async function exercise(fx: ExchangeFixture, name: string, mutant: string | undefined) {
  const obs = OBSERVE[name]!;
  const wire: Recorded[] = [];
  const frames: TranscriptFrame[] = [];
  let mcpEndpoint = "";
  const results = new Map<string, Record<string, unknown>>();
  for (const step of fx.script) if ("server" in step && step.for) results.set(step.for, step.server === "result" ? { result: step.result } : { error: step.error });
  const scripted = [...results.values()][0] ?? { result: {} };
  let respond: Responder = () => scripted;
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
    const resHeaders = { "content-type": "application/json", ...obs.responseHeaders };
    const resMsg = { jsonrpc: "2.0", id: msg.id, ...respond(msg) };
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
    const scriptWire = wire.slice();
    respond = msg => obs.responses?.[msg.method ?? ""] ?? scripted;
    const extraOutcomes: Record<string, unknown>[] = [];
    for (const call of obs.calls ?? []) {
      const out = await bounded(client.request(call.method, call.params, { idempotent: call.method !== "tools/call" }), call.method);
      extraOutcomes.push(out as unknown as Record<string, unknown>);
    }
    return { outcomes, scriptWire, extraWire: wire.slice(scriptWire.length), extraOutcomes, obs, frames, mcpEndpoint };
  } finally {
    try { await bounded(client.close(), "client close"); } finally {
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await bounded(stopped, "server close");
    }
  }
}

export async function runTierBHttpHeadersFixture(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  const name = fixture.id.startsWith("http/") ? fixture.id.slice(5) : undefined;
  const supported = name !== undefined ? OWNED[name] : undefined;
  if (!name || !supported) return undefined;
  const base = { id: fixture.id, ...(mutant !== undefined && { mutant }) };
  if (mutant !== undefined && !supported.includes(mutant)) return { ...base, ok: false, error: `Unsupported mutant ${mutant}` };
  try {
    if (!fixture.script.some(s => "do" in s && s.do === "call")) throw new Error("fixture script has no call");
    const { outcomes, scriptWire, extraWire, extraOutcomes, obs, frames, mcpEndpoint } = await exercise(fixture, name, mutant);
    if (mutant === undefined) {
      writeTranscript({ fixture: fixture.id, mcpEndpoint, frames } as Transcript);
    }
    verify(fixture, outcomes, scriptWire);
    obs.verify(scriptWire, extraWire, extraOutcomes);
    return { ...base, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof AssertionMismatch
      ? { ...base, ok: false, failure: "assertion", error: message }
      : { ...base, ok: false, error: message };
  }
}
