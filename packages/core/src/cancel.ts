import type { TransportFailure, UncertainWrite } from "./outcome.js";
import type { Exchange, ExchangeEnd } from "./ports.js";
import type { RequestId } from "./jsonrpc.js";

/**
 * Cancellation and timeout semantics (S1.1, IMPLEMENTATION_PLAN.md §5.4; WIRE-CANCEL-*, WIRE-TO-*).
 *
 * Core does not write notifications/cancelled itself: that is binding behavior (stdio sends it,
 * Streamable HTTP closes the stream). Core guarantees that an abort settles the request locally
 * even when the transport does not react, that a response observed after the local settle is
 * ignored and counted (WIRE-CANCEL-3), that a cancel after settle is a no-op (WIRE-CANCEL-1),
 * and that interrupted non-read-only calls classify as uncertain-write (WIRE-CANCEL-5, N14).
 */

/**
 * Methods treated as read-only by default. A read-only call that is cancelled or times out is a
 * clean `cancelled` / `transport-failure`; anything else is `uncertain-write`.
 * prompts/get is listed as a host-overridable default only (STDIO-RECOVER-1); the spec does not
 * declare it idempotent.
 */
export const DEFAULT_READ_ONLY_METHODS: readonly string[] = Object.freeze([
  "server/discover",
  "tools/list",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "completion/complete",
]);

export function createReadOnlyPredicate(methods: readonly string[] = DEFAULT_READ_ONLY_METHODS): (method: string) => boolean {
  const set = new Set(methods);
  return (method) => set.has(method);
}

export const isReadOnlyMethod: (method: string) => boolean = createReadOnlyPredicate();

/** Stable, non-cryptographic digest of call arguments for UncertainWrite records (no secrets stored). */
export function argsDigest(obj: unknown): string {
  const s = JSON.stringify(obj) ?? "";
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

export type InterruptCause = "cancelled" | "timeout" | "failure";

export interface InterruptedCall {
  readonly method: string;
  readonly readOnly: boolean;
  readonly cause: InterruptCause;
  readonly delivery: "not-sent" | "maybe-delivered" | "delivered-no-response";
  readonly failure?: TransportFailure;
}

export type InterruptClass = "cancelled" | "uncertain-write" | "transport-failure";

/**
 * Classification hook for an interrupted call (no response observed).
 * - never sent: `cancelled` (abort/timeout) or `transport-failure` (safe to retry)
 * - sent, read-only: `cancelled` or `transport-failure`
 * - sent, not read-only: `uncertain-write`
 */
export function classifyInterruptedCall(call: InterruptedCall): InterruptClass {
  if (call.delivery === "not-sent") {
    return call.cause === "cancelled" ? "cancelled" : "transport-failure";
  }
  if (!call.readOnly) return "uncertain-write";
  return call.cause === "cancelled" ? "cancelled" : "transport-failure";
}

export function uncertainEvidence(call: InterruptedCall): UncertainWrite["evidence"] {
  if (call.cause === "cancelled") return "cancelled";
  if (call.cause === "timeout") return "timeout";
  if (call.failure?.kind === "process-exit") return "process-exit";
  if (call.failure?.kind === "http-status") return "status-5xx";
  return "stream-broken";
}

export function buildUncertainWrite(input: {
  readonly requestId: RequestId;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sentAt: number;
  readonly binding: string;
  readonly evidence: UncertainWrite["evidence"];
}): UncertainWrite {
  const name = input.params["name"];
  return {
    requestId: input.requestId,
    method: input.method,
    ...(typeof name === "string" ? { name } : {}),
    argsDigest: argsDigest(input.params),
    sentAt: input.sentAt,
    binding: input.binding,
    evidence: input.evidence,
  };
}

export interface GuardHooks {
  /** Called once when the exchange settles (by response, transport failure, or local abort). */
  onSettle?(end: ExchangeEnd, source: "transport" | "abort"): void;
  /** Called when the transport settles after the local settle already happened (WIRE-CANCEL-3). */
  onLate?(end: ExchangeEnd): void;
}

export interface GuardedDone {
  readonly done: Promise<ExchangeEnd>;
  readonly settled: () => boolean;
}

/** Number of microtask turns an abort waits so a transport that settles on abort wins the race. */
const ABORT_SETTLE_TURNS = 4;

/**
 * Wraps an exchange's completion so that exactly one end is observed.
 * When `settleOnAbort` is set, an abort settles locally with a `maybe-delivered` failure if the
 * transport has not settled by itself within a few microtask turns.
 */
export function guardExchangeDone(
  inner: Exchange,
  signal: AbortSignal,
  opts: { readonly settleOnAbort: boolean },
  hooks: GuardHooks = {},
): GuardedDone {
  let settled = false;
  let resolveDone!: (end: ExchangeEnd) => void;
  const done = new Promise<ExchangeEnd>((resolve) => {
    resolveDone = resolve;
  });

  const onAbort = () => {
    let p: Promise<void> = Promise.resolve();
    for (let i = 0; i < ABORT_SETTLE_TURNS; i++) p = p.then(() => undefined);
    void p.then(() => {
      if (settled) return;
      const reason = signal.reason;
      settle(
        {
          kind: "failure",
          failure: {
            kind: reason === "timeout" ? "timeout" : "closed",
            message: "request aborted locally",
          },
          delivery: inner.abortDelivery?.() ?? "maybe-delivered",
        },
        "abort",
      );
    });
  };

  const settle = (end: ExchangeEnd, source: "transport" | "abort"): void => {
    if (settled) {
      if (source === "transport") hooks.onLate?.(end);
      return;
    }
    settled = true;
    signal.removeEventListener("abort", onAbort);
    hooks.onSettle?.(end, source);
    resolveDone(end);
  };

  inner.done.then(
    (end) => settle(end, "transport"),
    (err: unknown) =>
      settle(
        {
          kind: "failure",
          failure: {
            kind: "stream-broken",
            message: err instanceof Error ? err.message : String(err),
            cause: err,
          },
          delivery: "maybe-delivered",
        },
        "transport",
      ),
  );

  if (opts.settleOnAbort && !signal.aborted) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return { done, settled: () => settled };
}
