import { ExtensionRegistry, type Disposable, type Extension } from "./extension.js";
import type { IdGenerator } from "./jsonrpc.js";
import type { PortRegistry, Transport } from "./ports.js";
import { RequestManager, type ClientRequest, type Limits, type RequestOptions } from "./request.js";
import type { DiscoverResult } from "./schema/index.js";
import { createReadOnlyPredicate } from "./cancel.js";
import {
  DISCOVER_PROBE_TIMEOUT_MS,
  EraCache,
  LIBRARY_CLIENT_INFO,
  LifecycleTransport,
  defaultLifecycleHooks,
  validateCallerMeta,
  type EraState,
  type LifecycleContext,
  type LifecycleHooks,
  type WireStats,
} from "./lifecycle.js";
import type { ProgressRegistry } from "./progress.js";
import { SUPPORTED_PROTOCOL_VERSION } from "./jsonrpc.js";

export * as McpSchema from "./schema/index.js";
export type { DiscoverResult } from "./schema/index.js";
export * from "./jsonrpc.js";
export * from "./outcome.js";
export * from "./ports.js";
export * from "./telemetry.js";
export * from "./auth-types.js";
export * from "./extension.js";
export * from "./request.js";
export * from "./lifecycle.js";
export * from "./cancel.js";
export * from "./progress.js";

export interface ServerRef {
  readonly key: string;
  readonly label?: string;
}

export interface McpClientOptions {
  readonly transport: Transport;
  readonly server: ServerRef;
  readonly clientInfo?: { readonly name: string; readonly version: string; readonly title?: string } | false;
  readonly ports?: Partial<PortRegistry>;
  readonly extensions?: readonly Extension[];
  readonly idGenerator?: IdGenerator;
  readonly supportedVersions?: readonly string[];
  readonly defaults?: {
    readonly timeoutMs?: number;
    readonly mrtr?: "auto" | "manual";
    readonly limits?: Partial<Limits>;
  };
  /** S1.1 additions: wire lifecycle policy and injection seams. */
  readonly lifecycle?: McpClientLifecycleOptions;
}

export interface McpClientLifecycleOptions {
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

export class McpClient {
  readonly server: ServerRef;
  private readonly extensions = new ExtensionRegistry();
  private readonly manager: RequestManager;
  private readonly wire: LifecycleTransport;
  private readonly hooks: LifecycleHooks;
  private readonly isReadOnly: (method: string) => boolean;
  private readonly eraCache: EraCache;
  private readonly lifecycleCtx: LifecycleContext;

  constructor(opts: McpClientOptions) {
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
    this.lifecycleCtx = {
      binding: opts.transport.binding,
      endpointOrCommand: opts.server.label ?? opts.server.key,
      supportedVersions: opts.supportedVersions ?? [SUPPORTED_PROTOCOL_VERSION],
    };
    // WIRE-META-3: clientInfo is sent by default; `false` disables it; an IdentityPort wins over the library default.
    const clientInfo =
      opts.clientInfo !== undefined ? opts.clientInfo : opts.ports?.identity ? undefined : LIBRARY_CLIENT_INFO;
    if (opts.extensions) {
      for (const ext of opts.extensions) {
        this.extensions.register(ext);
      }
    }
    this.manager = new RequestManager({
      transport: this.wire,
      ...(opts.ports ? { ports: opts.ports } : {}),
      ...(clientInfo !== undefined ? { clientInfo } : {}),
      extensions: this.extensions,
      ...(opts.idGenerator ? { idGenerator: opts.idGenerator } : {}),
      ...(opts.supportedVersions ? { supportedVersions: opts.supportedVersions } : {}),
      ...(opts.defaults?.limits || opts.defaults?.timeoutMs
        ? {
            limits: {
              ...opts.defaults?.limits,
              ...(opts.defaults?.timeoutMs !== undefined ? { defaultTimeoutMs: opts.defaults.timeoutMs } : {}),
            },
          }
        : {}),
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
    const mapped = Promise.resolve(handle).then((o) => this.hooks.mapOutcome(o, this.lifecycleCtx));
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
      return this.hooks.classifyDiscover(outcome, this.lifecycleCtx);
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
