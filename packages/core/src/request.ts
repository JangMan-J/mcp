import { argsDigest, createReadOnlyPredicate, guardExchangeDone } from "./cancel.js";
import { ExtensionRegistry } from "./extension.js";
import {
  assertOutboundRequest,
  createMonotonicIdGenerator,
  JSONRPC_VERSION,
  SUPPORTED_PROTOCOL_VERSION,
  type IdGenerator,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type RequestId,
} from "./jsonrpc.js";
import {
  defaultLifecycleHooks,
  LIBRARY_CLIENT_INFO,
  META_LOG_LEVEL,
  type LifecycleContext,
  type LifecycleHooks,
  type LifecyclePolicyOptions,
} from "./lifecycle.js";
import {
  refineJsonRpcCode,
  type Outcome,
  type OutcomeMeta,
  type UncertainWrite,
} from "./outcome.js";
import {
  systemClock,
  type Clock,
  type ExchangeEnd,
  type LoggerPort,
  type PortRegistry,
  type ProgressEvent,
  type Transport,
} from "./ports.js";
import {
  isProgressToken,
  NotificationQueue,
  parseProgressParams,
  ProgressRegistry,
  ProgressThrottle,
  type ProgressToken,
} from "./progress.js";
import { noopTelemetry, validateTraceContext } from "./telemetry.js";

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion" as const;
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities" as const;
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo" as const;
export const META_PROGRESS_TOKEN = "io.modelcontextprotocol/progressToken" as const;
export const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo" as const;

const META_KEY_RE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface Limits {
  readonly maxInFlight: number;
  readonly defaultTimeoutMs: number;
  readonly hardMaxTimeoutMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxInFlight: 256,
  defaultTimeoutMs: 60_000,
  hardMaxTimeoutMs: 600_000,
};

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly stream?: boolean;
  readonly onProgress?: (p: ProgressEvent) => void;
  readonly idempotent?: boolean;
  /** HTTP-AMBIG-3: required (true) to re-issue a request after an uncertain-write. */
  readonly acceptDuplicate?: boolean;
  /** HTTP-AMBIG-3: original request id when re-issuing after an uncertain-write. */
  readonly retryOf?: RequestId;
  readonly meta?: Record<string, unknown>;
  readonly mrtr?: "auto" | "manual";
  readonly headersHint?: {
    readonly name?: string;
    readonly params?: Readonly<Record<string, string | number | boolean>>;
  };
}

export interface NotifyOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly meta?: Record<string, unknown>;
  readonly headersHint?: {
    readonly name?: string;
    readonly params?: Readonly<Record<string, string | number | boolean>>;
  };
}

export interface ClientRequest<T = unknown> extends PromiseLike<Outcome<T>> {
  readonly id: RequestId;
  readonly progress: AsyncIterable<ProgressEvent>;
  readonly notifications: AsyncIterable<JsonRpcNotification>;
  cancel(reason?: string): void;
  readonly signal: AbortSignal;
}

export interface StreamHandle extends AsyncIterable<JsonRpcNotification> {
  readonly id: RequestId;
  readonly done: Promise<Outcome<unknown>>;
  close(): void;
}

export function validateMetaEntries(meta: Record<string, unknown>): void {
  for (const key of Object.keys(meta)) {
    if (key === META_PROTOCOL_VERSION || key === META_CLIENT_CAPABILITIES) {
      throw new Error(`Caller _meta cannot override reserved key '${key}' (WIRE-META-4)`);
    }
    if (!META_KEY_RE.test(key)) {
      throw new TypeError(`Invalid _meta key syntax '${key}' (WIRE-META-5)`);
    }
  }
}

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

export interface RequestManagerConfig {
  readonly transport: Transport;
  readonly serverLabel?: string;
  readonly ports?: Partial<PortRegistry>;
  readonly clientInfo?: { readonly name: string; readonly version: string; readonly title?: string } | false;
  readonly extensions?: ExtensionRegistry;
  readonly idGenerator?: IdGenerator;
  readonly limits?: Partial<Limits>;
  readonly supportedVersions?: readonly string[];
  readonly protocolVersion?: string;
  readonly lifecycle?: LifecyclePolicyOptions;
}

