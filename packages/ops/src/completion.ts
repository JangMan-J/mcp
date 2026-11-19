import type { Outcome, RequestOptions } from "@mcp-client/core";
import { gate, isObj, mapMethodNotFound, mapOutcome, type CapabilitySource, type OpsClient } from "./common.js";

export const MAX_COMPLETION_VALUES = 100;

export type CompletionRef =
  | { readonly type: "ref/prompt"; readonly name: string }
  | { readonly type: "ref/resource"; readonly uri: string };

export interface CompleteParams {
  readonly ref: CompletionRef;
  readonly argument: { readonly name: string; readonly value: string };
  readonly context?: { readonly arguments?: Record<string, string> };
}

export interface CompleteResult {
  readonly values: string[];
  readonly total?: number;
  readonly hasMore?: boolean;
  /** OPS-COMP-2: values were cut to 100. */
  readonly truncated: boolean;
  readonly originalCount: number;
}

/** Aborts the previous in-flight run for the same key. No timers (OPS-COMP-3). */
export interface LatestWins {
  run<T>(key: string, fn: (signal: AbortSignal) => T): T;
}

export function latestWins(): LatestWins {
  const active = new Map<string, AbortController>();
  return {
    run<T>(key: string, fn: (signal: AbortSignal) => T): T {
      active.get(key)?.abort("superseded");
      const ac = new AbortController();
      active.set(key, ac);
      const result = fn(ac.signal);
      const clear = (): void => {
        if (active.get(key) === ac) active.delete(key);
      };
      if (result && typeof (result as { then?: unknown }).then === "function") {
        (result as unknown as PromiseLike<unknown>).then(clear, clear);
      } else clear();
      return result;
    },
  };
}

export class CompletionApi {
  private readonly lw = latestWins();

  constructor(
    private readonly client: OpsClient,
    private readonly opts: { readonly capabilities?: CapabilitySource } = {},
  ) {}

  async complete(p: CompleteParams, opts?: RequestOptions): Promise<Outcome<CompleteResult>> {
    const blocked = gate<CompleteResult>(this.opts.capabilities, "completions", "completion/complete");
    if (blocked) return blocked;
    const params: Record<string, unknown> = { ref: p.ref, argument: p.argument, ...(p.context ? { context: p.context } : {}) };
    const o = await this.client.request<Record<string, unknown>>("completion/complete", params, { ...opts, idempotent: true });
    const m = mapOutcome(mapMethodNotFound(o, "completions"), (v, meta) => {
      const c = v["completion"];
      if (!isObj(c) || !Array.isArray(c["values"])) return { kind: "protocol-violation", detail: { reason: "bad-completion" }, meta };
      const all = c["values"] as string[];
      const truncated = all.length > MAX_COMPLETION_VALUES;
      return {
        kind: "ok",
        value: {
          values: truncated ? all.slice(0, MAX_COMPLETION_VALUES) : all,
          ...(typeof c["total"] === "number" ? { total: c["total"] } : {}),
          ...(typeof c["hasMore"] === "boolean" ? { hasMore: c["hasMore"] } : {}),
          truncated,
          originalCount: all.length,
        },
        meta,
      };
    });
    if (m.kind === "jsonrpc-error" && m.code === -32602) {
      return { kind: "invalid-arguments", detail: { code: m.code, message: m.message, ...(m.data !== undefined ? { data: m.data } : {}) }, meta: m.meta };
    }
    return m;
  }

  /** Coalesce rapid requests for `key`: the previous in-flight completion is aborted. */
  latestWins(key: string, p: CompleteParams, opts?: RequestOptions): Promise<Outcome<CompleteResult>> {
    return this.lw.run(key, (signal) => this.complete(p, { ...opts, signal }));
  }
}
