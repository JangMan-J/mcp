import type { ClientRequest, Outcome, OutcomeMeta, RequestOptions } from "@mcp-client/core";

/** The slice of McpClient the operations use. */
export interface OpsClient {
  request<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    opts?: RequestOptions,
  ): ClientRequest<T>;
}

export type Capabilities = Readonly<Record<string, unknown>>;
export type CapabilitySource = Capabilities | (() => Capabilities | undefined) | undefined;

export type NonOkKind = Exclude<Outcome<never>["kind"], "ok" | "mrtr-interim">;

export function localMeta(method: string): OutcomeMeta {
  return { requestId: 0, method, binding: "local", attempts: 0 };
}

export function local<T>(
  kind: "capability-absent" | "invalid-arguments" | "invalid-schema" | "protocol-violation" | "limit-exceeded" | "local-error",
  method: string,
  detail: unknown,
): Outcome<T> {
  return { kind, detail, meta: localMeta(method) } as Outcome<T>;
}

/** Re-type an outcome by mapping its `ok` branch. */
export function mapOutcome<T, U>(o: Outcome<T>, f: (value: T, meta: OutcomeMeta) => Outcome<U>): Outcome<U> {
  if (o.kind === "ok") return f(o.value, o.meta);
  return o as unknown as Outcome<U>;
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Capability gate. Returns a local outcome only when the capability is known to be absent. */
export function gate<T>(source: CapabilitySource, capability: string, method: string): Outcome<T> | undefined {
  const caps = typeof source === "function" ? source() : source;
  if (caps === undefined) return undefined;
  if (caps[capability] === undefined || caps[capability] === null || caps[capability] === false) {
    return local<T>("capability-absent", method, { capability, reason: "not-declared", wire: false });
  }
  return undefined;
}

/** Unknown discover data: a -32601 reply means the capability is absent. */
export function mapMethodNotFound<T>(o: Outcome<T>, capability: string): Outcome<T> {
  if (o.kind === "jsonrpc-error" && o.code === -32601) {
    return {
      kind: "capability-absent",
      detail: { capability, reason: "method-not-found", code: -32601, message: o.message, wire: true },
      meta: o.meta,
    };
  }
  return o;
}

export function utf8Length(v: unknown): number {
  return new TextEncoder().encode(typeof v === "string" ? v : (JSON.stringify(v) ?? "")).length;
}
