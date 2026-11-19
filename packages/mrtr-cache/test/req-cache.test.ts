import { describe, expect, it, vi } from "vitest";
import { NotificationQueue, type JsonRpcNotification, type Outcome, type StreamHandle } from "@mcp-client/core";
import {
  MrtrSession,
  ResultCache,
  SubscriptionManager,
  SUBSCRIPTION_ID,
  removedElicitationNotification,
  type CacheEntry,
  type RequestFn,
  type ResultCacheStore,
} from "../src/index.js";

const ctx = { serverRef: "server", authContextId: "grant" };
const meta = { binding: "test", requestId: 1, method: "x", attempts: 1 };
const okv = (extra: Record<string, unknown> = {}, pad = 0): Outcome<unknown> => ({
  kind: "ok",
  value: { resultType: "complete", ttlMs: 60_000, ...extra, ...(pad ? { pad: "x".repeat(pad) } : {}) },
  meta,
});
const read = (c: ResultCache, uri: string, req: RequestFn, auth = ctx) => c.run(auth, "resources/read", { uri }, {}, req);

describe("MRTR deadline", () => {
  it("[MRTR-LOOP-2] default overall deadline is 5 minutes; consent wait is not charged to the per-request timeout", async () => {
    let now = 0;
    const clock = { now: () => now, setTimeout: () => () => {} };
    const seen: (number | undefined)[] = [];
    const req = vi.fn(async (_m: string, _p: unknown, o: { timeoutMs?: number }) => {
      seen.push(o.timeoutMs);
      return { kind: "ok" as const, value: { resultType: "input_required", requestState: "s" }, meta };
    });
    const run = async (at: number) => {
      now = 0;
      const m = new MrtrSession(req as unknown as RequestFn, { serverLabel: "x", clock });
      const o = await m.run("tools/call", {}, { mrtr: "manual", timeoutMs: 1000 });
      if (o.kind !== "mrtr-interim") throw Error(o.kind);
      now = at; // time spent waiting for consent
      return o.resume();
    };
    // Inside the 5 minute deadline a long consent wait still gets the full per-request timeout.
    expect((await run(299_999)).kind).toBe("mrtr-interim");
    expect(seen.at(-1)).toBe(1000);
    // At 5 minutes the overall deadline ends the loop without another request.
    const before = req.mock.calls.length;
    expect(await run(300_000)).toMatchObject({ kind: "limit-exceeded", detail: { reason: "mrtr-deadline" } });
    expect(req.mock.calls.length).toBe(before + 1); // only the initial round of that run
  });
});

describe("elicitation removal / old subscription methods (excluded rows)", () => {
  it("[ELIC-REM-1] notifications/elicitation/complete is dropped and counted; -32042 is not special-cased", async () => {
    const diag: string[] = [];
    expect(removedElicitationNotification("notifications/elicitation/complete", (r) => diag.push(r))).toBe(true);
    expect(diag).toEqual(["removed-elicitation-notification"]);
    expect(removedElicitationNotification("notifications/tools/list_changed", (r) => diag.push(r))).toBe(false);
    expect(diag).toHaveLength(1);
    const err: Outcome<unknown> = { kind: "jsonrpc-error", code: -32042, message: "url elicitation", meta } as Outcome<unknown>;
    const out = await new MrtrSession((async () => err) as RequestFn, { serverLabel: "x" }).run("tools/call", {});
    expect(out).toMatchObject({ kind: "jsonrpc-error", code: -32042 });
  });
});

