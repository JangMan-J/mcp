import { describe, expect, it } from "vitest";
import {
  argsDigest,
  classifyInterruptedCall,
  createReadOnlyPredicate,
  DEFAULT_READ_ONLY_METHODS,
  isReadOnlyMethod,
  McpClient,
  withAbort,
  type Clock,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type Transport,
  type TransportCall,
} from "../../src/index.js";

interface Pending {
  readonly req: JsonRpcRequest;
  readonly ctx: TransportCall;
  resolve(end: ExchangeEnd): void;
}

/** Transport that never reacts to abort unless `settleOnAbort` is set (like a stdio binding). */
function manualTransport(opts: { settleOnAbort?: boolean } = {}) {
  const pending: Pending[] = [];
  const notified: JsonRpcNotification[] = [];
  const transport: Transport = {
    binding: "stdio",
    start(req, ctx) {
      let resolve!: (end: ExchangeEnd) => void;
      const done = new Promise<ExchangeEnd>((r) => {
        resolve = r;
      });
      pending.push({ req, ctx, resolve });
      if (opts.settleOnAbort) {
        ctx.signal.addEventListener("abort", () =>
          resolve({ kind: "failure", failure: { kind: "closed", message: "cancelled while queued" }, delivery: "not-sent" }),
        );
      }
      return { notifications: { async *[Symbol.asyncIterator]() {} }, done };
    },
    async notify(n) {
      notified.push(n);
    },
    async close() {},
    diagnostics: { async *[Symbol.asyncIterator]() {} },
  };
  const respond = (i: number, result: Record<string, unknown> = { resultType: "complete" }) => {
    const p = pending[i]!;
    p.resolve({ kind: "response", message: { jsonrpc: "2.0", id: p.req.id, result } });
  };
  return { transport, pending, notified, respond };
}

