import { ExtensionRegistry, type Disposable, type Extension } from "./extension.js";
import { SUPPORTED_PROTOCOL_VERSION, type IdGenerator, type JsonRpcNotification, type RequestId } from "./jsonrpc.js";
import {
  defaultLifecycleHooks,
  DISCOVER_PROBE_TIMEOUT_MS,
  EraCache,
  type EraState,
  type LifecycleContext,
  type LifecycleHooks,
  type LifecyclePolicyOptions,
  type ProbeOptions,
} from "./lifecycle.js";
import type { PortRegistry, Transport } from "./ports.js";
import {
  RequestManager,
  type ClientRequest,
  type Limits,
  type NotifyOptions,
  type RequestOptions,
  type StreamHandle,
} from "./request.js";
import { NotificationQueue } from "./progress.js";
import type { DiscoverResult } from "./schema/index.js";

export * as McpSchema from "./schema/index.js";
export type { DiscoverResult } from "./schema/index.js";
export * from "./jsonrpc.js";
export * from "./outcome.js";
export * from "./ports.js";
export * from "./telemetry.js";
export * from "./auth-types.js";
export * from "./bearer-challenge.js";
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
  readonly lifecycle?: LifecyclePolicyOptions;
}

export class McpClient {
  readonly server: ServerRef;
  private readonly transport: Transport;
  private readonly extensions = new ExtensionRegistry();
  private readonly manager: RequestManager;
  private readonly eraCache: EraCache;
  private readonly hooks: LifecycleHooks;
  private readonly ctx: LifecycleContext;

  constructor(opts: McpClientOptions) {
    this.server = opts.server;
    this.transport = opts.transport;
    const lc = opts.lifecycle ?? {};
    this.hooks = { ...defaultLifecycleHooks, ...lc.hooks };
    this.eraCache = lc.eraCache ?? new EraCache();
    this.ctx = {
      binding: opts.transport.binding,
      endpointOrCommand: opts.server.label ?? opts.server.key,
      supportedVersions: opts.supportedVersions ?? [SUPPORTED_PROTOCOL_VERSION],
    };
    if (opts.extensions) {
      for (const ext of opts.extensions) {
        this.extensions.register(ext);
      }
    }
    this.manager = new RequestManager({
      transport: opts.transport,
      serverLabel: opts.server.label ?? opts.server.key,
      ...(opts.ports ? { ports: opts.ports } : {}),
      ...(opts.clientInfo !== undefined ? { clientInfo: opts.clientInfo } : {}),
      extensions: this.extensions,
      ...(opts.idGenerator ? { idGenerator: opts.idGenerator } : {}),
      ...(opts.supportedVersions ? { supportedVersions: opts.supportedVersions } : {}),
      ...(opts.lifecycle ? { lifecycle: opts.lifecycle } : {}),
      ...(opts.defaults?.limits || opts.defaults?.timeoutMs !== undefined
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
    return this.manager.request<T>(method, params, opts);
  }

  notify(
    method: string,
    params: Record<string, unknown> = {},
    opts?: NotifyOptions,
  ): Promise<void> {
    return this.manager.notify(method, params, opts);
  }

  /**
   * Open a long-lived request stream (subscriptions/listen, events/stream).
   * Uses the same per-request metadata, id allocation, and lifecycle handling
   * as request(); no default request timeout applies to streams.
   */
  openStream(
    method: string,
    params: Record<string, unknown> = {},
    opts: RequestOptions = {},
  ): StreamHandle {
    const req = this.manager.request<unknown>(method, params, {
      ...opts,
      stream: true,
      idempotent: opts.idempotent ?? true,
    });
    // Stdio routes subscription notifications to subscriptions/listen by default;
    // events/stream and other long-lived streams need an explicit listener.
    const transport = this.transport as Transport & {
      registerSubscription?: (id: RequestId, fn: (n: JsonRpcNotification) => void) => () => void;
    };
    const routed = typeof transport.registerSubscription === "function"
      ? new NotificationQueue<JsonRpcNotification>()
      : undefined;
    const detach = routed
      ? transport.registerSubscription!(req.id, (n) => routed.push(n))
      : undefined;
    const notifications = routed ?? req.notifications;
    const cleanup = () => {
      detach?.();
      routed?.close();
    };
    return {
      id: req.id,
      close: () => {
        cleanup();
        req.cancel();
      },
      done: Promise.resolve(req).finally(cleanup),
      [Symbol.asyncIterator]: () => notifications[Symbol.asyncIterator](),
    };
  }

  discover(opts?: RequestOptions): ClientRequest<DiscoverResult> {
    return this.manager.request<DiscoverResult>("server/discover", {}, { ...opts, idempotent: true });
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

  use(ext: Extension): Disposable {
    return this.extensions.register(ext);
  }

  async close(opts?: { readonly graceMs?: number }): Promise<void> {
    await this.manager.close(opts);
  }
}
