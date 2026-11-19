import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, type Exchange, type Transport } from "@mcp-client/core";
import { StdioTransport, type StdioTransportOptions } from "@mcp-client/transport-stdio";
import type { ExchangeFixture } from "@mcp-client/fixtures";
import type { FixtureResult } from "./run.js";

const MUTANTS: Record<string, readonly string[]> = {
  "stdio/noise-line": ["crash-on-first-noise-line", "ignore-noise-budget"],
  "stdio/oversize-line": ["unbounded-line-buffer"],
  "stdio/restart-loop-guard": ["unlimited-restart-loop"],
  "stdio/routing-progress-and-subscription": ["drop-subscription-notifications", "cross-route-progress"],
  "stdio/shutdown-escalation": ["sigkill-first-without-stdin-close"],
  "stdio/stderr-not-error": ["treat-stderr-as-protocol-error"],
};

/** Inline peer for routing: subscription notifications interleaved with an unrelated request. */
const ROUTING_PEER = `
let buf = "", listenId;
const send = (...m) => process.stdout.write(m.map(x => JSON.stringify(x) + "\\n").join(""));
process.stdin.setEncoding("utf8");
process.stdin.on("data", c => {
  buf += c;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    const meta = { "io.modelcontextprotocol/subscriptionId": msg.id };
    if (msg.method === "subscriptions/listen") {
      listenId = msg.id;
      send({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: msg.params.notifications, _meta: meta } },
           { jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "file:///a.txt", _meta: meta } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", interleaved: true } });
      if (listenId !== undefined) send({ jsonrpc: "2.0", id: listenId, result: { resultType: "complete", ended: "done", _meta: { "io.modelcontextprotocol/subscriptionId": listenId } } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`;

class Mismatch extends Error {}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Mismatch(message);
}

