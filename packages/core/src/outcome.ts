import type { RequestId } from "./schema/index.js";

export type TransportFailureKind =
  | "connect"
  | "spawn"
  | "process-exit"
  | "stream-broken"
  | "http-status"
  | "closed"
  | "timeout"
  | "forbidden"
  | "auth-failure"
  | "auth-unavailable"
  | "too-large";

export interface TransportFailure {
  readonly kind: TransportFailureKind;
  readonly message: string;
  readonly status?: number;
  readonly reason?: string;
  readonly cause?: unknown;
}

export interface UncertainWrite {
  readonly requestId: RequestId;
  readonly method: string;
  readonly name?: string;
  readonly argsDigest: string;
  readonly sentAt: number;
  readonly binding: string;
  readonly evidence:
    | "process-exit"
    | "eof-mid-line"
    | "cancelled"
    | "timeout"
    | "stream-broken"
    | "status-5xx"
    | "truncated-json";
  /** HTTP-AMBIG-4: task handle observed on the stream before it broke; kept for the tasks extension to poll. */
  readonly taskHandle?: unknown;
}

export interface MrtrRound {
  readonly round: number;
  readonly requestState?: string;
  readonly action: "consent" | "auto" | "manual";
}

export interface OutcomeMeta {
  readonly requestId: RequestId;
  readonly method: string;
  readonly binding: string;
  readonly attempts: number;
  /** HTTP-AMBIG-3: id of the original request this caller-opted re-issue duplicates. */
  readonly retryOf?: RequestId;
  readonly cache?: "hit" | "miss" | "stale" | "bypass";
  readonly serverInfo?: { readonly name: string; readonly version: string; readonly title?: string };
  readonly trace?: readonly MrtrRound[];
}

export type JsonRpcRefinement =
  | "resource-not-found"
  | "unsupported-version"
  | "missing-client-capability"
  | "header-mismatch"
  | "unknown-reserved";

export interface InputRequestsField {
  readonly [key: string]: unknown;
}

export type InputResponsesField = Record<string, unknown>;

export type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T; readonly meta: OutcomeMeta }
  | {
      readonly kind: "jsonrpc-error";
      readonly code: number;
      readonly message: string;
      readonly data?: unknown;
      readonly refined?: JsonRpcRefinement;
      readonly meta: OutcomeMeta;
    }
  | {
      readonly kind: "transport-failure";
      readonly failure: TransportFailure;
      readonly safeToRetry: boolean;
      readonly meta: OutcomeMeta;
    }
  | { readonly kind: "tool-isError"; readonly result: Record<string, unknown>; readonly meta: OutcomeMeta }
  | {
      readonly kind: "mrtr-interim";
      readonly inputRequests?: InputRequestsField;
      readonly requestState?: string;
      readonly meta: OutcomeMeta;
    }
  | { readonly kind: "task-handle"; readonly handle: unknown; readonly meta: OutcomeMeta }
  | { readonly kind: "uncertain-write"; readonly uncertain: UncertainWrite; readonly meta: OutcomeMeta }
  | {
      readonly kind: "cancelled";
      readonly wasSent: boolean;
      readonly phase: "queue" | "wire" | "input";
      readonly meta: OutcomeMeta;
    }
  | {
      readonly kind:
        | "protocol-violation"
        | "capability-absent"
        | "invalid-arguments"
        | "invalid-schema"
        | "unsupported-version"
        | "auth-failure"
        | "auth-unavailable"
        | "limit-exceeded"
        | "local-error";
      readonly detail: unknown;
      readonly meta: OutcomeMeta;
    };

export function refineJsonRpcCode(code: number): JsonRpcRefinement | undefined {
  if (code === -32020) return "header-mismatch";
  if (code === -32021) return "missing-client-capability";
  if (code === -32022) return "unsupported-version";
  if (code === -32002) return "resource-not-found";
  if (code <= -32023 && code >= -32099) return "unknown-reserved";
  return undefined;
}

export class McpOutcomeError<T = unknown> extends Error {
  readonly outcome: Exclude<Outcome<T>, { readonly kind: "ok" }>;

  constructor(outcome: Exclude<Outcome<T>, { readonly kind: "ok" }>) {
    const label =
      outcome.kind === "jsonrpc-error"
        ? `MCP jsonrpc-error(${outcome.code}): ${outcome.message}`
        : outcome.kind === "transport-failure"
          ? `MCP transport-failure(${outcome.failure.kind}): ${outcome.failure.message}`
          : `MCP outcome: ${outcome.kind}`;
    super(label);
    this.name = "McpOutcomeError";
    this.outcome = outcome;
  }
}

export function unwrapOutcome<T>(outcome: Outcome<T>): T {
  if (outcome.kind === "ok") {
    return outcome.value;
  }
  throw new McpOutcomeError(outcome);
}
