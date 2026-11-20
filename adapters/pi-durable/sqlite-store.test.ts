import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableCalls, type PerKeyMutex } from "./calls.ts";
import { SqliteDurableCallStore } from "./sqlite-store.ts";

class Mutex implements PerKeyMutex {
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

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
function fileStore() {
  const dir = mkdtempSync(join(tmpdir(), "picd-sqlite-"));
  dirs.push(dir);
  const path = join(dir, "calls.db");
  return { path, open: () => new SqliteDurableCallStore<any, any>(path) };
}

const meta = { requestId: "r1", method: "tools/call", binding: "b", attempts: 1 };

describe("SqliteDurableCallStore (real file)", () => {
  it("intent survives close/reopen; DurableCalls reports interrupted without resending", async () => {
    const { open } = fileStore();
    let store = open();
    await store.commitIntent("k-intent", { tool: "write", args: { x: 1 } });
    expect(store.db.isTransaction).toBe(false); // autocommit, nothing held open
    store.close();

    store = open();
    await expect(store.get("k-intent")).resolves.toEqual({
      status: "intent", request: { tool: "write", args: { x: 1 } },
    });
    const send = vi.fn(async () => ({ kind: "ok" }));
    const calls = new DurableCalls({ store, mutex: new Mutex() });
    await expect(calls.execute("k-intent", {}, send)).resolves.toEqual({ status: "interrupted" });
    expect(send).not.toHaveBeenCalled();
    store.close();
  });

  it("preserves tool-isError outcome and intent metadata in the completed row after reopen, no resend", async () => {
    const { open } = fileStore();
    const request = { tool: "failing", args: { n: 1 } };
    const outcome = {
      kind: "tool-isError",
      result: { content: [{ type: "text", text: "boom" }], isError: true },
      meta,
    };
    let store = open();
    const send = vi.fn(async () => outcome);
    let calls = new DurableCalls({ store, mutex: new Mutex() });
    await expect(calls.execute("k-err", request, send)).resolves.toEqual({ status: "completed", result: outcome });
    store.close();

    store = open();
    await expect(store.get("k-err")).resolves.toEqual({ status: "completed", request, result: outcome });
    calls = new DurableCalls({ store, mutex: new Mutex() });
    await expect(calls.execute("k-err", request, send)).resolves.toEqual({ status: "completed", result: outcome });
    expect(send).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("preserves uncertain-write outcome after reopen, no resend", async () => {
    const { open } = fileStore();
    const outcome = {
      kind: "uncertain-write",
      uncertain: { requestId: "r9", method: "tools/call", argsDigest: "d", sentAt: 1, binding: "b", evidence: "timeout" },
      meta,
    };
    let store = open();
    await store.commitIntent("k-unc", { tool: "write" });
    await store.commitOutcome("k-unc", outcome);
    store.close();

    store = open();
    await expect(store.get("k-unc")).resolves.toEqual({
      status: "completed", request: { tool: "write" }, result: outcome,
    });
    const send = vi.fn(async () => ({ kind: "ok" }));
    const calls = new DurableCalls({ store, mutex: new Mutex() });
    await expect(calls.execute("k-unc", { tool: "write" }, send)).resolves.toEqual({ status: "completed", result: outcome });
    expect(send).not.toHaveBeenCalled();
    store.close();
  });

  it("fails explicitly on nonpersistable data and leaves the intent row intact", async () => {
    const { open } = fileStore();
    let store = open();
    await store.commitIntent("k-bad", { tool: "mrtr" });
    // Function (e.g. resume), BigInt, undefined property, NaN, circular: JSON would silently drop/alter these.
    await expect(store.commitOutcome("k-bad", { kind: "mrtr-interim", resume: async () => {}, meta }))
      .rejects.toThrow(/nonpersistable result/);
    await expect(store.commitOutcome("k-bad", { v: 1n })).rejects.toThrow(/nonpersistable/);
    await expect(store.commitOutcome("k-bad", { v: undefined })).rejects.toThrow(/nonpersistable/);
    await expect(store.commitOutcome("k-bad", { v: Number.NaN })).rejects.toThrow(/nonpersistable/);
    const circ: Record<string, unknown> = {}; circ.self = circ;
    await expect(store.commitOutcome("k-bad", circ)).rejects.toThrow(/nonpersistable/);
    await expect(store.commitIntent("k-fn", { f: () => {} })).rejects.toThrow(/nonpersistable request/);
    store.close();

    store = open();
    await expect(store.get("k-bad")).resolves.toEqual({ status: "intent", request: { tool: "mrtr" } });
    await expect(store.get("k-fn")).resolves.toBeUndefined();
    store.close();
  });

  it("commits are visible to a second connection before close (atomic autocommit)", async () => {
    const { path, open } = fileStore();
    const store = open();
    await store.commitIntent("k-vis", { a: 1 });
    const other = new DatabaseSync(path);
    try {
      expect(other.prepare("SELECT status, request_json FROM durable_calls WHERE key = ?").get("k-vis"))
        .toEqual({ status: "intent", request_json: JSON.stringify({ a: 1 }) });
    } finally { other.close(); store.close(); }
  });
});