class FakeStream implements StreamHandle {
  readonly queue = new NotificationQueue<JsonRpcNotification>();
  closed = false;
  finish!: (o: Outcome<unknown>) => void;
  readonly done = new Promise<Outcome<unknown>>((r) => (this.finish = r));
  constructor(readonly id: number, private readonly log: string[]) {}
  [Symbol.asyncIterator]() {
    return this.queue[Symbol.asyncIterator]();
  }
  close() {
    this.closed = true;
    this.log.push(`close:${this.id}`);
    this.queue.close();
  }
  ack(notifications: Record<string, unknown>) {
    this.log.push(`ack:${this.id}`);
    this.queue.push({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { notifications, _meta: { [SUBSCRIPTION_ID]: this.id } },
    });
  }
}
const tick = async () => {
  for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r));
};
function harness(binding: "http" | "stdio" = "http", extra: Record<string, unknown> = {}) {
  const log: string[] = [];
  const streams: FakeStream[] = [];
  const methods: string[] = [];
  const diag: string[] = [];
  const mgr = new SubscriptionManager({
    open: (method) => {
      methods.push(method);
      const s = new FakeStream(streams.length + 1, log);
      streams.push(s);
      log.push(`open:${s.id}`);
      return s;
    },
    binding,
    serverRef: "server",
    clock: { now: () => 0, setTimeout: () => () => {} },
    diagnostic: (r) => diag.push(r),
    ...extra,
  });
  return { mgr, streams, log, methods, diag };
}

describe("subscriptions", () => {
  it("[SUB-CHANGE-1] a filter change opens the new listen, waits for its ack, then closes the old one", async () => {
    const { mgr, streams, log } = harness();
    const old = mgr.listen({ tools: true });
    streams[0]!.ack({ toolsListChanged: true });
    await old.acknowledged;
    const p = mgr.change(old, { tools: true, prompts: true });
    await tick();
    expect(streams).toHaveLength(2);
    expect(old.state).toBe("active"); // no gap: old stays until the new one is acknowledged
    expect(streams[0]!.closed).toBe(false);
    streams[1]!.ack({ toolsListChanged: true, promptsListChanged: true });
    const next = await p;
    expect(next.state).toBe("active");
    expect(old.state).toBe("ended");
    expect(streams[0]!.closed).toBe(true);
    expect(log.slice(log.indexOf("open:2"))).toEqual(["open:2", "ack:2", "close:1"]);
  });

  it("[SUB-END-3] transport close without the graceful result ends with reason transport", async () => {
    const { mgr, streams } = harness("http", { reconnect: "never" });
    const sub = mgr.listen({ tools: true });
    streams[0]!.ack({ toolsListChanged: true });
    await sub.acknowledged;
    streams[0]!.finish({ kind: "transport-failure", failure: { kind: "closed", message: "eof" }, meta } as Outcome<unknown>);
    await tick();
    expect(sub.state).toBe("ended");
    expect(sub.reason).toBe("transport");
  });

  it("[SUB-OLD-1] only subscriptions/listen is ever sent; resources/subscribe and unsubscribe never are", async () => {
    const { mgr, streams, methods } = harness();
    const sub = mgr.listen({ resourceUris: ["file:///a"], tools: true });
    streams[0]!.ack({ toolsListChanged: true, resourceSubscriptions: ["file:///a"] });
    await sub.acknowledged;
    sub.close();
    expect(methods).toEqual(["subscriptions/listen"]);
    const fs = await import("node:fs");
    const src = fs.readdirSync(new URL("../src/", import.meta.url));
    for (const f of src) {
      const txt = fs.readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
      expect(txt, f).not.toMatch(/resources\/(un)?subscribe/);
    }
  });
});

