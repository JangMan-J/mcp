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
  resolve: (e: ExchangeEnd) => void;
}

/** Transport whose exchanges stay open until answered or aborted. */
function makeHeldTransport() {
  const pending: Pending[] = [];
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
      pending.push({ req, resolve });
      const notifications: AsyncIterable<JsonRpcNotification> = { async *[Symbol.asyncIterator]() {} };
      return { notifications, done };
    },
    async notify() {},
    async close() {},
    diagnostics: { async *[Symbol.asyncIterator](): AsyncIterator<TransportDiagnostic> {} },
  };
  const answer = (i: number) =>
    pending[i]!.resolve({ kind: "response", message: { jsonrpc: "2.0", id: pending[i]!.req.id, result: { ok: i } } });
  return { transport, pending, answer };
}

const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe("[LIM-CONC-1] in-flight cap with FIFO queue", () => {
  it("[LIM-CONC-1] defaults to 256 in flight; over-cap requests are queued and not sent", async () => {
    const t = makeHeldTransport();
    const client = new RequestManager({ transport: t.transport, clientInfo: false });
    const reqs = Array.from({ length: 258 }, (_, i) => client.request("tools/list", { i }, { idempotent: true }));
    await tick();
    expect(t.pending.length).toBe(256);
    expect(client.inFlightCount).toBe(256);
    let settled = false;
    void reqs[256]!.then(() => (settled = true));
    await tick();
    expect(settled).toBe(false);
    for (let i = 0; i < 256; i++) t.answer(i);
    await tick();
    expect(t.pending.length).toBe(258);
    t.answer(256);
    t.answer(257);
    const outs = await Promise.all(reqs);
    expect(outs.every((o) => o.kind === "ok")).toBe(true);
  });

  it("[LIM-CONC-1] oldest queued request starts when an in-flight request settles", async () => {
    const t = makeHeldTransport();
    const client = new RequestManager({ transport: t.transport, clientInfo: false, limits: { maxInFlight: 1 } });
    const a = client.request("tools/list", { n: "a" }, { idempotent: true });
    const b = client.request("tools/list", { n: "b" }, { idempotent: true });
    const c = client.request("tools/list", { n: "c" }, { idempotent: true });
    await tick();
    expect(t.pending.map((p) => p.req.params?.["n"])).toEqual(["a"]);
    t.answer(0);
    expect((await a).kind).toBe("ok");
    await tick();
    expect(t.pending.map((p) => p.req.params?.["n"])).toEqual(["a", "b"]);
    expect(client.inFlightCount).toBe(1);
    t.answer(1);
    expect((await b).kind).toBe("ok");
    await tick();
    expect(t.pending.map((p) => p.req.params?.["n"])).toEqual(["a", "b", "c"]);
    t.answer(2);
    expect((await c).kind).toBe("ok");
  });

  it("[LIM-CONC-1] aborting a queued request removes it; it never reaches the wire", async () => {
    const t = makeHeldTransport();
    const client = new RequestManager({ transport: t.transport, clientInfo: false, limits: { maxInFlight: 1 } });
    const a = client.request("tools/list", { n: "a" }, { idempotent: true });
    const ctl = new AbortController();
    const b = client.request("tools/call", { n: "b" }, { signal: ctl.signal });
    const c = client.request("tools/list", { n: "c" }, { idempotent: true });
    await tick();
    ctl.abort();
    const outB = await b;
    expect(outB.kind).toBe("cancelled");
    if (outB.kind === "cancelled") {
      expect(outB.wasSent).toBe(false);
      expect(outB.phase).toBe("queue");
    }
    t.answer(0);
    expect((await a).kind).toBe("ok");
    await tick();
    expect(t.pending.map((p) => p.req.params?.["n"])).toEqual(["a", "c"]);
    t.answer(1);
    expect((await c).kind).toBe("ok");
  });
});
