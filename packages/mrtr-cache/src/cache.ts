import type { Outcome, RequestOptions } from "@mcp-client/core";
import { object, type Diagnostic, type Obj, type RequestFn } from "./common.js";

const methods = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
]);
const lists = (method: string) => method.endsWith("/list");
export interface CacheContext {
  serverRef: string;
  authContextId: string;
}
export interface CacheEntry extends CacheContext {
  method: string;
  uri: unknown;
  key: string;
  shared: boolean;
  scope: "public" | "private";
  mixed: boolean;
  expires: number;
  size: number;
  outcome: Extract<Outcome<unknown>, { kind: "ok" }>;
}
/** Insertion-ordered LRU store. Durable implementations must use the host clock domain for expires. */
export interface ResultCacheStore extends Iterable<[string, CacheEntry]> {
  readonly perPrincipalIsolation?: boolean;
  get(key: string): CacheEntry | undefined;
  set(key: string, value: CacheEntry): unknown;
  delete(key: string): unknown;
  readonly size: number;
}
export interface CacheOptions {
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  maxTtlMs?: number;
  sharePublic?: boolean;
  staleIfError?: boolean;
  store?: ResultCacheStore;
  diagnostic?: Diagnostic;
}
function canonical(params: Obj) {
  const { _meta, ...rest } = params;
  return JSON.stringify(rest, (_k, v: unknown) =>
    object(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
const mark = (
  o: Outcome<unknown>,
  cache: "hit" | "miss" | "bypass" | "stale",
): Outcome<unknown> => ({ ...o, meta: { ...o.meta, cache } });
interface Flight extends CacheContext {
  method: string;
  uri: unknown;
  valid: boolean;
  signal?: AbortSignal;
  result: Promise<Outcome<unknown>>;
}
export class ResultCache {
  private readonly memory = new Map<string, CacheEntry>();
  private readonly stores: ResultCacheStore[];
  private readonly flights = new Map<string, Set<Flight>>();
  private readonly now: () => number;
  constructor(private readonly options: CacheOptions = {}) {
    this.stores = options.store ? [this.memory, options.store] : [this.memory];
    this.now = options.now ?? (() => performance.now());
    for (const n of [
      options.maxEntries,
      options.maxBytes,
      options.maxEntryBytes,
      options.maxTtlMs,
    ])
      if (n !== undefined && (!Number.isFinite(n) || n < 0))
        throw RangeError("invalid cache bound");
  }
  private purge(
    match: (x: CacheContext & { uri: unknown; method: string }) => boolean,
  ) {
    for (const s of this.stores)
      for (const [k, e] of s) if (match(e)) s.delete(k);
    for (const fs of this.flights.values())
      for (const f of fs) if (match(f)) f.valid = false;
  }
  invalidate(serverRef: string, method: string, uri?: string) {
    this.purge(
      (e) =>
        e.serverRef === serverRef &&
        e.method === method &&
        (uri === undefined || e.uri === uri),
    );
  }
  notification(serverRef: string, method: string, params: Obj = {}) {
    switch (method) {
      case "notifications/tools/list_changed":
        this.invalidate(serverRef, "tools/list");
        break;
      case "notifications/prompts/list_changed":
        this.invalidate(serverRef, "prompts/list");
        break;
      case "notifications/resources/list_changed":
        this.invalidate(serverRef, "resources/list");
        break;
      case "notifications/resources/updated":
        if (typeof params.uri === "string")
          this.invalidate(serverRef, "resources/read", params.uri);
        break;
    }
  }
  private insert(entry: CacheEntry) {
    const external = this.options.store;
    const store =
      external && (entry.shared || external.perPrincipalIsolation)
        ? external
        : this.memory;
    // Both stores share one memory budget; compare insertion recency via Map ordering inside each partition.
    store.delete(entry.key);
    store.set(entry.key, entry);
    let bytes = 0,
      count = 0;
    for (const s of this.stores)
      for (const [, e] of s) {
        bytes += e.size;
        count++;
      }
    while (
      count > (this.options.maxEntries ?? 500) ||
      bytes > (this.options.maxBytes ?? 32 * 1024 * 1024)
    ) {
      const candidate = this.stores.find((s) => s.size > 0)!;
      const [key, old] = candidate[Symbol.iterator]().next().value as [
        string,
        CacheEntry,
      ];
      candidate.delete(key);
      bytes -= old.size;
      count--;
    }
  }
  async run(
    ctx: CacheContext,
    method: string,
    params: Obj,
    opts: RequestOptions,
    request: RequestFn,
  ): Promise<Outcome<unknown>> {
    const { serverRef, authContextId } = ctx;
    const inspect = (out: Outcome<unknown>) => {
      if (
        (out.kind === "transport-failure" &&
          [401, 403].includes(out.failure.status ?? 0)) ||
        (out.kind === "transport-failure" &&
          out.failure.kind === "forbidden") ||
        out.kind === "auth-failure"
      )
        this.purge(
          (e) => e.serverRef === serverRef && e.authContextId === authContextId,
        );
      if (out.kind === "unsupported-version")
        this.invalidate(serverRef, "server/discover");
      if (out.kind === "jsonrpc-error") {
        if (out.code === -32021 || out.code === -32022)
          this.invalidate(serverRef, "server/discover");
        if (
          method === "tools/call" &&
          out.code === -32602 &&
          /unknown tool/i.test(out.message)
        )
          this.invalidate(serverRef, "tools/list");
      }
    };
    if (
      opts.signal?.aborted ||
      !methods.has(method) ||
      "requestState" in params ||
      "inputResponses" in params
    ) {
      const out = await request(method, params, opts);
      inspect(out);
      return mark(out, "bypass");
    }
    const base = [serverRef, method, canonical(params)],
      key = JSON.stringify([...base, authContextId]),
      pub = JSON.stringify([...base, null]);
    let entry: CacheEntry | undefined;
    for (const s of this.stores) {
      entry = s.get(key) ?? (this.options.sharePublic ? s.get(pub) : undefined);
      if (entry && entry.expires > this.now()) {
        s.delete(entry.key);
        s.set(entry.key, entry);
        return mark(structuredClone(entry.outcome), "hit");
      }
      if (entry) break;
    }
    const active = this.flights.get(key) ?? new Set<Flight>();
    for (const f of active)
      if (f.valid && f.signal === opts.signal)
        return f.result.then((o) => (o.kind === "ok" ? structuredClone(o) : o));
    const flight: Flight = {
      ...ctx,
      method,
      uri: params.uri,
      valid: true,
      ...(opts.signal && { signal: opts.signal }),
      result: Promise.resolve().then(async () => {
        const out = await request(method, params, opts);
        inspect(out);
        if (
          out.kind === "jsonrpc-error" &&
          out.code === -32602 &&
          lists(method) &&
          "cursor" in params
        ) {
          this.invalidate(serverRef, method);
          const { cursor, ...first } = params;
          return this.run(ctx, method, first, opts, request);
        }
        if (
          flight.valid &&
          entry &&
          this.options.staleIfError &&
          out.kind === "transport-failure" &&
          (!out.failure.status || out.failure.status >= 500)
        ) {
          const result = {
            ...structuredClone(entry.outcome),
            stale: true,
            staleReason: out.failure.kind,
          };
          return mark(result, "stale");
        }
        if (
          !flight.valid ||
          out.kind !== "ok" ||
          !object(out.value) ||
          out.value.resultType !== "complete" ||
          out.meta.trace?.length
        )
          return mark(out, "miss");
        const scope = out.value.cacheScope === "public" ? "public" : "private";
        let mixed = false;
        if (lists(method)) {
          for (const s of this.stores)
            for (const [, e] of s)
              if (
                e.serverRef === serverRef &&
                e.method === method &&
                (e.authContextId === authContextId || e.shared) &&
                (e.scope !== scope || e.mixed)
              )
                mixed = true;
          if (mixed) {
            this.options.diagnostic?.("mixed-cache-scope", { method });
            for (const s of this.stores)
              for (const [k, e] of s)
                if (
                  e.serverRef === serverRef &&
                  e.method === method &&
                  (e.authContextId === authContextId || e.shared)
                ) {
                  if (e.shared) s.delete(k);
                  else e.mixed = true;
                }
          }
        }
        const shared =
          scope === "public" && this.options.sharePublic === true && !mixed;
        // A replacement that is stale or too large must not resurrect the previous value.
        for (const s of this.stores) {
          s.delete(key);
          s.delete(pub);
        }
        const ttl =
          typeof out.value.ttlMs === "number" &&
          Number.isFinite(out.value.ttlMs)
            ? Math.min(
                this.options.maxTtlMs ?? 86_400_000,
                Math.floor(out.value.ttlMs),
              )
            : 0;
        if (ttl > 0) {
          const size = new TextEncoder().encode(
            JSON.stringify([base, out]),
          ).length;
          if (size <= (this.options.maxEntryBytes ?? 4 * 1024 * 1024))
            this.insert({
              ...ctx,
              method,
              uri: params.uri,
              key: shared ? pub : key,
              shared,
              scope,
              mixed,
              expires: this.now() + ttl,
              size,
              outcome: structuredClone(out),
            });
        }
        return mark(out, "miss");
      }),
    };
    active.add(flight);
    this.flights.set(key, active);
    try {
      return await flight.result;
    } finally {
      active.delete(flight);
      if (active.size === 0) this.flights.delete(key);
    }
  }
}