function fakeClock(): Clock & { advance(ms: number): void; timers(): number } {
  let now = 0;
  const timers = new Map<number, { due: number; fn: () => void }>();
  let next = 1;
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = next++;
      timers.set(id, { due: now + ms, fn });
      return () => timers.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.due <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    timers: () => timers.size,
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe("cancel classification (WIRE-CANCEL-5, N14)", () => {
  it("classifies interrupted calls by delivery and read-only-ness", () => {
    expect(classifyInterruptedCall({ method: "tools/call", readOnly: false, cause: "cancelled", delivery: "not-sent" })).toBe("cancelled");
    expect(classifyInterruptedCall({ method: "tools/call", readOnly: false, cause: "timeout", delivery: "not-sent" })).toBe("transport-failure");
    expect(classifyInterruptedCall({ method: "tools/call", readOnly: false, cause: "cancelled", delivery: "maybe-delivered" })).toBe("uncertain-write");
    expect(classifyInterruptedCall({ method: "tools/call", readOnly: false, cause: "timeout", delivery: "delivered-no-response" })).toBe("uncertain-write");
    expect(classifyInterruptedCall({ method: "tools/list", readOnly: true, cause: "cancelled", delivery: "maybe-delivered" })).toBe("cancelled");
    expect(classifyInterruptedCall({ method: "tools/list", readOnly: true, cause: "timeout", delivery: "maybe-delivered" })).toBe("transport-failure");
  });

  it("default read-only list includes subscriptions/listen, excludes tools/call, and is overridable", () => {
    expect(isReadOnlyMethod("tools/list")).toBe(true);
    expect(isReadOnlyMethod("subscriptions/listen")).toBe(true);
    expect(DEFAULT_READ_ONLY_METHODS).toContain("subscriptions/listen");
    expect(isReadOnlyMethod("tools/call")).toBe(false);
    expect(DEFAULT_READ_ONLY_METHODS).toContain("prompts/get");
    const strict = createReadOnlyPredicate(DEFAULT_READ_ONLY_METHODS.filter((m) => m !== "prompts/get"));
    expect(strict("prompts/get")).toBe(false);
  });

  it("argsDigest is stable and does not echo arguments", () => {
    const d = argsDigest({ name: "x", arguments: { secret: "hunter2" } });
    expect(d).toBe(argsDigest({ name: "x", arguments: { secret: "hunter2" } }));
    expect(d).not.toContain("hunter2");
    expect(d).toMatch(/^fnv1a-[0-9a-f]{8}$/);
  });

  it("withAbort settles on work completion or rejects on abort (with optional onAbort)", async () => {
    const ac1 = new AbortController();
    await expect(withAbort(Promise.resolve("ok"), ac1.signal)).resolves.toBe("ok");

    const ac2 = new AbortController();
    const pending = new Promise<string>(() => {});
    const raced = withAbort(pending, ac2.signal);
    ac2.abort("stop-now");
    await expect(raced).rejects.toBe("stop-now");

    const ac3 = new AbortController();
    ac3.abort("already");
    await expect(withAbort(Promise.resolve("never"), ac3.signal, () => new Error("custom-abort"))).rejects.toThrow("custom-abort");
  });
});

describe("cancel and timeout semantics through McpClient", () => {
  it("cancel after settle is a no-op: outcome stays ok and nothing is sent (WIRE-CANCEL-1, EDGE-5)", async () => {
    const t = manualTransport();
    const client = new McpClient({ transport: t.transport, server: { key: "s" } });
    const req = client.request("tools/call", { name: "w" });
    t.respond(0, { resultType: "complete", content: [] });
    const out = await req;
    req.cancel("too late");
    await tick();
    expect(out.kind).toBe("ok");
    expect(await req).toBe(out);
    expect(t.notified).toHaveLength(0);
  });

  it("abort of a sent write is uncertain-write; a late response is ignored (WIRE-CANCEL-3/5)", async () => {
    const t = manualTransport();
    const client = new McpClient({ transport: t.transport, server: { key: "s" } });
    const req = client.request("tools/call", { name: "create" });
    req.cancel("user");
    const out = await req;
    expect(out.kind).toBe("uncertain-write");
    if (out.kind === "uncertain-write") {
      expect(out.uncertain.evidence).toBe("cancelled");
      expect(out.uncertain.name).toBe("create");
    }
    t.respond(0);
    await tick();
    expect(await req).toBe(out);
  });

  it("a transport that settles on abort wins the race, keeping delivery not-sent (stdio queued cancel)", async () => {
    const t = manualTransport({ settleOnAbort: true });
    const client = new McpClient({ transport: t.transport, server: { key: "s" } });
    const req = client.request("tools/call", { name: "create" });
    req.cancel();
    const out = await req;
    expect(out).toMatchObject({ kind: "cancelled", wasSent: false });
  });

  it("explicit idempotent overrides the read-only default", async () => {
    const t = manualTransport();
    const client = new McpClient({ transport: t.transport, server: { key: "s" } });
    const req = client.request("tools/call", { name: "safe" }, { idempotent: true });
    req.cancel();
    expect((await req).kind).toBe("cancelled");
    expect(t.pending[0]!.ctx.idempotent).toBe(true);
    const req2 = client.request("tools/list");
    expect(t.pending[1]!.ctx.idempotent).toBe(true);
    req2.cancel();
    await req2;
  });

  it("default timeout is 60s and the per-request override applies (WIRE-TO-1)", async () => {
    const clock = fakeClock();
    const t = manualTransport();
    const client = new McpClient({ transport: t.transport, server: { key: "s" }, ports: { clock } });
    const a = client.request("tools/list");
    const b = client.request("tools/list", {}, { timeoutMs: 100 });
    expect(t.pending[0]!.ctx.timeoutMs).toBe(60_000);
    expect(t.pending[1]!.ctx.timeoutMs).toBe(100);
    clock.advance(100);
    const outB = await b;
    expect(outB).toMatchObject({ kind: "transport-failure", failure: { kind: "timeout" } });
    clock.advance(59_899);
    await tick();
    t.respond(0, { resultType: "complete", tools: [] });
    expect((await a).kind).toBe("ok");
  });

  it("hard max timeout caps larger requests, and progress does not reset the clock (WIRE-TO-2, WIRE-TO-3 off)", async () => {
    const clock = fakeClock();
    const t = manualTransport();
    const client = new McpClient({ transport: t.transport, server: { key: "s" }, ports: { clock } });
    const req = client.request("tools/list", {}, { timeoutMs: 10_000_000, onProgress: () => {} });
    expect(t.pending[0]!.ctx.timeoutMs).toBe(600_000);
    clock.advance(600_000);
    const out = await req;
    expect(out).toMatchObject({ kind: "transport-failure", failure: { kind: "timeout" } });
    expect(clock.timers()).toBe(0);
  });

  it("local timeout carries no JSON-RPC code (ERR-LOCAL-1); a timed-out write is uncertain-write", async () => {
    const clock = fakeClock();
    const t = manualTransport();
    const client = new McpClient({ transport: t.transport, server: { key: "s" }, ports: { clock } });
    const req = client.request("tools/call", { name: "pay" }, { timeoutMs: 5 });
    clock.advance(5);
    const out = await req;
    expect(out.kind).toBe("uncertain-write");
    expect("code" in out).toBe(false);
    if (out.kind === "uncertain-write") expect(out.uncertain.evidence).toBe("timeout");
  });

  it("stream: true survives past hardMaxTimeoutMs and handles timeoutMs: 0 or Infinity without tick-0 abort", async () => {
    const clock = fakeClock();
    const t = manualTransport();
    const client = new McpClient({ transport: t.transport, server: { key: "s" }, ports: { clock } });

    const sDefault = client.request("subscriptions/listen", {}, { stream: true, idempotent: true });
    const sZero = client.request("subscriptions/listen", {}, { stream: true, idempotent: true, timeoutMs: 0 });
    const sInf = client.request(
      "subscriptions/listen",
      {},
      { stream: true, idempotent: true, timeoutMs: Number.POSITIVE_INFINITY },
    );

    expect(t.pending.map((p) => p.ctx.timeoutMs)).toEqual([0, 0, 0]);
    expect(clock.timers()).toBe(0);

    await tick();
    clock.advance(0);
    clock.advance(600_000);
    clock.advance(10_000_000);
    await tick();

    for (const p of t.pending) {
      expect(p.ctx.signal.aborted).toBe(false);
    }

    // Stream terminates only on caller abort / cancel / client.close() / transport settlement.
    t.respond(0, { resultType: "complete" });
    expect((await sDefault).kind).toBe("ok");

    sZero.cancel("done");
    expect((await sZero).kind).toBe("cancelled");

    await client.close();
    expect((await sInf).kind).toBe("cancelled");
  });

  it("stream: true honors an explicit finite positive timeoutMs > 0 even above hardMaxTimeoutMs", async () => {
    const clock = fakeClock();
    const t = manualTransport();
    const client = new McpClient({ transport: t.transport, server: { key: "s" }, ports: { clock } });
    const s = client.request("subscriptions/listen", {}, { stream: true, idempotent: true, timeoutMs: 900_000 });
    expect(t.pending[0]!.ctx.timeoutMs).toBe(900_000);
    expect(clock.timers()).toBe(1);
    clock.advance(600_000);
    await tick();
    expect(t.pending[0]!.ctx.signal.aborted).toBe(false);
    clock.advance(300_000);
    expect(await s).toMatchObject({ kind: "transport-failure", failure: { kind: "timeout" } });
    expect(clock.timers()).toBe(0);
  });
});
