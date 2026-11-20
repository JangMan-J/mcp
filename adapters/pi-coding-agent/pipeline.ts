import type { ConsentPort, ConsentPrompt, ConsentResult } from "@mcp-client/core";

/**
 * Generic nested-tool plumbing for the Pi coding-agent adapter (PICA-7/9).
 *
 * A nested (e.g. codemode) tool call must go through the *host* tool
 * pipeline — the same permission/hook path as a top-level call — never
 * directly to a client/transport. This module is deliberately Pi-free:
 * the host pipeline is injected as a plain function (or an object with an
 * `execute`/`call`/`run`/`invoke` method).
 */

export interface NestedToolCall {
  readonly parentToolCallId: string;
  readonly name?: string;
  readonly toolName?: string;
  readonly arguments?: unknown;
  readonly args?: unknown;
  readonly [key: string]: unknown;
}

export type HostToolPipelineFn<Call extends NestedToolCall = NestedToolCall, Result = unknown> =
  (call: Call, signal: AbortSignal) => Promise<Result> | Result;

export interface HostToolPipelineObject<Call extends NestedToolCall = NestedToolCall, Result = unknown> {
  readonly execute?: HostToolPipelineFn<Call, Result>;
  readonly call?: HostToolPipelineFn<Call, Result>;
  readonly run?: HostToolPipelineFn<Call, Result>;
  readonly invoke?: HostToolPipelineFn<Call, Result>;
}

export type HostToolPipeline<Call extends NestedToolCall = NestedToolCall, Result = unknown> =
  | HostToolPipelineFn<Call, Result>
  | HostToolPipelineObject<Call, Result>;

/** Combine any number of abort signals into one; `undefined` entries are ignored. */
export function combineAbortSignals(
  ...signals: readonly (AbortSignal | undefined | null)[]
): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s != null);
  if (present.length === 0) return new AbortController().signal;
  if (present.length === 1) return present[0]!;
  return AbortSignal.any(present);
}

async function raceWithAbort<T>(work: Promise<T> | T, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = reject;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  try {
    // Promise.race keeps handlers on `work`, so a late settlement after an
    // abort is observed (no unhandled rejection) but never delivered.
    return await Promise.race([Promise.resolve(work), aborted]);
  } finally {
    signal.removeEventListener("abort", () => onAbort(signal.reason));
  }
}

function resolvePipeline<Call extends NestedToolCall, Result>(
  hostPipeline: HostToolPipeline<Call, Result>,
): HostToolPipelineFn<Call, Result> {
  if (typeof hostPipeline === "function") return hostPipeline;
  if (hostPipeline && typeof hostPipeline === "object") {
    for (const key of ["execute", "call", "run", "invoke"] as const) {
      const fn = hostPipeline[key];
      if (typeof fn === "function") return fn.bind(hostPipeline);
    }
  }
  throw new TypeError("runNestedTool: hostPipeline must be a function or expose execute/call/run/invoke");
}

/**
 * Run one nested tool call through the host pipeline only.
 *
 * - `call` is forwarded unchanged, so `parentToolCallId` (and every other
 *   field) is preserved and the caller's object is never mutated.
 * - `sessionSignal` and `parentSignal` are combined: aborting either one
 *   aborts the signal handed to the host pipeline.
 * - A result (or error) that arrives after the combined signal aborted is
 *   dropped: the returned promise rejects with the abort reason instead.
 * - If the combined signal is already aborted, the host pipeline is not
 *   invoked at all.
 */
export async function runNestedTool<Call extends NestedToolCall = NestedToolCall, Result = unknown>(
  hostPipeline: HostToolPipeline<Call, Result>,
  call: Call,
  sessionSignal?: AbortSignal | null,
  parentSignal?: AbortSignal | null,
): Promise<Result> {
  const signal = combineAbortSignals(sessionSignal, parentSignal);
  signal.throwIfAborted();
  const execute = resolvePipeline(hostPipeline);
  return raceWithAbort(execute(call, signal), signal);
}

/**
 * Wrap a ConsentPort so prompts issued under it are cancellable by the
 * request signal plus any outer (session/parent) signals. A late decision
 * arriving after abort is dropped (the request rejects with the abort
 * reason). A missing inner port never auto-approves: it returns `cancel`.
 */
export function cancellableConsentPort(
  inner: ConsentPort | undefined | null,
  ...outerSignals: readonly (AbortSignal | undefined | null)[]
): ConsentPort {
  return {
    async request(prompt: ConsentPrompt, signal: AbortSignal): Promise<ConsentResult> {
      const combined = combineAbortSignals(signal, ...outerSignals);
      combined.throwIfAborted();
      if (!inner) return { decision: "cancel" };
      return raceWithAbort(inner.request(prompt, combined), combined);
    },
  };
}

/** Alias for {@link cancellableConsentPort}. */
export const withCancellableConsent = cancellableConsentPort;
/** Alias for {@link cancellableConsentPort}. */
export const createCancellableConsentPort = cancellableConsentPort;
