import { describe, it, expect, vi } from "vitest";
import type { Outcome, StreamHandle, JsonRpcNotification } from "@mcp-client/core";
import { ResultCache, MrtrSession, SubscriptionManager, type RequestFn } from "../src/index.js";

const ctx = { serverRef: "server", authContextId: "grant" },
  meta = { binding: "test", requestId: 1, method: "tools/list", attempts: 1 };

describe("EDGE-18", () => {
  const value = (ttl?: unknown): Outcome<unknown> => ({
    kind: "ok",
    value: { resultType: "complete", tools: [], ...(ttl !== undefined && { ttlMs: ttl }) },
    meta,
  });
  it.each([
    ["absent", undefined],
    ["negative", -5],
  ])("[EDGE-18] ttlMs %s is treated as 0 (stale immediately, refetched)", async (_, ttl) => {
    const c = new ResultCache({ now: () => 0 });
    const req = vi.fn<RequestFn>(async () => value(ttl));
    await c.run(ctx, "tools/list", {}, {}, req);
    const second = await c.run(ctx, "tools/list", {}, {}, req);
    expect(second.meta.cache).toBe("miss");
    expect(req).toHaveBeenCalledTimes(2);
  });
  it("[EDGE-18] control: positive ttlMs is served from cache", async () => {
    const c = new ResultCache({ now: () => 0 });
    const req = vi.fn<RequestFn>(async () => value(100));
    await c.run(ctx, "tools/list", {}, {}, req);
    expect((await c.run(ctx, "tools/list", {}, {}, req)).meta.cache).toBe("hit");
    expect(req).toHaveBeenCalledTimes(1);
  });
});

describe("EDGE-23", () => {
  it("[EDGE-23] repeated input_required stops at the 8-round cap", async () => {
    const req = vi.fn<RequestFn>(async () => ({
      kind: "ok",
      value: { resultType: "input_required", requestState: "again" },
      meta,
    }));
    const m = new MrtrSession(req, { serverLabel: "s" });
    const out = await m.run("tools/call", { name: "t" });
    expect(out).toMatchObject({ kind: "limit-exceeded", detail: { reason: "max-rounds" } });
    // initial request + 8 continuation rounds, then stop
    expect(req).toHaveBeenCalledTimes(9);
    expect(out.meta.trace).toHaveLength(8);
  });
});

describe("EDGE-25", () => {
  it("[EDGE-25] listen ack never arrives -> timeout and close", async () => {
    const timers: { fn: () => void; ms: number; live: boolean }[] = [];
    const clock = {
      now: () => 0,
      setTimeout(fn: () => void, ms: number) {
        const t = { fn, ms, live: true };
        timers.push(t);
        return () => {
          t.live = false;
        };
      },
    };
    const close = vi.fn();
    const stream: StreamHandle = {
      id: 7,
      done: new Promise(() => {}),
      close,
      async *[Symbol.asyncIterator](): AsyncIterator<JsonRpcNotification> {
        await new Promise(() => {});
      },
    };
    const mgr = new SubscriptionManager({
      open: () => stream,
      binding: "stdio",
      serverRef: "server",
      clock,
      ackTimeoutMs: 1234,
    });
    const sub = mgr.listen({ tools: true });
    expect(sub.state).toBe("opening");
    const t = timers.find((x) => x.live && x.ms === 1234);
    expect(t).toBeDefined();
    t!.fn();
    expect(sub.state).toBe("ended");
    expect(sub.reason).toBe("transport-failure/no-ack");
    expect(close).toHaveBeenCalled();
    await expect(sub.acknowledged).rejects.toThrow("transport-failure/no-ack");
  });
});
