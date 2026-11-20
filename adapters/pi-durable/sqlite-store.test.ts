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
  it("[PICD-2] intent survives close/reopen; DurableCalls reports interrupted without resending", async () => {
    const { open } = fileStore();
    let store = open();
    await store.commitIntent("k-intent", { tool: "write", args: { x: 1 } });
    expect(store.db.isTransaction).toBe(false); // autocommit, nothing held open
    store.close();

    store = open();
    await expect(store.get("k-intent")).resolves.toEqual({
      status: "intent", request: { tool: "write", args: { x: 1 } }, meta: { attempts: 1 },
    });
    const send = vi.fn(async () => ({ kind: "ok" }));
    const calls = new DurableCalls({ store, mutex: new Mutex() });
    await expect(calls.execute("k-intent", {}, send)).resolves.toEqual({ status: "interrupted" });
    expect(send).not.toHaveBeenCalled();
    store.close();
  });

  it("[PICD-2] preserves tool-isError outcome and intent metadata in the completed row after reopen, no resend", async () => {
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
    await expect(store.get("k-err")).resolves.toEqual({ status: "completed", request, result: outcome, meta: { attempts: 1 } });
    calls = new DurableCalls({ store, mutex: new Mutex() });
    await expect(calls.execute("k-err", request, send)).resolves.toEqual({ status: "completed", result: outcome });
    expect(send).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("[PICD-2] preserves uncertain-write outcome after reopen, no resend", async () => {
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
      status: "completed", request: { tool: "write" }, result: outcome, meta: { attempts: 1 },
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
    await expect(store.get("k-bad")).resolves.toEqual({ status: "intent", request: { tool: "mrtr" }, meta: { attempts: 1 } });
    await expect(store.get("k-fn")).resolves.toBeUndefined();
    store.close();
  });

  it("[PICD-1] commits are visible to a second connection before close (atomic autocommit)", async () => {
    const { path, open } = fileStore();
    const store = open();
    await store.commitIntent("k-vis", { a: 1 });
    const other = new DatabaseSync(path);
    try {
      expect(other.prepare("SELECT status, request_json FROM durable_calls WHERE key = ?").get("k-vis"))
        .toEqual({ status: "intent", request_json: JSON.stringify({ a: 1 }) });
    } finally { other.close(); store.close(); }
  });

  it("restart_limit survives reopen and crash; outcome without intent is rejected", async () => {
    const { path, open } = fileStore();
    const opts = { tool: "read", readOnlyTools: ["read"], restartLimit: 2 };
    // Crash: send throws after the intent is committed; store closed without outcome.
    const crash = async () => { throw new Error("crash"); };
    let store = open();
    await expect(new DurableCalls({ store, mutex: new Mutex() }).execute("k-r", { n: 0 }, crash, opts)).rejects.toThrow("crash");
    store.close();
    for (const attempt of [2, 3]) {
      store = open();
      const send = vi.fn(crash);
      await expect(new DurableCalls({ store, mutex: new Mutex() }).execute("k-r", { n: 0 }, send, opts)).rejects.toThrow("crash");
      expect(send).toHaveBeenCalledTimes(1);
      store.close();
      store = open();
      await expect(store.get("k-r")).resolves.toMatchObject({ status: "intent", meta: { attempts: attempt } });
      store.close();
    }
    // Limit exhausted: reopened store reports interrupted, never resends.
    store = open();
    const send = vi.fn(async () => "x");
    await expect(new DurableCalls({ store, mutex: new Mutex() }).execute("k-r", { n: 0 }, send, opts))
      .resolves.toEqual({ status: "interrupted" });
    expect(send).not.toHaveBeenCalled();
    // Unauthorized/stale intent commits do not alter the row; completed rows are immutable.
    await store.commitIntent("k-r", { n: 99 });
    await store.commitIntent("k-r", { n: 99 }, { attempts: 3 });
    await expect(store.get("k-r")).resolves.toMatchObject({ request: { n: 0 }, meta: { attempts: 3 } });
    await store.commitOutcome("k-r", "done");
    await store.commitIntent("k-r", { n: 5 }, { attempts: 9 });
    await expect(store.get("k-r")).resolves.toEqual({ status: "completed", request: { n: 0 }, result: "done", meta: { attempts: 3 } });
    await expect(store.commitOutcome("k-none", "x")).rejects.toThrow(/without intent/);
    await expect(store.get("k-none")).resolves.toBeUndefined();
    store.close();
  });
});
