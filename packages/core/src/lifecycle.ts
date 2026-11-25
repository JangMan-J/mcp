import {
  SUPPORTED_PROTOCOL_VERSION,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./jsonrpc.js";
import { refineJsonRpcCode, type JsonRpcRefinement, type Outcome } from "./outcome.js";
import type { ProgressRegistry } from "./progress.js";
import type { DiscoverResult } from "./schema/index.js";

/**
 * Wire lifecycle helpers (WIRE-*, VER-*).
 * Runtime-neutral: no node:* imports, no third-party dependencies.
 */

/** Library identity sent as io.modelcontextprotocol/clientInfo when the host supplies none (WIRE-META-3). */
export const LIBRARY_CLIENT_INFO: { readonly name: string; readonly version: string } = Object.freeze({
  name: "@jangmanj/mcp",
  version: "0.1.1",
});

/** Deprecated logging key; never sent (WIRE-LOG-1). */
export const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel" as const;

/** Default timeout for the server/discover era probe. */
export const DISCOVER_PROBE_TIMEOUT_MS = 10_000;

/** Max bytes of offending error text carried in a diagnostic. */
export const DIAGNOSTIC_EVIDENCE_MAX = 2048;

// ---------------------------------------------------------------------------------------------
// Error-code mapping (WIRE-ERR-3/4, VER-7, EDGE-32/34)
// ---------------------------------------------------------------------------------------------

export type JsonRpcErrorCategory =
  | "parse-error"
  | "invalid-request"
  | "method-not-found"
  | "invalid-params"
  | "internal-error"
  | "header-mismatch"
  | "missing-client-capability"
  | "unsupported-version"
  | "resource-not-found"
  | "unknown-reserved"
  | "server-error"
  | "application";

export interface UnsupportedVersionData {
  readonly requested?: string;
  readonly supported: readonly string[];
}

export interface JsonRpcErrorClass {
  readonly code: number;
  readonly category: JsonRpcErrorCategory;
  readonly refined?: JsonRpcRefinement;
  /** -32022 data, when well-formed. */
  readonly unsupported?: UnsupportedVersionData;
  /** -32021 data.requiredCapabilities, when present (VER-7). */
  readonly requiredCapabilities?: unknown;
}

/**
 * Classifies a JSON-RPC error by code only (never by message). `data` is optional and untyped
 * for every code except where noted (WIRE-ERR-4); unknown data fields are ignored.
 */
export function classifyJsonRpcError(code: number, data?: unknown): JsonRpcErrorClass {
  const refined = refineJsonRpcCode(code);
  const base = { code, ...(refined ? { refined } : {}) };
  switch (code) {
    case -32700:
      return { ...base, category: "parse-error" };
    case -32600:
      return { ...base, category: "invalid-request" };
    case -32601:
      return { ...base, category: "method-not-found" };
    case -32602:
      return { ...base, category: "invalid-params" };
    case -32603:
      return { ...base, category: "internal-error" };
    case -32020:
      return { ...base, category: "header-mismatch" };
    case -32021: {
      const rc =
        typeof data === "object" && data !== null ? (data as Record<string, unknown>)["requiredCapabilities"] : undefined;
      return { ...base, category: "missing-client-capability", ...(rc !== undefined ? { requiredCapabilities: rc } : {}) };
    }
    case -32022: {
      const parsed = parseUnsupportedVersionData(data);
      return { ...base, category: "unsupported-version", ...(parsed ? { unsupported: parsed } : {}) };
    }
    case -32002:
      return { ...base, category: "resource-not-found" };
    default:
      break;
  }
  if (refined === "unknown-reserved") return { ...base, category: "unknown-reserved" };
  if (code <= -32000 && code >= -32099) return { ...base, category: "server-error" };
  return { ...base, category: "application" };
}

export function parseUnsupportedVersionData(data: unknown): UnsupportedVersionData | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const supported = rec["supported"];
  if (!Array.isArray(supported) || !supported.every((v) => typeof v === "string")) return undefined;
  const requested = rec["requested"];
  return {
    supported: supported as string[],
    ...(typeof requested === "string" ? { requested } : {}),
  };
}

/** Picks the first version from our preference list that the server also supports (VER-2). */
export function selectProtocolVersion(
  ours: readonly string[],
  theirs: readonly string[],
): string | undefined {
  return ours.find((v) => theirs.includes(v));
}

// ---------------------------------------------------------------------------------------------
// Unsupported-version / legacy diagnostics (VER-3, VER-DIAG-1)
// ---------------------------------------------------------------------------------------------

export interface UnsupportedVersionDiagnostic {
  readonly binding: string;
  readonly endpointOrCommand: string;
  readonly requested: string;
  readonly supported?: readonly string[];
  readonly observed: "modern-error" | "other-error" | "timeout" | "http-status";
  readonly evidence: string;
  readonly advice: string;
}

export interface LifecycleContext {
  readonly binding: string;
  readonly endpointOrCommand: string;
  readonly supportedVersions: readonly string[];
}

