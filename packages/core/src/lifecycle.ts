import { createReadOnlyPredicate, guardExchangeDone } from "./cancel.js";
import { ExtensionRegistry, type Disposable, type Extension } from "./extension.js";
import {
  SUPPORTED_PROTOCOL_VERSION,
  type IdGenerator,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./jsonrpc.js";
import { refineJsonRpcCode, type JsonRpcRefinement, type Outcome } from "./outcome.js";
import type { Exchange, PortRegistry, Transport, TransportCall, TransportDiagnostic } from "./ports.js";
import { isProgressToken, NotificationQueue, ProgressRegistry, type ProgressStats, type ProgressToken } from "./progress.js";
import {
  META_PROGRESS_TOKEN,
  RequestManager,
  validateMetaEntries,
  type ClientRequest,
  type Limits,
  type RequestOptions,
} from "./request.js";
import type { DiscoverResult } from "./schema/index.js";

/**
 * Wire lifecycle (S1.1, IMPLEMENTATION_PLAN.md §5; WIRE-*, VER-*).
 * Runtime-neutral: no node:* imports, no third-party dependencies.
 */

/** Library identity sent as io.modelcontextprotocol/clientInfo when the host supplies none (WIRE-META-3). */
export const LIBRARY_CLIENT_INFO: { readonly name: string; readonly version: string } = Object.freeze({
  name: "@mcp-client/core",
  version: "0.1.0",
});

/** Deprecated logging key; never sent (WIRE-LOG-1). */
export const META_LOG_LEVEL = "io.modelcontextprotocol/logLevel" as const;

/** Default timeout for the server/discover era probe (§5.5; local policy). */
export const DISCOVER_PROBE_TIMEOUT_MS = 10_000;

/** Max bytes of offending error text carried in a diagnostic (§5.5). */
export const DIAGNOSTIC_EVIDENCE_MAX = 2048;

/**
 * Validates caller-supplied _meta: reserved keys and key syntax (WIRE-META-4/5) plus the
 * deprecated logLevel key (WIRE-LOG-1). Throws before anything is sent.
 */
export function validateCallerMeta(meta: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(meta, META_LOG_LEVEL)) {
    throw new Error(`Caller _meta cannot set '${META_LOG_LEVEL}': logging is deprecated (WIRE-LOG-1)`);
  }
  validateMetaEntries(meta);
}

