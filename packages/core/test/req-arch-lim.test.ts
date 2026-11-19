import { describe, expect, it } from "vitest";
import {
  RequestManager,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type Transport,
  type TransportDiagnostic,
} from "../src/index.js";

interface Pending {
  req: JsonRpcRequest;
  signal: AbortSignal;
  resolve: (e: ExchangeEnd) => void;
}

/** Transport whose exchanges stay open until answered or aborted. */
function makeHeldTransport() {
  const pending: Pending[] = [];
  const signals: AbortSignal[] = [];
  let closed = 0;
  const transport: Transport = {
    binding: "stdio",
    start(req, opts) {
      let resolve!: (e: ExchangeEnd) => void;
      const done = new Promise<ExchangeEnd>((r) => (resolve = r));
      opts.signal.addEventListener(
        "abort",
        () => resolve({ kind: "failure", failure: { kind: "closed", message: "aborted" }, delivery: "not-sent" }),
        { once: true },
      );
      signals.push(opts.signal);
      pending.push({ req, signal: opts.signal, resolve });
      const notifications: AsyncIterable<JsonRpcNotification> = { async *[Symbol.asyncIterator]() {} };
      return { notifications, done };
    },
    async notify() {},
    async close() {
      closed += 1;
    },
    diagnostics: { async *[Symbol.asyncIterator](): AsyncIterator<TransportDiagnostic> {} },
  };
  const answer = (i: number) =>
    pending[i]!.resolve({ kind: "response", message: { jsonrpc: "2.0", id: pending[i]!.req.id, result: { ok: i } } });
  return { transport, pending, signals, answer, closedCount: () => closed };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("architecture invariants (Plan 4.6)", () => {
  it("[ARCH-REQ-1] request context (abort, timeout, attempts) is released at settlement", async () => {
    const t = makeHeldTransport();
    const client = new RequestManager({ transport: t.transport, clientInfo: false });
    const r = client.request("tools/list", {}, { idempotent: true, timeoutMs: 5_000 });
    await tick();
    expect(client.inFlightCount).toBe(1);
    t.answer(0);
    const out = await r;
    expect(out.kind).toBe("ok");
    expect(out.meta.attempts).toBe(1);
    expect(out.meta.requestId).toBe(r.id);
    expect(client.inFlightCount).toBe(0);
    // cancel after settlement is inert: the settled context is gone, outcome stays ok
    r.cancel("late");
    expect((await r).kind).toBe("ok");
    expect(client.inFlightCount).toBe(0);
  });

  it("[ARCH-REQ-2] transport holds no per-request signal after settlement; client close does not abort settled signals", async () => {
    const t = makeHeldTransport();
    const client = new RequestManager({ transport: t.transport, clientInfo: false });
    const r = client.request("tools/list", {}, { idempotent: true });
    await tick();
    t.answer(0);
    await r;
    expect(client.inFlightCount).toBe(0);
    await client.close();
    // close() aborts only in-flight signals; the settled request's signal was dropped and stays untouched
    expect(t.signals[0]!.aborted).toBe(false);
  });

  it("[ARCH-REQ-3] cancelling request A does not affect request B or the transport", async () => {
    const t = makeHeldTransport();
    const client = new RequestManager({ transport: t.transport, clientInfo: false });
    const a = client.request("tools/list", { a: 1 }, { idempotent: true });
    const b = client.request("tools/list", { b: 1 }, { idempotent: true });
    await tick();
    expect(t.pending).toHaveLength(2);
    a.cancel("user");
    const outA = await a;
    expect(outA.kind).toBe("cancelled");
    expect(t.pending[1]!.signal.aborted).toBe(false);
    expect(t.closedCount()).toBe(0);
    expect(client.inFlightCount).toBe(1);
    t.answer(1);
    expect((await b).kind).toBe("ok");
    // transport still usable for a fresh request
    const c = client.request("tools/list", { c: 1 }, { idempotent: true });
    await tick();
    t.answer(2);
    expect((await c).kind).toBe("ok");
  });

  it("[ARCH-LIFE-1] closing the client settles every in-flight request with a classified outcome", async () => {
    const t = makeHeldTransport();
    const client = new RequestManager({ transport: t.transport, clientInfo: false });
    const read = client.request("tools/list", {}, { idempotent: true });
    const write = client.request("tools/call", { name: "x" });
    await tick();
    expect(client.inFlightCount).toBe(2);
    await client.close();
    const [o1, o2] = await Promise.all([read, write]);
    expect(o1.kind).toBe("cancelled");
    expect(o2.kind).toBe("cancelled");
    if (o1.kind === "cancelled") expect(o1.wasSent).toBe(false);
    expect(client.inFlightCount).toBe(0);
    expect(t.closedCount()).toBe(1);
    const after = await client.request("tools/list");
    expect(after.kind).toBe("transport-failure");
    if (after.kind === "transport-failure") expect(after.failure.kind).toBe("closed");
  });
});
