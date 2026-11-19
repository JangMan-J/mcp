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
import { ExtensionRegistry } from "./extension.js";
import {
  refineJsonRpcCode,
  type Outcome,
  type OutcomeMeta,
  type UncertainWrite,
} from "./outcome.js";
import {
  systemClock,
  type Clock,
  type LoggerPort,
  type PortRegistry,
  type ProgressEvent,
  type Transport,
} from "./ports.js";
import { noopTelemetry, validateTraceContext } from "./telemetry.js";

export const META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion" as const;
export const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities" as const;
export const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo" as const;
export const META_PROGRESS_TOKEN = "io.modelcontextprotocol/progressToken" as const;

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
      validateMetaEntries(opts.meta);
    }
    const id = this.nextId();
    const ac = new AbortController();
    const cancel = (reason?: string) => ac.abort(reason);

    if (opts.signal) {
      if (opts.signal.aborted) {
        ac.abort(opts.signal.reason);
      } else {
        opts.signal.addEventListener("abort", () => ac.abort(opts.signal?.reason), { once: true });
      }
    }

    const notificationsBuf: JsonRpcNotification[] = [];
    const progressBuf: ProgressEvent[] = [];

    const promise = this.execute<T>(id, method, params, opts, ac, notificationsBuf, progressBuf);

    const makeAsyncIter = <E>(arr: E[]): AsyncIterable<E> => ({
      async *[Symbol.asyncIterator]() {
        await promise;
        for (const item of arr) yield item;
      },
    });

    return {
      id,
      signal: ac.signal,
      cancel,
      progress: makeAsyncIter(progressBuf),
      notifications: makeAsyncIter(notificationsBuf),
      then: promise.then.bind(promise),
    };
  }

  private buildMeta(
    id: RequestId,
    protocolVersion: string,
    opts: RequestOptions,
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
      const info = this.clientInfo ?? this.ports.identity?.clientInfo();
      if (info) {
        base[META_CLIENT_INFO] = info;
      }
    }
    if (opts.onProgress) {
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
    notificationsBuf: JsonRpcNotification[],
    progressBuf: ProgressEvent[],
  ): Promise<Outcome<T>> {
    const baseMeta = (reqId: RequestId, attempts: number): OutcomeMeta => ({
      requestId: reqId,
      method,
      binding: this.transport.binding,
      attempts,
      ...(opts.retryOf !== undefined ? { retryOf: opts.retryOf } : {}),
    });

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

    const timeoutMs = Math.min(opts.timeoutMs ?? this.limits.defaultTimeoutMs, this.limits.hardMaxTimeoutMs);
    const idempotent = opts.idempotent ?? false;

    let attempts = 0;
    let currentId = firstId;
    let currentVersion = this.activeProtocolVersion;
    let retriedVersion = false;

    while (true) {
      attempts += 1;
      const meta = this.buildMeta(currentId, currentVersion, opts);
      const req: JsonRpcRequest = {
        jsonrpc: JSONRPC_VERSION,
        id: currentId,
        method,
        params: { ...rawParams, _meta: meta },
      };
      assertOutboundRequest(req);

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

        const pump = (async () => {
          for await (const n of exchange.notifications) {
            notificationsBuf.push(n);
            const np = n.params as Record<string, unknown> | undefined;
            if (np && typeof np["taskId"] === "string") observedTask = np;
            if (n.method === "notifications/progress" && opts.onProgress && n.params) {
              const p = n.params as Record<string, unknown>;
              const ev: ProgressEvent = {
                progressToken: (p["progressToken"] as string | number) ?? currentId,
                progress: Number(p["progress"] ?? 0),
                ...(typeof p["total"] === "number" ? { total: p["total"] } : {}),
                ...(typeof p["message"] === "string" ? { message: p["message"] } : {}),
              };
              progressBuf.push(ev);
              opts.onProgress(ev);
            }
          }
        })();

        const timeoutPromise = new Promise<"timeout">((resolve) => {
          cancelTimer = this.clock.setTimeout(() => {
            timedOut = true;
            ac.abort("timeout");
            resolve("timeout");
          }, timeoutMs);
        });

        const race = await Promise.race([exchange.done, timeoutPromise]);
        cancelTimer?.();
        await pump.catch(() => {});

        if (race === "timeout" || (race.kind === "failure" && (timedOut || race.failure.kind === "timeout"))) {
          const delivery = race === "timeout" ? exchange.abortDelivery?.() : race.delivery;
          if (!idempotent && delivery !== "not-sent") {
            const uncertain: UncertainWrite = {
              requestId: currentId,
              method,
              ...(typeof rawParams["name"] === "string" ? { name: rawParams["name"] } : {}),
              argsDigest: simpleDigest(rawParams),
              sentAt: this.clock.now(),
              binding: this.transport.binding,
              evidence: "timeout",
              ...(observedTask ? { taskHandle: observedTask } : {}),
            };
            return { kind: "uncertain-write", uncertain, meta: baseMeta(currentId, attempts) };
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
              const uncertain: UncertainWrite = {
                requestId: currentId,
                method,
                ...(typeof rawParams["name"] === "string" ? { name: rawParams["name"] } : {}),
                argsDigest: simpleDigest(rawParams),
                sentAt: this.clock.now(),
                binding: this.transport.binding,
                evidence: "cancelled",
                ...(observedTask ? { taskHandle: observedTask } : {}),
              };
              return { kind: "uncertain-write", uncertain, meta: baseMeta(currentId, attempts) };
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
            const uncertain: UncertainWrite = {
              requestId: currentId,
              method,
              ...(typeof rawParams["name"] === "string" ? { name: rawParams["name"] } : {}),
              argsDigest: simpleDigest(rawParams),
              sentAt: this.clock.now(),
              binding: this.transport.binding,
              evidence: race.failure.kind === "process-exit" ? "process-exit" : "stream-broken",
              ...(observedTask ? { taskHandle: observedTask } : {}),
            };
            return { kind: "uncertain-write", uncertain, meta: baseMeta(currentId, attempts) };
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
            meta: baseMeta(currentId, attempts),
          };
        }
        // WIRE-RT-2: Absent resultType treated as "complete".
        const effectiveType = resultType ?? "complete";
        if (effectiveType === "complete") {
          if (method === "tools/call" && result["isError"] === true) {
            return { kind: "tool-isError", result, meta: baseMeta(currentId, attempts) };
          }
          return { kind: "ok", value: result as T, meta: baseMeta(currentId, attempts) };
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
            resume: (responses) =>
              this.request<T>(
                method,
                {
                  ...rawParams,
                  ...(reqState !== undefined ? { requestState: reqState } : {}),
                  ...(responses !== undefined ? { inputResponses: responses } : {}),
                },
                opts,
              ),
            meta: baseMeta(currentId, attempts),
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

function simpleDigest(obj: unknown): string {
  const s = JSON.stringify(obj) ?? "";
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv1a-${(h >>> 0).toString(16).padStart(8, "0")}`;
}