function clip(s: string): string {
  return s.length > DIAGNOSTIC_EVIDENCE_MAX ? s.slice(0, DIAGNOSTIC_EVIDENCE_MAX) : s;
}

export function buildUnsupportedVersionDiagnostic(
  ctx: LifecycleContext,
  observed: UnsupportedVersionDiagnostic["observed"],
  evidence: string,
  supported?: readonly string[],
): UnsupportedVersionDiagnostic {
  const ours = ctx.supportedVersions.join(", ") || SUPPORTED_PROTOCOL_VERSION;
  const advice =
    observed === "modern-error"
      ? `The server supports ${supported && supported.length > 0 ? supported.join(", ") : "no listed version"}; this client implements only ${ours}. Upgrade the server or use a client that implements one of its versions.`
      : `The peer did not answer server/discover as a ${ours} server; this client implements only ${ours} and never falls back to initialize. Upgrade the server to a ${ours} release.`;
  return {
    binding: ctx.binding,
    endpointOrCommand: ctx.endpointOrCommand,
    requested: ctx.supportedVersions[0] ?? SUPPORTED_PROTOCOL_VERSION,
    ...(supported !== undefined ? { supported } : {}),
    observed,
    evidence: clip(evidence),
    advice,
  };
}

/**
 * Default outcome mapping applied to every settled request:
 * a -32022 that was not (or no longer) retryable becomes `unsupported-version` with a diagnostic
 * (VER-3, VER-4). Everything else passes through.
 */
