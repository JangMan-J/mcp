import { describe, expect, it, vi } from "vitest";
import { DurableCalls, type CallRecord, type DurableCallStore, type PerKeyMutex, type RequestIntent } from "./calls.ts";

type Rec = CallRecord<string, { id: number }>;
class FakeStore implements DurableCallStore<string, { id: number }> {
  constructor(
    private backing: Map<string, Rec>,
    private events: string[],
    private crashOnOutcome = false,
  ) {}
  async get(key: string) { return this.backing.get(key); }
  async commitIntent(key: string, request: string, meta?: { attempts: number }) {
    this.events.push("intent");
    this.backing.set(key, { status: "intent", request, ...(meta ? { meta } : {}) });
  }
  async commitOutcome(key: string, result: { id: number }) {
    if (this.crashOnOutcome) throw new Error("crash after send");
    this.events.push("outcome");
    this.backing.set(key, { status: "completed", result });
  }
}
class FakeMutex implements PerKeyMutex {
  private tails = new Map<string, Promise<unknown>>();
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const cur = new Promise<void>((r) => (release = r));
    this.tails.set(key, prev.then(() => cur));
    await prev;
    try { return await fn(); } finally { release(); }
  }
}
const setup = (backing = new Map<string, Rec>(), events: string[] = [], crash = false) =>
  new DurableCalls<string, { id: number }>({ store: new FakeStore(backing, events, crash), mutex: new FakeMutex() });

