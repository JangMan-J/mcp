import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpClient, type Exchange, type ExchangeEnd, type Transport } from "@mcp-client/core";
import { StdioTransport } from "@mcp-client/transport-stdio";
import type { ExchangeFixture } from "@mcp-client/fixtures";
import type { FixtureResult } from "./run.js";
import { writeTranscript, type TranscriptFrame } from "./transcript.js";

class Mismatch extends Error {}

const LIMIT_MS = 3000;

const owned: Record<string, { mode: string; mutants: readonly string[] }> = {
  "stdio/batch-line-rejected": { mode: "batch", mutants: ["accept-jsonrpc-batch-array"] },
  "stdio/cancel-inflight": { mode: "cancel-delay", mutants: ["omit-notifications-cancelled", "write-queued-cancelled-request"] },
  "stdio/concurrent-out-of-order": { mode: "out-of-order", mutants: ["fifo-response-matching"] },
  "stdio/crash-write-uncertain": { mode: "crash-on-request", mutants: ["auto-retry-tools-call-after-crash"] },
  "stdio/frame-split-multibyte": { mode: "split-multibyte", mutants: ["decode-per-chunk-without-stream", "allow-embedded-newline"] },
  "stdio/launch-and-lazy-discover": { mode: "echo", mutants: ["spawn-with-shell-true", "eager-spawn-before-first-request"] },
};

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Mismatch(msg);
}

async function bounded<T>(p: PromiseLike<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Mismatch(`Timed out: ${what}`)), LIMIT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function waitFor(pred: () => Promise<boolean>, what: string, ms = LIMIT_MS): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Mismatch(`Timed out: ${what}`);
    await sleep(10);
  }
}

