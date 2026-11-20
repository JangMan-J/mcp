import { DatabaseSync } from "node:sqlite";
import type { CallRecord, DurableCallStore } from "./calls.ts";

/** Encode only JSON-data values; anything JSON would drop/alter fails explicitly. */
function encodeData(value: unknown, label: string): string {
  const seen = new Set<object>();
  const check = (v: unknown, path: string): void => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new TypeError(`nonpersistable ${label} at ${path}: non-finite number`);
      return;
    }
    if (typeof v !== "object") throw new TypeError(`nonpersistable ${label} at ${path}: ${typeof v}`);
    if (seen.has(v)) throw new TypeError(`nonpersistable ${label} at ${path}: circular reference`);
    if (Object.getOwnPropertySymbols(v).length)
      throw new TypeError(`nonpersistable ${label} at ${path}: symbol-keyed property`);
    seen.add(v);
    try {
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          if (!(i in v)) throw new TypeError(`nonpersistable ${label} at ${path}[${i}]: sparse array`);
          check(v[i], `${path}[${i}]`);
        }
      } else {
        const proto = Object.getPrototypeOf(v);
        if (proto !== Object.prototype && proto !== null)
          throw new TypeError(`nonpersistable ${label} at ${path}: non-plain object`);
        for (const [k, val] of Object.entries(v)) check(val, `${path}.${k}`);
      }
    } finally { seen.delete(v); }
  };
  check(value, "$");
  return JSON.stringify(value);
}

/**
 * DurableCallStore backed by node:sqlite. Each commit is one SQL statement
 * in autocommit mode, so a commit is either fully visible after a crash or
 * not at all; no transaction is held open across the send.
 */
export class SqliteDurableCallStore<Req = unknown, Res = unknown>
  implements DurableCallStore<Req, Res> {
  readonly db: DatabaseSync;
  private readonly owned: boolean;

  constructor(dbOrPath: DatabaseSync | string) {
    if (typeof dbOrPath === "string") {
      this.owned = true;
      this.db = new DatabaseSync(dbOrPath);
    } else {
      this.owned = false;
      this.db = dbOrPath;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS durable_calls (
        key TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('intent', 'completed')),
        request_json TEXT,
        result_json TEXT,
        attempts INTEGER NOT NULL DEFAULT 1
      )`);
    const cols = this.db.prepare("PRAGMA table_info(durable_calls)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "attempts"))
      this.db.exec("ALTER TABLE durable_calls ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1");
  }

  async get(key: string): Promise<CallRecord<Req, Res> | undefined> {
    const row = this.db.prepare(
      "SELECT status, request_json, result_json, attempts FROM durable_calls WHERE key = ?",
    ).get(key) as { status: string; request_json: string | null; result_json: string | null; attempts: number } | undefined;
    if (!row) return undefined;
    return {
      status: row.status as CallRecord<Req, Res>["status"],
      ...(row.request_json != null ? { request: JSON.parse(row.request_json) as Req } : {}),
      ...(row.result_json != null ? { result: JSON.parse(row.result_json) as Res } : {}),
      meta: { attempts: row.attempts },
    };
  }

  /**
   * First call inserts the intent. An existing intent row is rewritten only
   * when meta.attempts is higher than the stored count (an authorized retry
   * decided by DurableCalls under the host's exclusive per-key mutex); the
   * guard is in the single statement, so completed rows and stale or
   * duplicate commits are never altered.
   */
  async commitIntent(key: string, request: Req, meta?: { attempts: number }): Promise<void> {
    const attempts = meta?.attempts ?? 1;
    if (!Number.isInteger(attempts) || attempts < 1)
      throw new TypeError(`invalid attempts: ${String(attempts)}`);
    // Encode (and fail) before touching the DB.
    const json = encodeData(request, "request");
    this.db.prepare(
      `INSERT INTO durable_calls (key, status, request_json, attempts) VALUES (?, 'intent', ?, ?)
       ON CONFLICT(key) DO UPDATE SET request_json = excluded.request_json, attempts = excluded.attempts
       WHERE durable_calls.status = 'intent' AND excluded.attempts > durable_calls.attempts`,
    ).run(key, json, attempts);
  }

  async commitOutcome(key: string, result: Res): Promise<void> {
    // A nonpersistable outcome (e.g. an mrtr-interim resume function) throws
    // here and leaves the intent row untouched, never a lossy completed row.
    const json = encodeData(result, "result");
    // UPDATE only: an outcome without a prior intent is rejected, and
    // request_json/attempts are preserved.
    const r = this.db.prepare(
      `UPDATE durable_calls SET status = 'completed', result_json = ? WHERE key = ?`,
    ).run(json, key);
    if (Number(r.changes) === 0) throw new Error(`commitOutcome without intent: ${key}`);
  }

  close(): void {
    if (this.owned && this.db.isOpen) this.db.close();
  }
}

export { SqliteDurableCallStore as SQLiteDurableCallStore };

export function createSqliteDurableCallStore<Req = unknown, Res = unknown>(
  dbOrPath: DatabaseSync | string,
): SqliteDurableCallStore<Req, Res> {
  return new SqliteDurableCallStore<Req, Res>(dbOrPath);
}
