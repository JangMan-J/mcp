import { describe, expect, it } from "vitest";
import type { Outcome, StreamHandle } from "@mcp-client/core";
import { ResultCache, SubscriptionManager, type RequestFn } from "../src/index.js";

const ok = (value: unknown): Outcome<unknown> =>
  ({ kind: "ok", value, meta: { requestId: 1, method: "m", binding: "stdio", attempts: 1 } }) as Outcome<unknown>;

describe("local limits", () => {
  it("[LIM-SUB-2] caps resourceSubscriptions on one listen request (default 1000)", () => {
    const opened: unknown[] = [];
    const mgr = new SubscriptionManager({
      binding: "stdio",
      serverRef: "s",
      open: (_m, p) => {
        opened.push(p);
        throw new Error("stop after open");
      },
    });
    const uris = (n: number) => Array.from({ length: n }, (_, i) => `file:///r${i}`);
    expect(() => mgr.listen({ resourceUris: uris(1001) })).toThrow(RangeError);
    expect(opened).toHaveLength(0);
    // at the cap the request is not rejected by the limit
    try {
      mgr.listen({ resourceUris: uris(1000) });
    } catch (e) {
      expect(e).not.toBeInstanceOf(RangeError);
    }
    const small = new SubscriptionManager({
      binding: "stdio",
      serverRef: "s",
      maxResourceUris: 2,
      open: () => {
        throw new Error("unused");
      },
    });
    expect(() => small.listen({ resourceUris: uris(3) })).toThrow(/too many subscription URIs/);
  });
});

describe("architecture invariants (Plan 4.6)", () => {
  it("[ARCH-SF-1] single-flight coalesces same key only within one auth context", async () => {
    const c = new ResultCache();
    const signal = new AbortController().signal;
    const work: ((o: Outcome<unknown>) => void)[] = [];
    const req: RequestFn = () => new Promise((r) => work.push(r));
    const run = (auth: string) => c.run({ serverRef: "s", authContextId: auth }, "tools/list", {}, { signal }, req);
    const p = [run("alice"), run("alice"), run("bob")] as const;
    await Promise.resolve();
    await Promise.resolve();
    // alice x2 coalesce into one upstream call; bob gets his own
    expect(work).toHaveLength(2);
    work[0]!(ok({ who: "alice" }));
    work[1]!(ok({ who: "bob" }));
    const [a1, a2, b] = await Promise.all(p);
    expect(a1.kind === "ok" && a1.value).toEqual({ who: "alice" });
    expect(a2.kind === "ok" && a2.value).toEqual({ who: "alice" });
    expect(b.kind === "ok" && b.value).toEqual({ who: "bob" });
  });

  it("[ARCH-STATE-1] cache lives on the client and survives a transport restart; reconnect invalidates explicitly", async () => {
    const cache = new ResultCache();
    const ctx = { serverRef: "s", authContextId: "g" };
    let calls = 0;
    // "transport 1" and "transport 2" are separate request functions; the cache is independent of either
    const t1: RequestFn = async () => (calls++, ok({ gen: 1, ttlMs: 60_000, resultType: "complete" }));
    const t2: RequestFn = async () => (calls++, ok({ gen: 2, ttlMs: 60_000, resultType: "complete" }));
    await cache.run(ctx, "tools/list", {}, {}, t1);
    await cache.run(ctx, "server/discover", {}, {}, t1);
    expect(calls).toBe(2);
    const hit = await cache.run(ctx, "tools/list", {}, {}, t2);
    expect(calls).toBe(2);
    expect(hit.kind === "ok" && hit.value).toMatchObject({ gen: 1 });
    // reconnect path flags the restart: discover is explicitly invalidated
    const mgr = new SubscriptionManager({
      binding: "http",
      serverRef: "s",
      cache,
      open: () => ({}) as StreamHandle,
    });
    mgr.reconnected();
    const disc = await cache.run(ctx, "server/discover", {}, {}, t2);
    expect(calls).toBe(3);
    expect(disc.kind === "ok" && disc.value).toMatchObject({ gen: 2 });
  });
});