function pick(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

type End = ExchangeEnd;

/** Records the real JSON-RPC messages crossing a transport: outbound requests/notifications and inbound responses/notifications. */
export function recordTransport(t: Transport, frames: TranscriptFrame[]): Transport {
  return {
    binding: t.binding,
    diagnostics: t.diagnostics,
    close: o => t.close(o),
    notify(msg, ctx) {
      frames.push({ direction: "client", message: msg });
      return t.notify(msg, ctx);
    },
    start(msg, ctx): Exchange {
      frames.push({ direction: "client", message: msg });
      const ex = t.start(msg, ctx);
      const notifications = {
        async *[Symbol.asyncIterator]() {
          for await (const n of ex.notifications) { frames.push({ direction: "server", message: n }); yield n; }
        },
      };
      const done = ex.done.then(e => { if (e.kind === "response") frames.push({ direction: "server", message: e.message }); return e; });
      return { ...(ex.abortDelivery && { abortDelivery: () => ex.abortDelivery!() }), notifications, done };
    },
  };
}

/** Client-side fault injection: wraps the real transport to emulate a faulty client. */
function inject(t: Transport, mutant: string | undefined, onAbortResend: { msgs: unknown[] }): Transport {
  if (!mutant) return t;
  const completions: End[] = [];
  const waiters: Array<(e: End) => void> = [];
  let started = 0;
  const wrapped: Transport = {
    binding: t.binding,
    diagnostics: t.diagnostics,
    close: o => t.close(o),
    notify(msg, ctx) {
      if (mutant === "omit-notifications-cancelled" && msg.method === "notifications/cancelled") return Promise.resolve();
      return t.notify(msg, ctx);
    },
    start(msg, ctx): Exchange {
      // Omitting the cancel: the binding never learns about the abort, so it never writes notifications/cancelled.
      const ex = t.start(msg, mutant === "omit-notifications-cancelled" ? { ...ctx, signal: new AbortController().signal } : ctx);
      let done: Promise<End> = ex.done;
      if (mutant === "accept-jsonrpc-batch-array") {
        done = ex.done.then(e => e.kind === "failure"
          ? { kind: "response", message: { jsonrpc: "2.0", id: msg.id, result: { resultType: "complete" } } } as End : e);
      } else if (mutant === "write-queued-cancelled-request") {
        ctx.signal.addEventListener("abort", () => {
          t.start(msg, { ...ctx, signal: new AbortController().signal, timeoutMs: 500 }).done.catch(() => {});
        }, { once: true });
      } else if (mutant === "fifo-response-matching") {
        const slot = started++;
        ex.done.then(e => {
          completions.push(e);
          const w = waiters.splice(0);
          for (const f of w) f(e);
        });
        done = new Promise<End>(resolve => {
          const tryResolve = () => {
            if (completions.length > slot) {
              const e = completions[slot]!;
              resolve(e.kind === "response" ? { kind: "response", message: { ...e.message, id: msg.id } } as End : e);
            } else waiters.push(tryResolve);
          };
          tryResolve();
        });
      } else if (mutant === "auto-retry-tools-call-after-crash") {
        done = ex.done.then(e => e.kind === "failure" && msg.method === "tools/call" ? t.start(msg, ctx).done : e);
      } else if (mutant === "decode-per-chunk-without-stream" || mutant === "allow-embedded-newline") {
        done = ex.done.then(e => {
          if (e.kind !== "response" || !("result" in e.message)) return e;
          const result = { ...(e.message.result as Record<string, unknown>) };
          if (typeof result["text"] === "string") {
            if (mutant === "decode-per-chunk-without-stream") {
              const buf = Buffer.from(result["text"], "utf8");
              const cut = buf.indexOf(Buffer.from("🌍", "utf8")) + 2;
              result["text"] = buf.subarray(0, cut).toString("utf8") + buf.subarray(cut).toString("utf8");
            } else {
              // A writer/reader that tolerates raw newlines inside a frame splits the payload.
              result["text"] = (result["text"] as string).split(" ").join("\n");
            }
          }
          return { kind: "response", message: { ...e.message, result } } as End;
        });
      }
      void onAbortResend;
      return { ...ex, notifications: ex.notifications, done, ...(ex.abortDelivery && { abortDelivery: () => ex.abortDelivery!() }) };
    },
  };
  return wrapped;
}

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function execute(fixture: ExchangeFixture, mode: string, mutant: string | undefined): Promise<void> {
  const frames: TranscriptFrame[] = [];
  const dir = await mkdtemp(join(tmpdir(), "tier-b-stdio-"));
  const log = join(dir, "wire.log");
  const peer = fileURLToPath(new URL("../../fixtures/server/stdio-main.ts", import.meta.url));
  const spawnOpts: Array<Record<string, unknown>> = [];
  const spawnFn = ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
    const o = mutant === "spawn-with-shell-true" ? { ...opts, shell: true } : opts;
    spawnOpts.push(o);
    return spawn(cmd, args, o as never);
  }) as unknown as typeof spawn;
  const transport = new StdioTransport({
    command: process.execPath,
    args: ["--no-warnings", "--experimental-strip-types", peer, "--log", log, "--mode", mode],
    spawnFn,
    graceMs: 200,
    termMs: 200,
  });
  let id = 0;
  const client = new McpClient({ transport: inject(mutant === undefined ? recordTransport(transport, frames) : transport, mutant, { msgs: [] }), server: { key: "fixture" }, idGenerator: () => ++id });
  const wire = async (): Promise<Array<Record<string, unknown>>> => {
    if (!(await exists(log))) return [];
    return (await readFile(log, "utf8")).split("\n").filter(l => l.startsWith("STDIN:"))
      .map(l => { try { return JSON.parse(l.slice(6)) as Record<string, unknown>; } catch { return { raw: l }; } });
  };
  const requests = async () => (await wire()).filter(m => "id" in m && typeof m["method"] === "string");
  const calls = new Map<string, { ctl: AbortController; out: Promise<unknown> }>();
  try {
    if (mutant === "eager-spawn-before-first-request") {
      void Promise.resolve(client.request("ping", {}, { timeoutMs: 1000 })).catch(() => {});
    }
    if (fixture.id === "stdio/launch-and-lazy-discover") {
      await sleep(150);
      check(!(await exists(log)), "child spawned before first request");
    }
    for (const step of fixture.script) {
      if ("do" in step && step.do === "call") {
        const ctl = new AbortController();
        const out = Promise.resolve(client.request(step.method, step.params ?? {}, { signal: ctl.signal, timeoutMs: 2500, ...(step.idempotent !== undefined && { idempotent: step.idempotent }) }));
        out.catch(() => {});
        calls.set(step.as, { ctl, out });
      } else if ("expect" in step && step.expect === "wire") {
        const i = step.index ?? 0;
        await waitFor(async () => (await requests()).length > i, `wire request #${i}`);
        const msg = (await requests())[i]!;
        for (const [k, v] of Object.entries(step.match ?? {})) check(JSON.stringify(pick(msg, k)) === JSON.stringify(v), `wire #${i} ${k}=${JSON.stringify(pick(msg, k))}`);
      } else if ("do" in step && step.do === "abort") {
        calls.get(step.target)?.ctl.abort();
      }
      // `server` steps are enacted by the peer mode.
    }
    for (const [as, want] of Object.entries(fixture.expect.outcome ?? {})) {
      const call = calls.get(as);
      check(call, `no call ${as}`);
      const got = await bounded(call.out, `outcome ${as}`);
      for (const [k, v] of Object.entries(want)) {
        check(JSON.stringify(pick(got, k)) === JSON.stringify(v), `${as}.${k}: want ${JSON.stringify(v)} got ${JSON.stringify(pick(got, k))}`);
      }
    }
    if (fixture.id === "stdio/cancel-inflight") {
      // The peer must observe the cancellation, and the cancelled request must never be re-written.
      await waitFor(async () => (await wire()).some(m => m["method"] === "notifications/cancelled"), "notifications/cancelled on wire", 1000);
      await sleep(100);
      check((await requests()).length === 1, "cancelled request written again");
    }
    if (fixture.id === "stdio/launch-and-lazy-discover") {
      check(spawnOpts.length > 0 && spawnOpts.every(o => !o["shell"]), "spawned with shell");
    }
    await sleep(50);
    const reqs = await requests();
    const w = fixture.expect.wire;
    if (w?.totalRequests !== undefined) check(reqs.length === w.totalRequests, `totalRequests ${reqs.length} != ${w.totalRequests}`);
    if (w?.distinctIds) check(new Set(reqs.map(r => JSON.stringify(r["id"]))).size === reqs.length, "ids not distinct");
    for (const [m, n] of Object.entries(w?.count ?? {})) check(reqs.filter(r => r["method"] === m).length === n, `count ${m}`);
    const raw = await exists(log) ? await readFile(log, "utf8") : "";
    for (const s of w?.never ?? []) check(!raw.includes(s), `wire contains ${s}`);
    if (mutant === undefined) writeTranscript({ fixture: fixture.id, frames });
  } finally {
    for (const c of calls.values()) c.ctl.abort();
    try { await bounded(client.close(), "client close"); } catch { /* best effort */ }
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runTierBStdioFixture(fixture: ExchangeFixture, mutant?: string): Promise<FixtureResult | undefined> {
  const own = owned[fixture.id];
  if (!own) return undefined;
  const base = { id: fixture.id, ...(mutant !== undefined && { mutant }) };
  if (mutant !== undefined && !own.mutants.includes(mutant)) return { ...base, ok: false, error: `unknown mutant ${mutant}` };
  try {
    await execute(fixture, own.mode, mutant);
    return { ...base, ok: true };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return e instanceof Mismatch ? { ...base, ok: false, failure: "assertion", error } : { ...base, ok: false, error };
  }
}