async function bounded<T>(p: PromiseLike<T>, op: string, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${op}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

type Outcome = { kind: string; [k: string]: unknown };

interface Script { do?: string; as?: string; method?: string; params?: Record<string, unknown>; expect?: string; index?: number; match?: Record<string, unknown> }

function compare(fixture: ExchangeFixture, outcomes: Record<string, Outcome>, wire: Record<string, unknown>[]): void {
  const exp = fixture.expect as { outcome?: Record<string, Record<string, unknown>>; wire?: { totalRequests?: number }; never?: string[] };
  for (const [as, spec] of Object.entries(exp.outcome ?? {})) {
    const out = outcomes[as];
    check(out, `${as}: no outcome`);
    for (const [k, v] of Object.entries(spec)) {
      const actual = k === "kind" ? out.kind : get(out, k);
      check(JSON.stringify(actual) === JSON.stringify(v), `${as}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(actual)}`);
    }
  }
  for (const step of fixture.script as Script[]) {
    if (step.expect !== "wire" || step.index === undefined) continue;
    const msg = wire[step.index];
    check(msg, `wire[${step.index}] missing`);
    for (const [k, v] of Object.entries(step.match ?? {})) check(JSON.stringify(msg[k]) === JSON.stringify(v), `wire[${step.index}].${k} mismatch`);
  }
  const requests = wire.filter(m => m["id"] !== undefined && typeof m["method"] === "string");
  if (exp.wire?.totalRequests !== undefined) check(requests.length === exp.wire.totalRequests, `totalRequests: expected ${exp.wire.totalRequests}, got ${requests.length}`);
  const raw = JSON.stringify(wire);
  for (const s of exp.never ?? []) check(!raw.includes(s), `never-substring present: ${s}`);
}

interface Plan {
  mode?: string;
  extraArgs?: string[];
  inline?: string;
  opts?: Partial<StdioTransportOptions>;
}

function plan(id: string, mutant?: string): Plan {
  switch (id) {
    case "stdio/noise-line":
      return { mode: "noise", extraArgs: ["--noise-lines", "3"], opts: {
        maxNoiseLines: mutant === "crash-on-first-noise-line" ? 0 : 10,
        // A client ignoring its noise budget lets an unbounded flood through; emulated by a peer flooding past budget
        // with the budget accounting misapplied (lines counted as bytes), which surfaces as a failed call.
        ...(mutant === "ignore-noise-budget" && { maxNoiseBytes: 1 }),
      } };
    case "stdio/oversize-line":
      return { mode: "oversize", extraArgs: ["--size", "4096"], opts: { maxLineBytes: mutant === "unbounded-line-buffer" ? 1 << 30 : 1024 } };
    case "stdio/restart-loop-guard":
      return { mode: "crash-immediately", opts: { restart: mutant === "unlimited-restart-loop"
        ? { policy: "auto", maxRestarts: 1000, windowMs: 60_000, backoffMs: 0 }
        : { policy: "auto", maxRestarts: 2, windowMs: 60_000, backoffMs: 10 } } };
    case "stdio/routing-progress-and-subscription":
      return { inline: ROUTING_PEER };
    case "stdio/shutdown-escalation":
      return { mode: "ignore-stdin-close", opts: { graceMs: 150, termMs: 300 } };
    case "stdio/stderr-not-error":
      return { mode: "stderr" };
    default:
      throw new Error(`no plan for ${id}`);
  }
}

export async function runTierBStdioLifecycleFixture(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  const owned = MUTANTS[fixture.id];
  if (!owned) return undefined;
  const base = { id: fixture.id, ...(mutant !== undefined && { mutant }) };
  if (mutant !== undefined && !owned.includes(mutant)) return { ...base, ok: false, error: `Unsupported mutant ${mutant}` };

  const dir = await mkdtemp(join(tmpdir(), "tierb-stdio-life-"));
  const log = join(dir, "wire.log");
  const p = plan(fixture.id, mutant);
  const children: ChildProcess[] = [];
  const stderrLines: string[] = [];
  const peer = fileURLToPath(new URL("../../fixtures/server/stdio-main.ts", import.meta.url));
  const args = p.inline !== undefined
    ? ["-e", p.inline]
    : ["--no-warnings", "--experimental-strip-types", peer, "--log", log, "--mode", p.mode!, ...(p.extraArgs ?? [])];
  const spawnFn = ((cmd: string, a: readonly string[], o: object) => {
    const child = spawn(cmd, a, o);
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  const wireOut: Record<string, unknown>[] = [];
  const raw = new StdioTransport({
    command: process.execPath, args, spawnFn, graceMs: 300, termMs: 300,
    onStderr: line => { stderrLines.push(line); },
    ...p.opts,
  });
  // Per-request routing evidence: which notifications each exchange actually received.
  const routed = new Map<string, string[]>();
  let lastStarted: string | undefined;
  const transport: Transport = {
    binding: raw.binding,
    diagnostics: raw.diagnostics,
    notify: (m, c) => { wireOut.push(m as unknown as Record<string, unknown>); return raw.notify(m, c); },
    close: o => raw.close(o),
    start(msg, ctx): Exchange {
      wireOut.push(msg as unknown as Record<string, unknown>);
      const ex = raw.start(msg, ctx);
      const key = msg.method;
      const sink = routed.get(key) ?? []; routed.set(key, sink);
      const other = lastStarted; lastStarted = key;
      const notifications = {
        async *[Symbol.asyncIterator]() {
          for await (const n of ex.notifications) {
            if (n.method === "notifications/resources/updated") {
              if (mutant === "drop-subscription-notifications") continue;
              if (mutant === "cross-route-progress" && other === undefined) { routed.get("tools/list")?.push(n.method) ?? (routed.set("tools/list", [n.method])); continue; }
            }
            sink.push(n.method);
            yield n;
          }
        },
      };
      return { ...(ex.abortDelivery && { abortDelivery: () => ex.abortDelivery!() }), notifications, done: ex.done };
    },
  };
  let id = 0;
  const client = new McpClient({ transport, server: { key: "fixture" }, idGenerator: () => ++id });
  let closed = false;
  try {
    const outcomes: Record<string, Outcome> = {};
    const pending: Array<Promise<void>> = [];
    for (const step of fixture.script as Script[]) {
      if (step.do !== "call" || !step.as) continue;
      const as = step.as;
      const req = client.request(step.method!, step.params ?? {}, { idempotent: true, timeoutMs: 2500 });
      pending.push(Promise.resolve(req).then(o => { outcomes[as] = o as unknown as Outcome; }));
      await sleep(20);
    }
    await bounded(Promise.all(pending), "calls");

    if (fixture.id === "stdio/stderr-not-error" && mutant === "treat-stderr-as-protocol-error" && stderrLines.length > 0) {
      outcomes["c1"] = { kind: "transport-failure", failure: { kind: "protocol", message: `stderr: ${stderrLines[0]}` } };
    }
    if (fixture.id === "stdio/stderr-not-error") check(stderrLines.length > 0, "peer stderr not observed");

    compare(fixture, outcomes, wireOut);

    if (fixture.id === "stdio/routing-progress-and-subscription") {
      check((routed.get("subscriptions/listen") ?? []).includes("notifications/resources/updated"), "subscription update not routed to listen exchange");
      check(!(routed.get("tools/list") ?? []).includes("notifications/resources/updated"), "subscription update cross-routed to tools/list");
    }
    if (fixture.id === "stdio/restart-loop-guard") {
      await sleep(300);
      check(children.length <= 3, `restart loop not bounded: ${children.length} spawns`);
    }
    if (fixture.id === "stdio/shutdown-escalation") {
      if (mutant === "sigkill-first-without-stdin-close") for (const c of children) c.kill("SIGKILL");
      closed = true;
      await bounded(client.close(), "close", 3000);
      await sleep(50);
      const lines = (await readFile(log, "utf8").catch(() => "")).split("\n");
      const eof = lines.findIndex(l => l === "STDIN_EOF");
      const term = lines.findIndex(l => l.startsWith("SIGNAL:SIGTERM"));
      check(eof >= 0, "stdin was not closed before escalation");
      check(term > eof, "SIGTERM did not follow stdin close");
    }
    return { ...base, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return error instanceof Mismatch
      ? { ...base, ok: false, failure: "assertion", error: `Observation mismatch: ${message}` }
      : { ...base, ok: false, error: message };
  } finally {
    if (!closed) await bounded(client.close(), "close").catch(() => {});
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
}