// ---------------------------------------------------------------------------------------------
// Error-code mapping (§5.2, §11.1; WIRE-ERR-3/4, VER-7, EDGE-32/34)
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
// Unsupported-version / legacy diagnostics (§5.5; VER-3, VER-DIAG-1)
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
 * Default outcome mapping applied by McpClient to every settled request:
 * a -32022 that was not (or no longer) retryable becomes `unsupported-version` with a diagnostic
 * (VER-3, VER-4). mrtr-interim resumes are mapped the same way. Everything else passes through.
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
  if (outcome.kind === "mrtr-interim") {
    const resume = outcome.resume;
    return {
      ...outcome,
      resume: (responses) => Promise.resolve(resume(responses)).then((o) => mapLifecycleOutcome(o, ctx)),
    };
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------
// server/discover and era cache (§5.3, §5.5; VER-5, VER-6, VER-CACHE-1)
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
// Inbound notification policy and the lifecycle transport layer
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
 * - notifications/message is dropped and counted: logging is deprecated (WIRE-LOG-1, EDGE-33)
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

export interface WireStats {
  readonly progress: ProgressStats;
  /** Responses/failures the transport delivered after the request had settled locally (WIRE-CANCEL-3). */
  readonly lateResponses: number;
  /** Non-progress notifications that arrived after the request settled. */
  readonly lateNotifications: number;
  readonly droppedLogMessages: number;
  readonly droppedCancelled: number;
  readonly droppedOther: number;
  /** Requests settled locally by abort/timeout because the transport did not settle them. */
  readonly localAbortSettles: number;
}

export interface LifecycleTransportOptions {
  readonly progress?: ProgressRegistry;
  readonly filterNotification?: LifecycleHooks["filterNotification"];
  /** Settle a request locally when it is aborted and the transport does not settle it. Default true. */
  readonly settleOnAbort?: boolean;
}

/**
 * Transport decorator that applies the core per-request lifecycle on top of any binding:
 * progress registry, inbound notification policy, first-settle-wins, abort settles locally,
 * late responses ignored and counted. It does not write notifications/cancelled; bindings do.
 */
export class LifecycleTransport implements Transport {
  readonly binding: Transport["binding"];
  readonly progress: ProgressRegistry;
  private readonly inner: Transport;
  private readonly filter: LifecycleHooks["filterNotification"];
  private readonly settleOnAbort: boolean;
  private readonly counters = {
    lateResponses: 0,
    lateNotifications: 0,
    droppedLogMessages: 0,
    droppedCancelled: 0,
    droppedOther: 0,
    localAbortSettles: 0,
  };

  constructor(inner: Transport, opts: LifecycleTransportOptions = {}) {
    this.inner = inner;
    this.binding = inner.binding;
    this.progress = opts.progress ?? new ProgressRegistry();
    this.filter = opts.filterNotification ?? defaultNotificationFilter;
    this.settleOnAbort = opts.settleOnAbort ?? true;
  }

  get diagnostics(): AsyncIterable<TransportDiagnostic> {
    return this.inner.diagnostics;
  }

  stats(): WireStats {
    return { progress: this.progress.stats(), ...this.counters };
  }

  start(msg: JsonRpcRequest, ctx: TransportCall): Exchange {
    const meta = msg.params?.["_meta"];
    const rawToken =
      typeof meta === "object" && meta !== null ? (meta as Record<string, unknown>)[META_PROGRESS_TOKEN] : undefined;
    let token: ProgressToken | undefined;
    if (isProgressToken(rawToken) && this.progress.register(rawToken)) {
      token = rawToken;
    }

    const inner = this.inner.start(msg, ctx);
    const out = new NotificationQueue<JsonRpcNotification>();

    const guarded = guardExchangeDone(
      inner,
      ctx.signal,
      { settleOnAbort: this.settleOnAbort },
      {
        onSettle: (_end, source) => {
          if (source === "abort") this.counters.localAbortSettles += 1;
          if (token !== undefined) this.progress.release(token);
          out.close();
        },
        onLate: () => {
          this.counters.lateResponses += 1;
        },
      },
    );

    const handle = (n: JsonRpcNotification): void => {
      const verdict = this.filter(n, msg);
      if (verdict === "progress") {
        const decision = this.progress.accept(n.params, token);
        if (decision.accept && !guarded.settled()) out.push(n);
        return;
      }
      if (verdict === "drop-log") {
        this.counters.droppedLogMessages += 1;
        return;
      }
      if (verdict === "drop-cancelled") {
        this.counters.droppedCancelled += 1;
        return;
      }
      if (verdict === "drop-other") {
        this.counters.droppedOther += 1;
        return;
      }
      if (guarded.settled() || !out.push(n)) {
        this.counters.lateNotifications += 1;
      }
    };

    void (async () => {
      for await (const n of inner.notifications) handle(n);
    })().catch(() => {});

    return {
      notifications: out,
      done: guarded.done,
      ...(inner.abortDelivery ? { abortDelivery: () => inner.abortDelivery!() } : {}),
    };
  }

  notify(msg: JsonRpcNotification, ctx: TransportCall): Promise<void> {
    return this.inner.notify(msg, ctx);
  }

  close(opts?: { readonly graceMs?: number }): Promise<void> {
    return this.inner.close(opts);
  }
}

/** Helper for hosts: missing capabilities from a -32021 outcome (VER-7), else undefined. */
export function missingClientCapabilities(outcome: Outcome<unknown>): unknown {
  if (outcome.kind !== "jsonrpc-error" || outcome.code !== -32021) return undefined;
  return classifyJsonRpcError(outcome.code, outcome.data).requiredCapabilities;
}

// ---------------------------------------------------------------------------------------------
// LifecycleClient: composition over the frozen RequestManager (McpClient stays unchanged)
// ---------------------------------------------------------------------------------------------

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

/** Same fields as McpClientOptions, plus `lifecycle` policy. */
export interface LifecycleClientOptions {
  readonly transport: Transport;
  readonly server: { readonly key: string; readonly label?: string };
  readonly clientInfo?: { readonly name: string; readonly version: string; readonly title?: string } | false;
  readonly ports?: Partial<PortRegistry>;
  readonly extensions?: readonly Extension[];
  readonly idGenerator?: IdGenerator;
  readonly supportedVersions?: readonly string[];
  readonly defaults?: {
    readonly timeoutMs?: number;
    readonly limits?: Partial<Limits>;
  };
  readonly lifecycle?: LifecyclePolicyOptions;
}

export interface ProbeOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Client with the full S1.1 wire lifecycle: LifecycleTransport (progress registry, notification
 * policy, local abort settle, late responses counted), default clientInfo (WIRE-META-3), caller
 * _meta checks incl. logLevel (WIRE-LOG-1), idempotent defaults from the read-only list (N14),
 * outcome mapping (-32022 -> unsupported-version), and server/discover era probing with an
 * in-memory cache. Same request/discover/use/close surface as McpClient.
 */
export class LifecycleClient {
  readonly server: { readonly key: string; readonly label?: string };
  private readonly extensions = new ExtensionRegistry();
  private readonly manager: RequestManager;
  private readonly wire: LifecycleTransport;
  private readonly hooks: LifecycleHooks;
  private readonly isReadOnly: (method: string) => boolean;
  private readonly eraCache: EraCache;
  private readonly ctx: LifecycleContext;

  constructor(opts: LifecycleClientOptions) {
    this.server = opts.server;
    const lc = opts.lifecycle ?? {};
    this.hooks = { ...defaultLifecycleHooks, ...lc.hooks };
    this.isReadOnly = createReadOnlyPredicate(lc.readOnlyMethods);
    this.eraCache = lc.eraCache ?? new EraCache();
    this.wire = new LifecycleTransport(opts.transport, {
      ...(lc.progressRegistry ? { progress: lc.progressRegistry } : {}),
      filterNotification: this.hooks.filterNotification,
      ...(lc.settleOnAbort !== undefined ? { settleOnAbort: lc.settleOnAbort } : {}),
    });
    this.ctx = {
      binding: opts.transport.binding,
      endpointOrCommand: opts.server.label ?? opts.server.key,
      supportedVersions: opts.supportedVersions ?? [SUPPORTED_PROTOCOL_VERSION],
    };
    // WIRE-META-3: sent by default; `false` disables it; an IdentityPort wins over the library default.
    const clientInfo =
      opts.clientInfo !== undefined ? opts.clientInfo : opts.ports?.identity ? undefined : LIBRARY_CLIENT_INFO;
    for (const ext of opts.extensions ?? []) {
      this.extensions.register(ext);
    }
    const limits =
      opts.defaults?.limits || opts.defaults?.timeoutMs !== undefined
        ? {
            ...opts.defaults?.limits,
            ...(opts.defaults?.timeoutMs !== undefined ? { defaultTimeoutMs: opts.defaults.timeoutMs } : {}),
          }
        : undefined;
    this.manager = new RequestManager({
      transport: this.wire,
      serverLabel: opts.server.label ?? opts.server.key,
      ...(opts.ports ? { ports: opts.ports } : {}),
      ...(clientInfo !== undefined ? { clientInfo } : {}),
      extensions: this.extensions,
      ...(opts.idGenerator ? { idGenerator: opts.idGenerator } : {}),
      ...(opts.supportedVersions ? { supportedVersions: opts.supportedVersions } : {}),
      ...(limits ? { limits } : {}),
    });
  }

  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    opts?: RequestOptions,
  ): ClientRequest<T> {
    if (opts?.meta) {
      validateCallerMeta(opts.meta);
    }
    const handle = this.manager.request<T>(method, params, {
      ...opts,
      idempotent: opts?.idempotent ?? this.isReadOnly(method),
    });
    const mapped = Promise.resolve(handle).then((o) => this.hooks.mapOutcome(o, this.ctx));
    return {
      id: handle.id,
      signal: handle.signal,
      cancel: (reason?: string) => handle.cancel(reason),
      progress: handle.progress,
      notifications: handle.notifications,
      then: mapped.then.bind(mapped),
    };
  }

  discover(opts?: RequestOptions): ClientRequest<DiscoverResult> {
    return this.request<DiscoverResult>("server/discover", {}, { ...opts, idempotent: true });
  }

  /**
   * Probes the server era with server/discover once per server key and caches the verdict in
   * memory (VER-5, VER-CACHE-1, VER-DIAG-1). Never sends initialize. Local cancels and transport
   * faults yield `unknown` and are not cached.
   */
  probe(opts: ProbeOptions = {}): Promise<EraState> {
    return this.eraCache.resolve(this.server.key, async () => {
      const outcome = await this.discover({
        timeoutMs: opts.timeoutMs ?? DISCOVER_PROBE_TIMEOUT_MS,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      return this.hooks.classifyDiscover(outcome, this.ctx);
    });
  }

  /** Cached era verdict for this server, if any. */
  era(): EraState | undefined {
    return this.eraCache.get(this.server.key);
  }

  /** Lifecycle counters: progress drops, late responses, dropped notifications. */
  wireStats(): WireStats {
    return this.wire.stats();
  }

  use(ext: Extension): Disposable {
    return this.extensions.register(ext);
  }

  async close(opts?: { readonly graceMs?: number }): Promise<void> {
    await this.manager.close(opts);
  }
}

export function createLifecycleClient(opts: LifecycleClientOptions): LifecycleClient {
  return new LifecycleClient(opts);
}
