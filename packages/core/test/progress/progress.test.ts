import { describe, expect, it } from "vitest";
import {
  McpClient,
  META_PROGRESS_TOKEN,
  NotificationQueue,
  parseProgressParams,
  ProgressRegistry,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type ProgressEvent,
  type Transport,
} from "../../src/index.js";

describe("ProgressRegistry (PROG-1..5)", () => {
  it("rejects a second registration of an active token (PROG-1)", () => {
    const r = new ProgressRegistry();
    expect(r.register(1)).toBe(true);
    expect(r.register(1)).toBe(false);
    expect(r.register("1")).toBe(true);
    expect(r.stats().collisions).toBe(1);
  });

  it("drops non-increasing values and counts them (PROG-2, EDGE-8)", () => {
    const r = new ProgressRegistry();
    r.register("t");
    const vals = [1, 1, 0.5, 2, 2, 3].map((v) => r.accept({ progressToken: "t", progress: v }).accept);
    expect(vals).toEqual([true, false, false, true, false, true]);
    expect(r.stats().nonMonotonic).toBe(3);
  });

  it("drops unknown and released tokens as inactive (PROG-3/4)", () => {
    const r = new ProgressRegistry();
    r.register(7);
    expect(r.accept({ progressToken: 8, progress: 1 })).toEqual({ accept: false, reason: "inactive" });
    r.release(7);
    expect(r.accept({ progressToken: 7, progress: 1 })).toEqual({ accept: false, reason: "inactive" });
    expect(r.stats()).toMatchObject({ inactive: 2, active: 0 });
  });

  it("drops a token that belongs to a different active request as foreign", () => {
    const r = new ProgressRegistry();
    r.register(1);
    r.register(2);
    expect(r.accept({ progressToken: 2, progress: 1 }, 1)).toEqual({ accept: false, reason: "foreign" });
  });

  it("accepts finite floats and rejects non-finite or malformed values (PROG-5)", () => {
    expect(parseProgressParams({ progressToken: 1, progress: 0.25, total: 1.5, message: "m" })).toEqual({
      progressToken: 1,
      progress: 0.25,
      total: 1.5,
      message: "m",
    });
    expect(parseProgressParams({ progressToken: 1, progress: Number.NaN })).toBeUndefined();
    expect(parseProgressParams({ progressToken: 1, progress: 1, total: Infinity })).toBeUndefined();
    expect(parseProgressParams({ progressToken: null, progress: 1 })).toBeUndefined();
    expect(parseProgressParams({ progressToken: 1.5, progress: 1 })).toBeUndefined();
    expect(parseProgressParams({ progressToken: 1, progress: 1, message: 3 })).toBeUndefined();
  });
});

describe("NotificationQueue", () => {
  it("drains buffered items before ending and ignores pushes after close", async () => {
    const q = new NotificationQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    expect(q.push(3)).toBe(false);
    const got: number[] = [];
    for await (const v of q) got.push(v);
    expect(got).toEqual([1, 2]);
  });
});

describe("progress and live notification streaming through McpClient", () => {
  function pushTransport() {
    const queues: { req: JsonRpcRequest; q: NotificationQueue<JsonRpcNotification>; resolve(e: ExchangeEnd): void }[] = [];
    const transport: Transport = {
      binding: "stdio",
      start(req) {
        const q = new NotificationQueue<JsonRpcNotification>();
        let resolve!: (e: ExchangeEnd) => void;
        const done = new Promise<ExchangeEnd>((r) => {
          resolve = r;
        });
        queues.push({ req, q, resolve });
        return { notifications: q, done };
      },
      async notify() {},
      async close() {},
      diagnostics: { async *[Symbol.asyncIterator]() {} },
    };
    return { transport, queues };
  }
  const tick = () => new Promise<void>((r) => setImmediate(r));
  const prog = (token: unknown, progress: number): JsonRpcNotification => ({
    jsonrpc: "2.0",
    method: "notifications/progress",
    params: { progressToken: token, progress },
  });

  it("mints a token only with onProgress, delivers valid progress, drops the rest", async () => {
    const { transport, queues } = pushTransport();
    const progressRegistry = new ProgressRegistry();
    const client = new McpClient({ transport, server: { key: "s" }, lifecycle: { progressRegistry } });
    const events: ProgressEvent[] = [];
    const req = client.request("tools/call", { name: "job" }, { onProgress: (e) => events.push(e) });
    const plain = client.request("tools/list");
    const e0 = queues[0]!;
    const token = (e0.req.params?.["_meta"] as Record<string, unknown>)[META_PROGRESS_TOKEN];
    expect(token).toBe(req.id);
    expect(META_PROGRESS_TOKEN in (queues[1]!.req.params?.["_meta"] as Record<string, unknown>)).toBe(false);

    e0.q.push(prog(token, 1));
    e0.q.push(prog(token, 1));
    e0.q.push(prog(9999, 2));
    e0.q.push(prog(token, 2.5));
    await tick();
    e0.resolve({ kind: "response", message: { jsonrpc: "2.0", id: e0.req.id, result: {} } });
    await req;
    e0.q.push(prog(token, 3));
    await tick();
    expect(events.map((e) => e.progress)).toEqual([1, 2.5]);
    const collected: number[] = [];
    for await (const p of req.progress) collected.push(p.progress);
    expect(collected).toEqual([1, 2.5]);
    expect(progressRegistry.stats()).toMatchObject({ delivered: 2, nonMonotonic: 1, inactive: 1, active: 0 });

    queues[1]!.resolve({ kind: "response", message: { jsonrpc: "2.0", id: queues[1]!.req.id, result: {} } });
    expect((await plain).kind).toBe("ok");
  });

  it("streams req.notifications and req.progress live before request settlement", async () => {
    const { transport, queues } = pushTransport();
    const client = new McpClient({ transport, server: { key: "s" } });
    let settled = false;
    const req = client.request("tools/call", { name: "stream" }, { onProgress: () => {} });
    void Promise.resolve(req).then(() => {
      settled = true;
    });

    const e0 = queues[0]!;
    const notifIter = req.notifications[Symbol.asyncIterator]();
    const progIter = req.progress[Symbol.asyncIterator]();

    const firstNotifPromise = notifIter.next();
    const firstProgPromise = progIter.next();

    e0.q.push({ jsonrpc: "2.0", method: "notifications/custom", params: { step: "start" } });
    e0.q.push(prog(req.id, 1));

    const firstNotif = await firstNotifPromise;
    const firstProg = await firstProgPromise;

    expect(settled).toBe(false);
    expect(firstNotif).toEqual({
      done: false,
      value: { jsonrpc: "2.0", method: "notifications/custom", params: { step: "start" } },
    });

    const secondNotif = await notifIter.next();
    expect(settled).toBe(false);
    expect(secondNotif).toEqual({
      done: false,
      value: prog(req.id, 1),
    });
    expect(firstProg).toEqual({
      done: false,
      value: { progressToken: req.id, progress: 1 },
    });

    e0.q.push(prog(req.id, 2));
    const secondProg = await progIter.next();
    expect(settled).toBe(false);
    expect(secondProg).toEqual({
      done: false,
      value: { progressToken: req.id, progress: 2 },
    });
    expect((await notifIter.next()).value).toEqual(prog(req.id, 2));

    e0.resolve({ kind: "response", message: { jsonrpc: "2.0", id: e0.req.id, result: { ok: true } } });
    expect((await req).kind).toBe("ok");
    expect(settled).toBe(true);
    expect(await notifIter.next()).toEqual({ done: true, value: undefined });
    expect(await progIter.next()).toEqual({ done: true, value: undefined });
  });
});