export class RequestManager {
  private readonly transport: Transport;
  private readonly clock: Clock;
  private readonly logger?: LoggerPort;
  private readonly extensions: ExtensionRegistry;
  private readonly nextId: IdGenerator;
  private readonly limits: Limits;
  private readonly ports: Partial<PortRegistry>;
  private readonly serverLabel?: string;
  private readonly clientInfo?: { readonly name: string; readonly version: string; readonly title?: string } | false;
  private readonly supportedVersions: readonly string[];
  private activeProtocolVersion: string;
  private readonly hooks: LifecycleHooks;
  private readonly settleOnAbort: boolean;
  private readonly isReadOnly: (method: string) => boolean;
  private readonly progress: ProgressRegistry;
  private readonly ctx: LifecycleContext;
  private readonly inFlight = new Set<AbortController>();
  // LIM-CONC-1: over-cap requests wait here in FIFO order; nothing is sent while queued.
  private readonly admissionQueue: Array<{ readonly ac: AbortController; readonly admit: () => void }> = [];
  private closed = false;

  constructor(cfg: RequestManagerConfig) {
    this.transport = cfg.transport;
    this.ports = cfg.ports ?? {};
    if (cfg.serverLabel !== undefined) this.serverLabel = cfg.serverLabel;
    this.clock = cfg.ports?.clock ?? systemClock;
    if (cfg.ports?.logger) {
      this.logger = cfg.ports.logger;
    }
    this.extensions = cfg.extensions ?? new ExtensionRegistry();
    this.nextId = cfg.idGenerator ?? createMonotonicIdGenerator();
    this.limits = { ...DEFAULT_LIMITS, ...cfg.limits };
    if (cfg.clientInfo !== undefined) {
      this.clientInfo = cfg.clientInfo;
    }
    this.supportedVersions = cfg.supportedVersions ?? [SUPPORTED_PROTOCOL_VERSION];
    this.activeProtocolVersion = cfg.protocolVersion ?? SUPPORTED_PROTOCOL_VERSION;
    const lc = cfg.lifecycle ?? {};
    this.hooks = { ...defaultLifecycleHooks, ...lc.hooks };
    this.settleOnAbort = lc.settleOnAbort ?? true;
    this.isReadOnly = createReadOnlyPredicate(lc.readOnlyMethods);
    this.progress = lc.progressRegistry ?? new ProgressRegistry();
    this.ctx = {
      binding: cfg.transport.binding,
      endpointOrCommand: cfg.serverLabel ?? cfg.transport.binding,
      supportedVersions: this.supportedVersions,
    };
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  request<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    opts: RequestOptions = {},
  ): ClientRequest<T> {
    if (opts.meta) {
      validateCallerMeta(opts.meta);
    }
    const id = this.nextId();
    const ac = new AbortController();
    const cancel = (reason?: string) => ac.abort(reason);

    let onOuterAbort: (() => void) | undefined;
    if (opts.signal) {
      if (opts.signal.aborted) {
        ac.abort(opts.signal.reason);
      } else {
        onOuterAbort = () => ac.abort(opts.signal?.reason);
        opts.signal.addEventListener("abort", onOuterAbort, { once: true });
      }
    }

    const notificationsQueue = new NotificationQueue<JsonRpcNotification>();
    const progressQueue = new NotificationQueue<ProgressEvent>();

    const promise = this.execute<T>(
      id,
      method,
      params,
      opts,
      ac,
      notificationsQueue,
      progressQueue,
      onOuterAbort,
    );

    return {
      id,
      signal: ac.signal,
      cancel,
      progress: progressQueue,
      notifications: notificationsQueue,
      then: promise.then.bind(promise),
    };
  }

