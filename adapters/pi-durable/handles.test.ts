import { describe, expect, it, vi } from "vitest";
import { DurableHandles, type DurableHandle, type Request } from "./handles.ts";

function harness(snapshot: unknown = null, now = 1_000) {
  let data = snapshot; let n = 0; const sent: Request[] = [];
  const host = {
    storage: { read: () => data, write: (d: unknown) => { data = d; } },
    send: vi.fn(async (r: Request) => { sent.push(r); return { ok: r.id }; }),
    newId: () => `req-${++n}`, now: () => now,
  };
  return { host, sent, get data() { return data; } };
}

describe("durable handles", () => {
  it("dispatches tasks/get with taskId before expiry", async () => {
    const { host, sent } = harness();
    await new DurableHandles(host).dispatch({ kind: "task", taskId: "t1", expiresAt: 2_000 });
    expect(sent).toEqual([{ id: "req-1", method: "tasks/get", params: { taskId: "t1" } }]);
  });
  it("refuses expired task handles without sending", async () => {
    const { host, sent } = harness(null, 2_000);
    await expect(new DurableHandles(host).dispatch({ kind: "task", taskId: "t1", expiresAt: 2_000 }))
      .rejects.toThrow(/expired/);
    expect(sent).toEqual([]);
  });
  it("retries MRTR with a new distinct id carrying requestState/inputRequests", async () => {
    const { host, sent } = harness();
    const h: DurableHandle = { kind: "mrtr", id: "orig", method: "tools/call", requestState: "rs", inputRequests: { a: { x: 1 } } };
    const d = new DurableHandles(host);
    await d.dispatch(h); await d.dispatch(h);
    expect(sent.map(r => r.id)).toEqual(["req-1", "req-2"]);
    expect(sent[0]).toMatchObject({ method: "tools/call", params: { requestState: "rs", inputRequests: { a: { x: 1 } } } });
  });
  it("sends a fresh listen descriptor without resume for subscriptions", async () => {
    const { host, sent } = harness();
    const h = { kind: "subscription", subscriptions: [{ uri: "x" }], resume: "stale" } as unknown as DurableHandle;
    const d = new DurableHandles(host);
    await d.dispatch(h); await d.dispatch(h);
    expect(sent[0].method).toBe("subscriptions/listen");
    expect(sent[0].params).toEqual({ subscriptions: [{ uri: "x" }] });
    expect(JSON.stringify(sent)).not.toContain("resume");
    expect(sent[0].params).not.toBe(sent[1].params);
    expect(sent.map(r => r.id)).toEqual(["req-1", "req-2"]);
  });
  it("round-trips snapshot data through host storage and restores it", async () => {
    const { host, sent } = harness();
    const d = new DurableHandles(host);
    await d.save({ kind: "task", taskId: "t9" });
    expect(await d.load()).toEqual({ kind: "task", taskId: "t9" });
    await d.restore();
    expect(sent[0]).toMatchObject({ method: "tasks/get", params: { taskId: "t9" } });
  });
  it("loads invalid snapshots as null and rejects invalid saves", async () => {
    const { host } = harness({ kind: "task", taskId: 42 });
    const d = new DurableHandles(host);
    expect(await d.load()).toBeNull();
    expect(await d.restore()).toBeNull();
    await expect(d.save({ kind: "nope" } as unknown as DurableHandle)).rejects.toThrow(/invalid/);
  });
});
