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
    this.owned = typeof dbOrPath === "string";
    this.db = this.owned ? new DatabaseSync(dbOrPath) : dbOrPath;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS durable_calls (
        key TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('intent', 'completed')),
        request_json TEXT,
        result_json TEXT
      )`);
  }

  async get(key: string): Promise<CallRecord<Req, Res> | undefined> {
    const row = this.db.prepare(
      "SELECT status, request_json, result_json FROM durable_calls WHERE key = ?",
    ).get(key) as { status: string; request_json: string | null; result_json: string | null } | undefined;
    if (!row) return undefined;
    return {
      status: row.status as CallRecord<Req, Res>["status"],
      ...(row.request_json != null ? { request: JSON.parse(row.request_json) as Req } : {}),
      ...(row.result_json != null ? { result: JSON.parse(row.result_json) as Res } : {}),
    };
  }

  async commitIntent(key: string, request: Req): Promise<void> {
    // Encode (and fail) before touching the DB.
    const json = encodeData(request, "request");
    this.db.prepare(
      `INSERT INTO durable_calls (key, status, request_json) VALUES (?, 'intent', ?)
       ON CONFLICT(key) DO NOTHING`,
    ).run(key, json);
  }

  async commitOutcome(key: string, result: Res): Promise<void> {
    // A nonpersistable outcome (e.g. an mrtr-interim resume function) throws
    // here and leaves the intent row untouched, never a lossy completed row.
    const json = encodeData(result, "result");
    // Single-statement upsert: preserves request_json from the intent row.
    this.db.prepare(
      `INSERT INTO durable_calls (key, status, result_json) VALUES (?, 'completed', ?)
       ON CONFLICT(key) DO UPDATE SET status = 'completed', result_json = excluded.result_json`,
    ).run(key, json);
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