  async notify(
    method: string,
    params: Record<string, unknown> = {},
    opts: NotifyOptions = {},
  ): Promise<void> {
    if (typeof method !== "string" || method.length === 0) {
      throw new TypeError("Outbound notification method must be a non-empty string");
    }
    if (opts.meta) {
      validateCallerMeta(opts.meta);
    }
    if (this.closed) {
      throw new Error("McpClient is closed");
    }
    const ac = new AbortController();
    let onOuterAbort: (() => void) | undefined;
    if (opts.signal) {
      if (opts.signal.aborted) {
        ac.abort(opts.signal.reason);
      } else {
        onOuterAbort = () => ac.abort(opts.signal?.reason);
        opts.signal.addEventListener("abort", onOuterAbort, { once: true });
      }
    }
    const timeoutMs = Math.min(opts.timeoutMs ?? this.limits.defaultTimeoutMs, this.limits.hardMaxTimeoutMs);
    let cancelTimer: (() => void) | undefined;
    if (!ac.signal.aborted && timeoutMs > 0) {
      cancelTimer = this.clock.setTimeout(() => ac.abort("timeout"), timeoutMs);
    }
    try {
      const meta = this.buildMeta(undefined, this.activeProtocolVersion, opts);
      const msg: JsonRpcNotification = {
        jsonrpc: JSONRPC_VERSION,
        method,
        params: { ...params, _meta: meta },
      };
      await this.transport.notify(msg, {
        signal: ac.signal,
        idempotent: this.isReadOnly(method),
        ...(opts.headersHint ? { headersHint: opts.headersHint } : {}),
        timeoutMs,
        ...(this.ports.consent ? { consent: this.ports.consent } : {}),
        ...(this.serverLabel !== undefined ? { serverLabel: this.serverLabel } : {}),
      });
    } finally {
      cancelTimer?.();
      if (onOuterAbort && opts.signal) {
        opts.signal.removeEventListener("abort", onOuterAbort);
      }
    }
  }

  private buildMeta(
    id: RequestId | undefined,
    protocolVersion: string,
    opts: RequestOptions | NotifyOptions,
    includeProgressToken = false,
  ): Record<string, unknown> {
    const caps: Record<string, unknown> = { ...this.extensions.capabilities() };
    if (this.ports.consent) {
      const elic: Record<string, unknown> = { form: {} };
      if (this.ports.browser) {
        elic["url"] = {};
      }
      caps["elicitation"] = elic;
    }
    const base: Record<string, unknown> = {
      [META_PROTOCOL_VERSION]: protocolVersion,
      [META_CLIENT_CAPABILITIES]: caps,
    };
    if (this.clientInfo !== false) {
      base[META_CLIENT_INFO] = this.clientInfo ?? this.ports.identity?.clientInfo() ?? LIBRARY_CLIENT_INFO;
    }
    if (id !== undefined && includeProgressToken) {
      base[META_PROGRESS_TOKEN] = id;
    }
    const telemetry = this.ports.telemetry ?? noopTelemetry;
    const trace = telemetry.activeContext();
    if (trace) {
      const res = validateTraceContext(trace);
      if (res.valid) {
        base["traceparent"] = res.valid.traceparent;
        if (res.valid.tracestate) base["tracestate"] = res.valid.tracestate;
        if (res.valid.baggage) base["baggage"] = res.valid.baggage;
      } else {
        this.logger?.warn("invalid trace context omitted", { diagnostics: res.diagnostics });
      }
    }
    if (opts.meta) {
      Object.assign(base, opts.meta);
    }
    return base;
  }

  private async execute<T>(
    firstId: RequestId,
    method: string,
    rawParams: Record<string, unknown>,
    opts: RequestOptions,
    ac: AbortController,
    notificationsQueue: NotificationQueue<JsonRpcNotification>,
    progressQueue: NotificationQueue<ProgressEvent>,
    onOuterAbort?: () => void,
  ): Promise<Outcome<T>> {
    try {
      const raw = await this.executeCore<T>(
        firstId,
        method,
        rawParams,
        opts,
        ac,
        notificationsQueue,
        progressQueue,
      );
      return this.hooks.mapOutcome(raw, this.ctx);
    } finally {
      if (onOuterAbort && opts.signal) {
        opts.signal.removeEventListener("abort", onOuterAbort);
      }
      notificationsQueue.close();
      progressQueue.close();
    }
  }