describe("DurableCalls", () => {
  it("commits intent, sends, commits outcome in order, then replays exact result", async () => {
    const events: string[] = [];
    const calls = setup(new Map(), events);
    const result = { id: 1 };
    const send = vi.fn(async (_req: string) => { events.push("send"); return result; });
    await expect(calls.execute("k1", "req", send)).resolves.toEqual({ status: "completed", result });
    expect(events).toEqual(["intent", "send", "outcome"]);
    const replay = await calls.execute("k1", "req", vi.fn(async () => ({ id: 2 })));
    expect(replay.status).toBe("completed");
    if (replay.status === "completed") expect(replay.result).toBe(result);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("checks completed record identity before replaying the result", async () => {
    const intent: RequestIntent = { method: "tools/call", server: "s", name: "write", digest: "d1", requestId: "r1" };
    const request = JSON.stringify(intent);
    const result = { id: 4 };
    const backing = new Map<string, Rec>([["completed", { status: "completed", request, result }]]);
    const send = vi.fn(async (_req: string) => ({ id: 5 }));
    const calls = setup(backing, []);
    const describe = (r: string): RequestIntent => JSON.parse(r) as RequestIntent;

    await expect(calls.execute("completed", request, send, { describe })).resolves.toEqual({ status: "completed", result });
    for (const patch of [{ method: "other" }, { server: "other" }, { name: "other" }, { digest: "other" }]) {
      const conflicting = JSON.stringify({ ...intent, ...patch });
      await expect(calls.execute("completed", conflicting, send, { describe })).rejects.toThrow("conflicting intent identity");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("crash after send: reopened store reports interrupted without resending", async () => {
    const backing = new Map<string, Rec>();
    const send = vi.fn(async (_req: string) => ({ id: 7 }));
    await expect(setup(backing, [], true).execute("k2", "req", send)).rejects.toThrow("crash after send");
    expect(backing.get("k2")?.status).toBe("intent");
    const reopened = setup(backing, []);
    await expect(reopened.execute("k2", "req", send)).resolves.toEqual({ status: "interrupted" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent calls for the same key under the mutex", async () => {
    const calls = setup();
    const send = vi.fn(async (_req: string) => ({ id: 3 }));
    const [a, b] = await Promise.all([calls.execute("k3", "r", send), calls.execute("k3", "r", send)]);
    expect(a).toEqual({ status: "completed", result: { id: 3 } });
    expect(b).toEqual(a);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("[PICD-3] [PICD-6] [PICD-8] acceptDuplicate restarts interrupted call, persists attempts, honors restartLimit", async () => {
    const backing = new Map<string, Rec>();
    backing.set("k4", { status: "intent", request: "req" });
    const send = vi.fn(async (_req: string) => ({ id: 9 }));
    const calls = setup(backing, []);
    await expect(calls.execute("k4", "req", send, { acceptDuplicate: true })).resolves.toEqual({ status: "completed", result: { id: 9 } });
    expect(send).toHaveBeenCalledWith("req");
    backing.set("k5", { status: "intent", request: "req", meta: { attempts: 2 } });
    await expect(calls.execute("k5", "req", send, { acceptDuplicate: true })).resolves.toEqual({ status: "interrupted" });
    backing.set("k6", { status: "intent", request: "req" });
    await expect(calls.execute("k6", "req", send)).resolves.toEqual({ status: "interrupted" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("[PICD-3] read-only policy replays with a fresh request ID; legacy records without meta work", async () => {
    const backing = new Map<string, Rec>([["r1", { status: "intent", request: "id0" }]]);
    const send = vi.fn(async (_req: string) => ({ id: 1 }));
    const out = await setup(backing, []).execute("r1", "id0", send, {
      tool: "read", readOnlyTools: ["read"], restartRequest: (_r, n) => `id${n}`,
    });
    expect(out.status).toBe("completed");
    expect(send).toHaveBeenCalledWith("id2");
    expect(backing.get("r1")).toMatchObject({ status: "completed" });
  });

  it("[PICD-6] non-read-only tool reports host-restart uncertain write", async () => {
    const backing = new Map<string, Rec>([["w1", { status: "intent", request: "x" }]]);
    const send = vi.fn(async (_req: string) => ({ id: 1 }));
    await expect(setup(backing, []).execute("w1", "x", send, { tool: "write", readOnlyTools: ["read"] }))
      .resolves.toEqual({ status: "interrupted", classification: { kind: "uncertain-write", evidence: "host-restart" } });
    expect(send).not.toHaveBeenCalled();
  });

  it("[PICD-3] [PICD-6] MCP write interrupts with structured intent; list defaults replay; conflicts and stale ids rejected", async () => {
    const describe = (r: string): RequestIntent => {
      const [method = "", name, requestId, digest] = r.split("|");
      return {
        method,
        server: "s",
        ...(name ? { name } : {}),
        ...(digest !== undefined ? { digest } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      };
    };
    const send = vi.fn(async (_req: string) => ({ id: 1 }));
    const backing = new Map<string, Rec>([
      ["m1", { status: "intent", request: "tools/call|w|a|d1" }],
      ["m2", { status: "intent", request: "tools/list||a|d" }],
      ["m3", { status: "intent", request: "tasks/list||a|d" }],
      ["m4", { status: "intent", request: "tools/list||a|d" }],
      ["m5", { status: "intent", request: "tools/list||a|d" }],
    ]);
    const calls = setup(backing, []);
    await expect(calls.execute("m1", "tools/call|w|a|d1", send, { describe })).resolves.toEqual({
      status: "interrupted",
      classification: { kind: "uncertain-write", evidence: "host-restart", intent: { method: "tools/call", server: "s", name: "w", digest: "d1", requestId: "a" } },
    });
    await expect(calls.execute("m1", "tools/call|w|a|d2", send, { describe })).rejects.toThrow("conflicting intent identity");
    await expect(calls.execute("m2", "tools/list||a|d", send, { describe, restartRequest: (_r, n) => `tools/list||b${n}|d` }))
      .resolves.toMatchObject({ status: "completed" });
    await expect(calls.execute("m3", "tasks/list||a|d", send, { describe })).resolves.toMatchObject({ status: "interrupted", classification: { kind: "uncertain-write" } });
    await expect(calls.execute("m4", "tools/list||a|d", send, { describe })).rejects.toThrow("stale restart request id");
    await expect(calls.execute("m5", "tools/list||a|d", send, { describe, restartRequest: () => "tools/list||a|x" }))
      .rejects.toThrow("conflicting intent identity");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("[PICD-8] operator per-tool override beats read-only policy and acceptDuplicate", async () => {
    const backing = new Map<string, Rec>([
      ["o1", { status: "intent", request: "x" }],
      ["o2", { status: "intent", request: "x" }],
    ]);
    const send = vi.fn(async (_req: string) => ({ id: 1 }));
    const calls = setup(backing, []);
    await expect(calls.execute("o1", "x", send, { tool: "read", readOnlyTools: ["read"], toolOverrides: { read: "interrupt" } }))
      .resolves.toMatchObject({ status: "interrupted" });
    await expect(calls.execute("o2", "x", send, { tool: "write", toolOverrides: { write: "replay" } }))
      .resolves.toMatchObject({ status: "completed" });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
