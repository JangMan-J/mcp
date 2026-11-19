import { describe, expect, it, vi } from "vitest";
import type { Outcome } from "@mcp-client/core";
import { ResultCache, type RequestFn } from "../src/index.js";

const ctx = { serverRef: "server", authContextId: "grant" };
const meta = { binding: "test", requestId: 1, method: "resources/read", attempts: 1 };
const okv = (text: string): Outcome<unknown> => ({
  kind: "ok",
  value: { resultType: "complete", ttlMs: 60_000, contents: [{ text }] },
  meta,
});
const cancelled: Outcome<unknown> = { kind: "cancelled", wasSent: true, phase: "wire", meta };

/** Request fn that stays in flight until released, but settles as cancelled when its own signal aborts. */
const deferredWire = () => {
  const releases: ((o: Outcome<unknown>) => void)[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const fn = vi.fn(
    (_m: string, _p: unknown, o: { signal?: AbortSignal }) =>
      new Promise<Outcome<unknown>>((resolve) => {
        signals.push(o.signal);
        releases.push(resolve);
        o.signal?.addEventListener("abort", () => resolve(cancelled), { once: true });
      }),
  );
  return { fn, releases, signals };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("[EDGE-38] single-flight and per-waiter abort", () => {
  it("[EDGE-38] aborting one waiter leaves the other to complete (independent signals take separate flights)", async () => {
    const cache = new ResultCache();
    const wire = deferredWire();
    const a = new AbortController();
    const b = new AbortController();
    const p1 = cache.run(ctx, "resources/read", { uri: "file:///x" }, { signal: a.signal }, wire.fn as unknown as RequestFn);
    const p2 = cache.run(ctx, "resources/read", { uri: "file:///x" }, { signal: b.signal }, wire.fn as unknown as RequestFn);
    await tick();
    // Both waiters are in flight before the abort.
    expect(wire.fn).toHaveBeenCalledTimes(2);
    a.abort();
    const first = await p1;
    expect(first.kind).toBe("cancelled");
    // The other waiter's request is untouched by the first abort.
    expect(wire.signals[1]).toBe(b.signal);
    expect(wire.signals[1]?.aborted).toBe(false);
    wire.releases[1]!(okv("server value"));
    const second = await p2;
    expect(second).toMatchObject({ kind: "ok", value: { contents: [{ text: "server value" }] } });
  });

  it("[EDGE-38] waiters sharing the same signal coalesce into one wire call (single-flight boundary)", async () => {
    const cache = new ResultCache();
    const wire = deferredWire();
    const shared = new AbortController();
    const p1 = cache.run(ctx, "resources/read", { uri: "file:///y" }, { signal: shared.signal }, wire.fn as unknown as RequestFn);
    const p2 = cache.run(ctx, "resources/read", { uri: "file:///y" }, { signal: shared.signal }, wire.fn as unknown as RequestFn);
    await tick();
    expect(wire.fn).toHaveBeenCalledTimes(1);
    wire.releases[0]!(okv("one"));
    const [o1, o2] = await Promise.all([p1, p2]);
    expect(o1).toMatchObject({ kind: "ok", value: { contents: [{ text: "one" }] } });
    expect(o2).toMatchObject({ kind: "ok", value: { contents: [{ text: "one" }] } });
    expect(wire.fn).toHaveBeenCalledTimes(1);
  });
});