export function mapLifecycleOutcome<T>(outcome: Outcome<T>, ctx: LifecycleContext): Outcome<T> {
  if (outcome.kind === "jsonrpc-error" && outcome.code === -32022) {
    const parsed = parseUnsupportedVersionData(outcome.data);
    return {
      kind: "unsupported-version",
      detail: buildUnsupportedVersionDiagnostic(
        ctx,
        "modern-error",
        `${outcome.code} ${outcome.message}`,
        parsed?.supported,
      ),
      meta: outcome.meta,
    };
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// server/discover and era cache (VER-5, VER-6, VER-CACHE-1)
// ---------------------------------------------------------------------------------------------

export type EraState =
  | {
      readonly era: "modern";
      readonly version: string;
      /** DiscoverResult when discover succeeded. serverInfo inside is display/log only (VER-6). */
      readonly discover?: DiscoverResult;
      readonly supported: readonly string[];
    }
  | { readonly era: "modern-no-mutual"; readonly diagnostic: UnsupportedVersionDiagnostic }
  | { readonly era: "legacy-or-unresponsive"; readonly diagnostic: UnsupportedVersionDiagnostic }
  | { readonly era: "unknown"; readonly outcome: Outcome<unknown> };

/** Whether an era verdict is cached; `unknown` (local cancel, transport fault) is not. */
export function isCacheableEra(state: EraState): boolean {
  return state.era !== "unknown";
}

/** Classifies the outcome of a server/discover probe into an era verdict. Never branches on serverInfo. */
export function classifyDiscoverOutcome(outcome: Outcome<unknown>, ctx: LifecycleContext): EraState {
  if (outcome.kind === "ok") {
    const value = outcome.value as Record<string, unknown> | undefined;
    const supported = value?.["supportedVersions"];
    if (!Array.isArray(supported) || !supported.every((v) => typeof v === "string")) {
      return {
        era: "legacy-or-unresponsive",
        diagnostic: buildUnsupportedVersionDiagnostic(
          ctx,
          "other-error",
          `server/discover result has no supportedVersions string array: ${clip(JSON.stringify(value) ?? "")}`,
        ),
      };
    }
    const version = selectProtocolVersion(ctx.supportedVersions, supported as string[]);
    if (!version) {
      return {
        era: "modern-no-mutual",
        diagnostic: buildUnsupportedVersionDiagnostic(
          ctx,
          "modern-error",
          `server/discover supportedVersions: ${JSON.stringify(supported)}`,
          supported as string[],
        ),
      };
    }
    return { era: "modern", version, supported: supported as string[], discover: value as unknown as DiscoverResult };
  }
  if (outcome.kind === "unsupported-version") {
    const d = outcome.detail as Partial<UnsupportedVersionDiagnostic> | undefined;
    const supported = d?.supported ?? [];
    const version = selectProtocolVersion(ctx.supportedVersions, supported);
    if (version) return { era: "modern", version, supported };
    return {
      era: "modern-no-mutual",
      diagnostic: buildUnsupportedVersionDiagnostic(ctx, "modern-error", d?.evidence ?? "-32022", supported),
    };
  }
  if (outcome.kind === "jsonrpc-error") {
    if (outcome.code === -32022) {
      const parsed = parseUnsupportedVersionData(outcome.data);
      const version = parsed ? selectProtocolVersion(ctx.supportedVersions, parsed.supported) : undefined;
      if (version && parsed) return { era: "modern", version, supported: parsed.supported };
      return {
        era: "modern-no-mutual",
        diagnostic: buildUnsupportedVersionDiagnostic(
          ctx,
          "modern-error",
          `${outcome.code} ${outcome.message}`,
          parsed?.supported,
        ),
      };
    }
    const data = outcome.data !== undefined ? ` ${JSON.stringify(outcome.data)}` : "";
    return {
      era: "legacy-or-unresponsive",
      diagnostic: buildUnsupportedVersionDiagnostic(ctx, "other-error", `${outcome.code} ${outcome.message}${data}`),
    };
  }
  if (outcome.kind === "transport-failure") {
    if (outcome.failure.kind === "timeout") {
      return {
        era: "legacy-or-unresponsive",
        diagnostic: buildUnsupportedVersionDiagnostic(ctx, "timeout", outcome.failure.message),
      };
    }
    if (outcome.failure.kind === "http-status" && outcome.failure.status !== undefined && outcome.failure.status >= 400 && outcome.failure.status < 500) {
      return {
        era: "legacy-or-unresponsive",
        diagnostic: buildUnsupportedVersionDiagnostic(
          ctx,
          "http-status",
          `HTTP ${outcome.failure.status}: ${outcome.failure.message}`,
        ),
      };
    }
  }
  if (outcome.kind === "protocol-violation") {
    return {
      era: "legacy-or-unresponsive",
      diagnostic: buildUnsupportedVersionDiagnostic(ctx, "other-error", `protocol-violation ${JSON.stringify(outcome.detail)}`),
    };
  }
  return { era: "unknown", outcome };
}

/**
 * In-memory era cache keyed by server config key (VER-CACHE-1: never persisted).
 * `resolve` is single-flight per key; uncacheable verdicts are returned but not stored.
 */
export class EraCache {
  private readonly entries = new Map<string, EraState>();
  private readonly inflight = new Map<string, Promise<EraState>>();

  get(key: string): EraState | undefined {
    return this.entries.get(key);
  }

  set(key: string, state: EraState): void {
    if (isCacheableEra(state)) this.entries.set(key, state);
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  resolve(key: string, probe: () => Promise<EraState>): Promise<EraState> {
    const hit = this.get(key);
    if (hit) return Promise.resolve(hit);
    const running = this.inflight.get(key);
    if (running) return running;
    const p = probe().then(
      (state) => {
        this.inflight.delete(key);
        this.set(key, state);
        return state;
      },
      (err: unknown) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, p);
    return p;
  }
}

// ---------------------------------------------------------------------------------------------
// Inbound notification policy and lifecycle hooks
// ---------------------------------------------------------------------------------------------

export type NotificationVerdict =
  | "deliver"
  | "progress"
  | "drop-log"
  | "drop-cancelled"
  | "drop-other";

/**
 * Default per-request notification policy:
 * - notifications/progress goes to the progress registry (PROG-*)
 * - notifications/message is dropped: logging is deprecated (WIRE-LOG-1, EDGE-33)
 * - notifications/cancelled is accepted only for our subscriptions/listen request (WIRE-CANCEL-4)
 * - anything else is delivered on the request's notification stream
 */
export function defaultNotificationFilter(n: JsonRpcNotification, req: JsonRpcRequest): NotificationVerdict {
  if (n.method === "notifications/progress") return "progress";
  if (n.method === "notifications/message") return "drop-log";
  if (n.method === "notifications/cancelled") {
    const rid = n.params?.["requestId"];
    if (req.method === "subscriptions/listen" && rid === req.id) return "deliver";
    return "drop-cancelled";
  }
  return "deliver";
}

export interface LifecycleHooks {
  mapOutcome<T>(outcome: Outcome<T>, ctx: LifecycleContext): Outcome<T>;
  classifyDiscover(outcome: Outcome<unknown>, ctx: LifecycleContext): EraState;
  filterNotification(n: JsonRpcNotification, req: JsonRpcRequest): NotificationVerdict;
}

export const defaultLifecycleHooks: LifecycleHooks = {
  mapOutcome: mapLifecycleOutcome,
  classifyDiscover: classifyDiscoverOutcome,
  filterNotification: defaultNotificationFilter,
};

/** Helper for hosts: missing capabilities from a -32021 outcome (VER-7), else undefined. */
export function missingClientCapabilities(outcome: Outcome<unknown>): unknown {
  if (outcome.kind !== "jsonrpc-error" || outcome.code !== -32021) return undefined;
  return classifyJsonRpcError(outcome.code, outcome.data).requiredCapabilities;
}

export interface LifecyclePolicyOptions {
  /** Replace individual lifecycle policies (outcome mapping, discover classification, notification filter). */
  readonly hooks?: Partial<LifecycleHooks>;
  /** Settle a request locally on abort/timeout when the transport does not. Default true. */
  readonly settleOnAbort?: boolean;
  /** Methods treated as read-only for uncertain-write classification. Default DEFAULT_READ_ONLY_METHODS. */
  readonly readOnlyMethods?: readonly string[];
  /** Progress registry (shared or custom). Default: one per client. */
  readonly progressRegistry?: ProgressRegistry;
  /** In-memory era cache (shared or custom). Default: one per client. Never persisted. */
  readonly eraCache?: EraCache;
}

export interface ProbeOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
