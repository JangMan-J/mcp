import { describe, it, expect, vi } from "vitest";
import {
  McpClient,
  NotificationQueue,
  META_CLIENT_CAPABILITIES,
  type Transport,
  type JsonRpcRequest,
  type Outcome,
} from "@mcp-client/core";
import {
  StatefulClient,
  elicitationExtension,
  ResultCache,
  MrtrSession,
  autoRefresh,
  elicit,
  type RequestFn,
} from "../src/index.js";

const ctx = { serverRef: "server", authContextId: "grant" },
  meta = { binding: "test", requestId: 1, method: "tools/list", attempts: 1 };
const ok = (v: number): Outcome<unknown> => ({
  kind: "ok",
  value: { resultType: "complete", ttlMs: 100, v },
  meta,
});
describe("core integration", () => {
  it("advertises only configured modes; core retry ids advance without carrying earlier state", async () => {
    const sent: JsonRpcRequest[] = [];
    const results = [
      { resultType: "input_required", requestState: " opaque " },
      {
        resultType: "input_required",
        inputRequests: {
          u: {
            method: "elicitation/create",
            params: {
              message: "Visit",
              mode: "url",
              url: "https://example.org/path",
            },
          },
        },
      },
      { resultType: "complete" },
    ];
    const transport: Transport = {
      binding: "stdio",
      diagnostics: new NotificationQueue(),
      start(m) {
        sent.push(m);
        const q = new NotificationQueue<never>();
        q.close();
        return {
          notifications: q,
          done: Promise.resolve({
            kind: "response",
            message: { jsonrpc: "2.0", id: m.id, result: results.shift()! },
          }),
        };
      },
      async notify() {},
      async close() {},
    };
    const options = {
      serverLabel: "configured",
      port: { url: async () => "decline" as const },
      browser: {
        open: async () => {
          throw Error("declined");
        },
      },
    };
    const core = new McpClient({
      transport,
      server: { key: "s" },
      extensions: [elicitationExtension(options)],
    });
    const client = new StatefulClient({
      ...options,
      serverRef: "s",
      request: core.request.bind(core),
    });
    const out = await client.request("tools/call", { name: "t" });
    expect(out.kind).toBe("ok");
    expect(sent.map((m) => m.id)).toEqual([1, 2, 3]);
    for (const s of sent)
      expect(s.params?._meta).toMatchObject({
        [META_CLIENT_CAPABILITIES]: { elicitation: { url: {} } },
      });
    expect(sent[1]!.params).toMatchObject({ requestState: " opaque " });
    expect(sent[2]!.params).not.toHaveProperty("requestState");
    expect(sent[2]!.params).toMatchObject({
      inputResponses: { u: { action: "decline" } },
    });
    await core.close();
  });
  it("a manual continuation expires without a retry or a retained timer", async () => {
    let now = 0;
    const clock = { now: () => now, setTimeout: () => () => {} };
    const req = vi.fn(async () => ({
      kind: "ok" as const,
      value: { resultType: "input_required", requestState: "x" },
      meta,
    }));
    const m = new MrtrSession(req, { serverLabel: "x", clock, deadlineMs: 10 });
    const o = await m.run("prompts/get", {}, { mrtr: "manual" });
    now = 10;
    if (o.kind !== "mrtr-interim") throw Error(o.kind);
    expect(await o.resume()).toMatchObject({ kind: "limit-exceeded" });
    expect(req).toHaveBeenCalledTimes(1);
  });
});

describe("bounded cache and invalidation races", () => {
  it("coalesces only within signal + auth context, and never repopulates after invalidation", async () => {
    const c = new ResultCache(),
      a = new AbortController(),
      b = new AbortController();
    const work: ((out: Outcome<unknown>) => void)[] = [];
    const req: RequestFn = () => new Promise((r) => work.push(r));
    const run = (signal: AbortSignal, id: string) =>
      c.run({ ...ctx, authContextId: id }, "tools/list", {}, { signal }, req);
    const calls = [
      run(a.signal, "1"),
      run(a.signal, "1"),
      run(b.signal, "1"),
      run(a.signal, "2"),
    ];
    await Promise.resolve();
    expect(work).toHaveLength(3);
    c.invalidate("server", "tools/list");
    for (const resolve of work) resolve(ok(2));
    await Promise.all(calls);
    expect(
      (await c.run(ctx, "tools/list", {}, {}, async () => ok(3))).meta.cache,
    ).toBe("miss");
  });
  it("keeps private data in memory and evicts least recently used entries", async () => {
    const store = new Map(),
      c = new ResultCache({ maxEntries: 2, store }),
      req: RequestFn = async () => ok(1);
    const run = (uri: string) => c.run(ctx, "resources/read", { uri }, {}, req);
    await run("a");
    await run("b");
    expect((await run("a")).meta.cache).toBe("hit");
    await run("c");
    expect((await run("b")).meta.cache).toBe("miss");
    expect(store.size).toBe(0);
  });
  it("does not serve stale private entries after a denial", async () => {
    let time = 0;
    const c = new ResultCache({ now: () => time, staleIfError: true });
    let out = ok(1);
    const run = () => c.run(ctx, "tools/list", {}, {}, async () => out);
    await run();
    time = 150;
    out = {
      kind: "transport-failure",
      failure: { kind: "http-status", message: "denied", status: 403 },
      safeToRetry: false,
      meta,
    };
    expect((await run()).kind).toBe("transport-failure");
    out = { ...out, failure: { ...out.failure, status: 503 } };
    expect((await run()).kind).toBe("transport-failure");
  });
});
it("polls only on opt-in with jittered failure backoff and explicit cancellation", async () => {
  vi.useFakeTimers();
  try {
    const work = vi.fn(async () => false);
    const stop = autoRefresh(work, { intervalMs: 100, random: () => 0 });
    await vi.advanceTimersByTimeAsync(49);
    expect(work).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(work).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
it("warns before showing a sensitive field and never prefetches a consent URL", async () => {
  const fetch = vi.fn(() => {
    throw Error("unexpected fetch");
  });
  vi.stubGlobal("fetch", fetch);
  try {
    let fields: string[] = [];
    const o = {
      serverLabel: "s",
      port: {
        form: async (p: { suspectSensitiveFields: string[] }) => {
          fields = p.suspectSensitiveFields;
          return { action: "cancel" as const };
        },
        url: async () => "decline" as const,
      },
      browser: {
        open: async () => {
          throw Error("declined");
        },
      },
    };
    await elicit(
      {
        message: "x",
        requestedSchema: {
          type: "object",
          properties: { api_key: { type: "string" } },
        },
      },
      o,
      new AbortController().signal,
    );
    expect(fields).toEqual(["api_key"]);
    await elicit(
      { mode: "url", message: "visit", url: "https://example.org/" },
      o,
      new AbortController().signal,
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