  private async executeCore<T>(
    firstId: RequestId,
    method: string,
    rawParams: Record<string, unknown>,
    opts: RequestOptions,
    ac: AbortController,
    notificationsQueue: NotificationQueue<JsonRpcNotification>,
    progressQueue: NotificationQueue<ProgressEvent>,
  ): Promise<Outcome<T>> {
    const baseMeta = (reqId: RequestId, attempts: number, result?: Record<string, unknown>): OutcomeMeta => {
      const resultMeta = result && typeof result["_meta"] === "object" && result["_meta"] !== null && !Array.isArray(result["_meta"])
        ? (result["_meta"] as Record<string, unknown>)
        : undefined;
      const rawServerInfo = resultMeta?.[META_SERVER_INFO];
      const serverInfo =
        typeof rawServerInfo === "object" &&
        rawServerInfo !== null &&
        !Array.isArray(rawServerInfo) &&
        typeof (rawServerInfo as Record<string, unknown>)["name"] === "string" &&
        typeof (rawServerInfo as Record<string, unknown>)["version"] === "string"
          ? {
              name: (rawServerInfo as Record<string, unknown>)["name"] as string,
              version: (rawServerInfo as Record<string, unknown>)["version"] as string,
              ...(typeof (rawServerInfo as Record<string, unknown>)["title"] === "string"
                ? { title: (rawServerInfo as Record<string, unknown>)["title"] as string }
                : {}),
            }
          : undefined;
      return {
        requestId: reqId,
        method,
        binding: this.transport.binding,
        attempts,
        ...(opts.retryOf !== undefined ? { retryOf: opts.retryOf } : {}),
        ...(serverInfo !== undefined ? { serverInfo } : {}),
      };
    };

    // HTTP-AMBIG-3: re-issue after uncertain-write is opt-in; refuse locally, nothing sent.
    if (opts.retryOf !== undefined && opts.acceptDuplicate !== true) {
      return {
        kind: "local-error",
        detail: { reason: "accept-duplicate-required", retryOf: opts.retryOf },
        meta: baseMeta(firstId, 0),
      };
    }

    if (this.closed) {
      return {
        kind: "transport-failure",
        failure: { kind: "closed", message: "McpClient is closed" },
        safeToRetry: false,
        meta: baseMeta(firstId, 0),
      };
    }

    // EDGE-6: Abort before send emits zero wire traffic.
    if (ac.signal.aborted) {
      return {
        kind: "cancelled",
        wasSent: false,
        phase: "queue",
        meta: baseMeta(firstId, 0),
      };
    }

    // LIM-CONC-1: cap in-flight requests; queue FIFO beyond the cap, abortable while queued.
    if (this.inFlight.size >= this.limits.maxInFlight || this.admissionQueue.length > 0) {
      const admitted = await new Promise<boolean>((resolve) => {
        const onAbort = () => {
          const i = this.admissionQueue.indexOf(entry);
          if (i >= 0) this.admissionQueue.splice(i, 1);
          resolve(false);
        };
        const entry = {
          ac,
          admit: () => {
            ac.signal.removeEventListener("abort", onAbort);
            resolve(true);
          },
        };
        this.admissionQueue.push(entry);
        ac.signal.addEventListener("abort", onAbort, { once: true });
      });
      if (!admitted) {
        return {
          kind: "cancelled",
          wasSent: false,
          phase: "queue",
          meta: baseMeta(firstId, 0),
        };
      }
    }

    const isStream = opts.stream === true;
    const hasStreamTimeout =
      isStream &&
      opts.timeoutMs !== undefined &&
      Number.isFinite(opts.timeoutMs) &&
      opts.timeoutMs > 0;
    const timeoutMs = isStream
      ? hasStreamTimeout
        ? opts.timeoutMs!
        : 0
      : Math.min(opts.timeoutMs ?? this.limits.defaultTimeoutMs, this.limits.hardMaxTimeoutMs);
    const idempotent = opts.idempotent ?? this.isReadOnly(method);

    let attempts = 0;
    let currentId = firstId;
    let currentVersion = this.activeProtocolVersion;
    let retriedVersion = false;
    const onProgress = opts.onProgress;
    // LIM-PROG-1: <=50 callbacks/s, coalesced to latest; flushed before settlement.
    const throttle = onProgress ? new ProgressThrottle<ProgressEvent>(this.clock, onProgress) : undefined;

    while (true) {
      attempts += 1;
      const meta = this.buildMeta(currentId, currentVersion, opts, opts.onProgress !== undefined);
      const req: JsonRpcRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: currentId,
        method,
        params: { ...rawParams, _meta: meta },
      };
      assertOutboundRequest(req);

      const rawToken = meta[META_PROGRESS_TOKEN];
      let token: ProgressToken | undefined;
      if (isProgressToken(rawToken) && this.progress.register(rawToken)) {
        token = rawToken;
      }
      let tokenReleased = false;
      const releaseToken = () => {
        if (!tokenReleased && token !== undefined) {
          tokenReleased = true;
          this.progress.release(token);
        }
      };

      this.inFlight.add(ac);
      let cancelTimer: (() => void) | undefined;
      let timedOut = false;
      let observedTask: Record<string, unknown> | undefined;

      try {
        const exchange = this.transport.start(req, {
          signal: ac.signal,
          idempotent,
          ...(opts.headersHint ? { headersHint: opts.headersHint } : {}),
          timeoutMs,
          ...(this.ports.consent ? { consent: this.ports.consent } : {}),
          ...(this.serverLabel !== undefined ? { serverLabel: this.serverLabel } : {}),
        });

        let settled = false;
        let resolveSettle!: (v: "settled") => void;
        const settleSignal = new Promise<"settled">((resolve) => {
          resolveSettle = resolve;
        });
        const markSettled = () => {
          if (!settled) {
            settled = true;
            resolveSettle("settled");
          }
        };

        const guarded = guardExchangeDone(
          exchange,
          ac.signal,
          { settleOnAbort: this.settleOnAbort },
          { onSettle: markSettled },
        );

        const handleNotification = (n: JsonRpcNotification): void => {
          const verdict = this.hooks.filterNotification(n, req);
          if (verdict === "progress") {
            if (token === undefined) return;
            const decision = this.progress.accept(n.params, token);
            if (decision.accept) {
              notificationsQueue.push(n);
              progressQueue.push(decision.event);
              throttle?.push(decision.event);
            }
            return;
          }
          if (verdict !== "deliver") {
            return;
          }
          const np = n.params as Record<string, unknown> | undefined;
          if (np && typeof np["taskId"] === "string") observedTask = np;
          if (n.method === "notifications/progress" && n.params) {
            const ev = parseProgressParams(n.params) ?? {
              progressToken: currentId,
              progress: Number((n.params as Record<string, unknown>)["progress"] ?? 0),
              ...(typeof (n.params as Record<string, unknown>)["total"] === "number"
                ? { total: (n.params as Record<string, unknown>)["total"] as number }
                : {}),
              ...(typeof (n.params as Record<string, unknown>)["message"] === "string"
                ? { message: (n.params as Record<string, unknown>)["message"] as string }
                : {}),
            };
            progressQueue.push(ev);
            throttle?.push(ev);
          }
          this.extensions.dispatchNotification(n, (err) => {
            this.logger?.warn("extension notification handler failed", {
              method: n.method,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          notificationsQueue.push(n);
        };

        const pump = (async () => {
          const it = exchange.notifications[Symbol.asyncIterator]();
          try {
            for (;;) {
              const next = it.next();
              const step = settled
                ? await Promise.race([next, Promise.resolve("settled" as const)])
                : await Promise.race([next, settleSignal]);
              if (step === "settled") {
                void it.return?.().catch(() => {});
                break;
              }
              if (step.done) break;
              handleNotification(step.value);
            }
          } catch {
            // Transport notification stream failures settle via guarded.done.
          }
        })();

        const armTimeout = !isStream || hasStreamTimeout;
        let race: ExchangeEnd | "timeout";
        if (armTimeout) {
          const timeoutPromise = new Promise<"timeout">((resolve) => {
            cancelTimer = this.clock.setTimeout(() => {
              timedOut = true;
              ac.abort("timeout");
              resolve("timeout");
            }, timeoutMs);
          });
          race = await Promise.race([guarded.done, timeoutPromise]);
          cancelTimer?.();
        } else {
          race = await guarded.done;
        }
        markSettled();
        await pump;
        releaseToken();

        const uncertainOutcome = (evidence: UncertainWrite["evidence"]): Outcome<T> => ({
          kind: "uncertain-write",
          uncertain: {
            requestId: currentId,
            method,
            ...(typeof rawParams["name"] === "string" ? { name: rawParams["name"] } : {}),
            argsDigest: argsDigest(rawParams),
            sentAt: this.clock.now(),
            binding: this.transport.binding,
            evidence,
            ...(observedTask ? { taskHandle: observedTask } : {}),
          },
          meta: baseMeta(currentId, attempts),
        });

        if (race === "timeout" || (race.kind === "failure" && (timedOut || race.failure.kind === "timeout"))) {
          const delivery = race === "timeout" ? exchange.abortDelivery?.() : race.delivery;
          if (!idempotent && delivery !== "not-sent") {
            return uncertainOutcome("timeout");
          }
          return {
            kind: "transport-failure",
            failure: { kind: "timeout", message: `Request timed out after ${timeoutMs}ms` },
            safeToRetry: true,
            meta: baseMeta(currentId, attempts),
          };
        }

        if (race.kind === "failure") {
          if (ac.signal.aborted && !timedOut) {
            if (!idempotent && race.delivery !== "not-sent") {
              return uncertainOutcome("cancelled");
            }
            return {
              kind: "cancelled",
              wasSent: race.delivery !== "not-sent",
              phase: "wire",
              meta: baseMeta(currentId, attempts),
            };
          }
          if (race.failure.kind === "auth-failure" || race.failure.kind === "auth-unavailable") {
            return {
              kind: race.failure.kind,
              detail: { reason: race.failure.reason, status: race.failure.status },
              meta: baseMeta(currentId, attempts),
            };
          }
          if (!idempotent && race.delivery !== "not-sent") {
            return uncertainOutcome(race.failure.kind === "process-exit" ? "process-exit" : "stream-broken");
          }
          return {
            kind: "transport-failure",
            failure: race.failure,
            safeToRetry: race.delivery === "not-sent" || idempotent,
            meta: baseMeta(currentId, attempts),
          };
        }

        const msg = race.message;
        if ("error" in msg) {
          const code = msg.error.code;
          const refined = refineJsonRpcCode(code);
          // VER-2 / VER-4: Retry once on -32022 if server lists a mutually supported version.
          if (code === -32022 && !retriedVersion && msg.error.data && typeof msg.error.data === "object") {
            const supported = (msg.error.data as Record<string, unknown>)["supported"];
            if (Array.isArray(supported)) {
              const match = this.supportedVersions.find((v) => supported.includes(v));
              if (match) {
                retriedVersion = true;
                currentVersion = match;
                this.activeProtocolVersion = match;
                currentId = this.nextId();
                continue;
              }
            }
          }
          return {
            kind: "jsonrpc-error",
            code,
            message: msg.error.message,
            ...(msg.error.data !== undefined ? { data: msg.error.data } : {}),
            ...(refined ? { refined } : {}),
            meta: baseMeta(currentId, attempts),
          };
        }

        const result = msg.result;
        const resultType = result["resultType"];
        if (resultType !== undefined && typeof resultType !== "string") {
          return {
            kind: "protocol-violation",
            detail: { reason: "non-string resultType", resultType },
            meta: baseMeta(currentId, attempts, result),
          };
        }
        // WIRE-RT-2: Absent resultType treated as "complete".
        const effectiveType = resultType ?? "complete";
        if (effectiveType === "complete") {
          if (method === "tools/call" && result["isError"] === true) {
            return { kind: "tool-isError", result, meta: baseMeta(currentId, attempts, result) };
          }
          return { kind: "ok", value: result as T, meta: baseMeta(currentId, attempts, result) };
        }
        if (effectiveType === "input_required") {
          const reqState = typeof result["requestState"] === "string" ? result["requestState"] : undefined;
          const inputReq =
            typeof result["inputRequests"] === "object" && result["inputRequests"] !== null
              ? (result["inputRequests"] as Record<string, unknown>)
              : undefined;
          return {
            kind: "mrtr-interim",
            ...(inputReq ? { inputRequests: inputReq } : {}),
            ...(reqState !== undefined ? { requestState: reqState } : {}),
            meta: baseMeta(currentId, attempts, result),
          };
        }
        const extHandler = this.extensions.resolveResultType(effectiveType);
        if (extHandler) {
          return extHandler(result) as Outcome<T>;
        }
        // WIRE-RT-3 / EDGE-10: Unknown or unregistered extension resultType -> protocol-violation.
        return {
          kind: "protocol-violation",
          detail: { reason: "unknown-resultType", resultType: effectiveType },
          meta: baseMeta(currentId, attempts),
        };
      } finally {
        cancelTimer?.();
        releaseToken();
        throttle?.flush();
        this.inFlight.delete(ac);
        this.admitQueued();
      }
    }
  }

  /** LIM-CONC-1: hand freed slots to the oldest queued requests (slot reserved before resume). */
  private admitQueued(): void {
    while (this.inFlight.size < this.limits.maxInFlight && this.admissionQueue.length > 0) {
      const next = this.admissionQueue.shift()!;
      this.inFlight.add(next.ac);
      next.admit();
    }
  }

  async close(opts?: { readonly graceMs?: number }): Promise<void> {
    this.closed = true;
    for (const queued of [...this.admissionQueue]) {
      queued.ac.abort("client-closed");
    }
    for (const ac of this.inFlight) {
      ac.abort("client-closed");
    }
    this.extensions.closeAllReverse();
    await this.transport.close(opts);
  }
}