describe("cache", () => {
  it("[CACHE-SF-1] identical misses coalesce; other auth contexts and abort signals are not coalesced", async () => {
    const c = new ResultCache();
    const a = new AbortController();
    const b = new AbortController();
    const work: ((o: Outcome<unknown>) => void)[] = [];
    const req: RequestFn = () => new Promise((r) => work.push(r));
    const run = (signal: AbortSignal | undefined, auth: string) =>
      c.run({ ...ctx, authContextId: auth }, "tools/list", {}, signal ? { signal } : {}, req);
    const calls = [run(undefined, "1"), run(undefined, "1")];
    await tick();
    expect(work).toHaveLength(1);
    calls.push(run(undefined, "2"));
    calls.push(run(a.signal, "1"), run(a.signal, "1"), run(b.signal, "1"));
    await tick();
    expect(work).toHaveLength(4); // none, auth 2, signal a (coalesced pair), signal b
    for (const w of work) w(okv());
    await Promise.all(calls);
  });

  it("[CACHE-LIMIT-1] 4 MiB per entry, 32 MiB total and 500 entries caps, LRU eviction", async () => {
    const now = () => 0;
    // per entry: a 5 MiB blob is returned but not cached
    let c = new ResultCache({ now });
    let n = 0;
    const big: RequestFn = async () => (n++, okv({}, 5 * 1024 * 1024));
    expect((await read(c, "big", big)).kind).toBe("ok");
    expect((await read(c, "big", big)).meta.cache).toBe("miss");
    expect(n).toBe(2);
    // total: nine ~4,000,000 byte entries exceed 32 MiB, so the least recently used goes
    c = new ResultCache({ now });
    const mid: RequestFn = async () => okv({}, 4_000_000);
    for (let i = 0; i < 9; i++) await read(c, `u${i}`, mid);
    expect((await read(c, "u8", mid)).meta.cache).toBe("hit");
    expect((await read(c, "u0", mid)).meta.cache).toBe("miss");
    // count: 501 small entries evict the first
    c = new ResultCache({ now });
    const small: RequestFn = async () => okv();
    for (let i = 0; i < 501; i++) await read(c, `s${i}`, small);
    expect((await read(c, "s500", small)).meta.cache).toBe("hit");
    expect((await read(c, "s1", small)).meta.cache).toBe("hit");
    expect((await read(c, "s0", small)).meta.cache).toBe("miss");
  });

  it("[CACHE-STORE-1] default store is in-memory; an external store only holds entries it can isolate", async () => {
    const req: RequestFn = async () => okv({ cacheScope: "private" });
    const pub: RequestFn = async () => okv({ cacheScope: "public" });
    const now = () => 0;
    const memOnly = new ResultCache({ now });
    await read(memOnly, "a", req);
    expect((await read(memOnly, "a", req)).meta.cache).toBe("hit");

    const store = new Map<string, CacheEntry>();
    const c1 = new ResultCache({ now, store: store as unknown as ResultCacheStore, sharePublic: true });
    await read(c1, "p", req);
    expect(store.size).toBe(0); // private stays in memory
    expect((await read(c1, "p", req)).meta.cache).toBe("hit");
    await read(c1, "q", pub);
    expect(store.size).toBe(1); // public shared entry may persist
    // another principal sees the public entry but never the private one
    const other = { ...ctx, authContextId: "other" };
    expect((await read(c1, "q", pub, other)).meta.cache).toBe("hit");
    expect((await read(c1, "p", req, other)).meta.cache).toBe("miss");

    const iso = Object.assign(new Map<string, CacheEntry>(), { perPrincipalIsolation: true });
    const c2 = new ResultCache({ now, store: iso as unknown as ResultCacheStore });
    await read(c2, "p", req);
    expect(iso.size).toBe(1);
  });

  it("[CACHE-OBS-1] outcome meta.cache reports miss, hit, stale and bypass", async () => {
    let time = 0;
    const c = new ResultCache({ now: () => time, staleIfError: true });
    let out: Outcome<unknown> = okv({ ttlMs: 100 });
    const req: RequestFn = async () => out;
    expect((await read(c, "a", req)).meta.cache).toBe("miss");
    expect((await read(c, "a", req)).meta.cache).toBe("hit");
    expect((await c.run(ctx, "tools/call", {}, {}, req)).meta.cache).toBe("bypass");
    time = 150;
    out = { kind: "transport-failure", failure: { kind: "closed", message: "down" }, meta } as Outcome<unknown>;
    expect((await read(c, "a", req)).meta.cache).toBe("stale");
  });
});
