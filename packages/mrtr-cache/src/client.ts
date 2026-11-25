import type {
  AuthProvider,
  Extension,
  ExtensionCapabilities,
  RequestOptions,
  TelemetrySpan,
} from "@mcp/core";
import { MrtrSession, type MrtrOptions } from "./mrtr.js";
import { ResultCache, type CacheOptions } from "./cache.js";
import {
  elicitationCapabilities,
  type ElicitationOptions,
} from "./elicitation.js";
import {
  SubscriptionManager,
  type ListenOptions,
  type ListenFilter,
} from "./subscriptions.js";
import type { RequestFn, Obj } from "./common.js";

/** Register on the wire client instead of its generic consent port when using separate form/url ports. */
export function elicitationExtension(options: ElicitationOptions): Extension {
  return {
    id: "elicitation",
    capabilities: (working) =>
      working
        ? (elicitationCapabilities(options) as ExtensionCapabilities)
        : {},
  };
}
export interface StatefulClientOptions extends MrtrOptions {
  request: RequestFn;
  serverRef: string;
  auth?: Pick<AuthProvider, "contextId">;
  cache?: CacheOptions;
  subscriptions?: Omit<ListenOptions, "serverRef" | "cache">;
  activeSpan?: () => TelemetrySpan | undefined;
}
export class StatefulClient {
  readonly cache: ResultCache;
  readonly subscriptions?: SubscriptionManager;
  readonly mrtr: MrtrSession;
  constructor(options: StatefulClientOptions) {
    this.cache = new ResultCache(options.cache);
    if (options.subscriptions)
      this.subscriptions = new SubscriptionManager({
        ...options.subscriptions,
        serverRef: options.serverRef,
        cache: this.cache,
      });
    this.mrtr = new MrtrSession(async (method, params, opts) => {
      const outcome = await this.cache.run(
        {
          serverRef: options.serverRef,
          authContextId: options.auth?.contextId() ?? "anonymous",
        },
        method,
        params,
        opts,
        options.request,
      );
      if (outcome.meta.cache)
        options.activeSpan?.()?.setAttribute("cache", outcome.meta.cache);
      return outcome;
    }, options);
  }
  request(method: string, params: Obj = {}, opts: RequestOptions = {}) {
    return this.mrtr.run(method, params, opts);
  }
  listen(filter: ListenFilter) {
    if (!this.subscriptions) throw Error("no listen stream port configured");
    return this.subscriptions.listen(filter);
  }
}
