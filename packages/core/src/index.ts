import { ExtensionRegistry, type Disposable, type Extension } from "./extension.js";
import type { IdGenerator } from "./jsonrpc.js";
import type { PortRegistry, Transport } from "./ports.js";
import { RequestManager, type ClientRequest, type Limits, type RequestOptions } from "./request.js";
import type { DiscoverResult } from "./schema/index.js";

export * as McpSchema from "./schema/index.js";
export type { DiscoverResult } from "./schema/index.js";
export * from "./jsonrpc.js";
export * from "./outcome.js";
export * from "./ports.js";
export * from "./telemetry.js";
export * from "./auth-types.js";
export * from "./extension.js";
export * from "./request.js";

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
}

export class McpClient {
  readonly server: ServerRef;
  private readonly extensions = new ExtensionRegistry();
  private readonly manager: RequestManager;

  constructor(opts: McpClientOptions) {
    this.server = opts.server;
    if (opts.extensions) {
      for (const ext of opts.extensions) {
        this.extensions.register(ext);
      }
    }
    this.manager = new RequestManager({
      transport: opts.transport,
      ...(opts.ports ? { ports: opts.ports } : {}),
      ...(opts.clientInfo !== undefined ? { clientInfo: opts.clientInfo } : {}),
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
    return this.manager.request<T>(method, params, opts);
  }

  discover(opts?: RequestOptions): ClientRequest<DiscoverResult> {
    return this.manager.request<DiscoverResult>("server/discover", {}, { ...opts, idempotent: true });
  }

  use(ext: Extension): Disposable {
    return this.extensions.register(ext);
  }

  async close(opts?: { readonly graceMs?: number }): Promise<void> {
    await this.manager.close(opts);
  }
}
