import {
  systemClock,
  type Clock,
  type ClientRequest,
  type Extension,
  type ExtensionCapabilities,
  type RequestOptions,
  type StreamHandle,
} from "@mcp/core";
import { object, cursor, type Obj, type Occurrence } from "./model.js";
import { watchStream, type PushMessage } from "./push.js";
export type { PushMessage } from "./push.js";
export type { Obj, Occurrence } from "./model.js";
export { openEventsStream } from "./stream.js";

export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";
export class EventsExtension implements Extension {
  readonly id = EVENTS_EXTENSION_ID;
  constructor(
    private readonly opts: { enabled?: boolean; healthy?: boolean } = {},
  ) {}
  health() {
    return this.opts.enabled === true && this.opts.healthy !== false
      ? "working"
      : "unavailable";
  }
  settings() {
    return this.health() === "working" ? {} : undefined;
  }
  capabilities(isWorking = true): ExtensionCapabilities {
    return isWorking && this.settings()
      ? { extensions: { [this.id]: {} } }
      : {};
  }
}
export const createEventsExtension = (opts?: {
  enabled?: boolean;
  healthy?: boolean;
}) => new EventsExtension(opts);
export interface WebhookEndpointPort {
  readonly url: string;
  readonly secret: string;
  isReady(): boolean;
}
export interface EventsOptions {
  extension: EventsExtension;
  peerCapabilities(): unknown;
  request(
    method: string,
    params: Obj,
    options: RequestOptions,
  ): ClientRequest<Obj>;
  openStream?(
    method: "events/stream",
    params: Obj,
    options: RequestOptions,
  ): StreamHandle;
  clock?: Clock;
  jitterMs?: () => number;
  enableWebhook?: boolean;
  endpoint?: WebhookEndpointPort;
  onRefreshError?: (error: unknown) => void;
}
interface Subscription {
  name: string;
  args: Obj;
  cursor: string | null;
  seen: Set<string>;
  stop?: () => void;
  refresh?: () => void;
  generation: number;
  url?: string;
}
function occurrence(s: Subscription, p: unknown): Occurrence | undefined {
  if (
    !object(p) ||
    typeof p.eventId !== "string" ||
    p.name !== s.name ||
    typeof p.timestamp !== "string" ||
    !Object.hasOwn(p, "data")
  )
    throw new Error("Invalid Events occurrence");
  const e = {
    eventId: p.eventId,
    name: s.name,
    timestamp: p.timestamp,
    data: p.data,
    cursor: cursor(p.cursor),
  };
  if (s.seen.has(e.eventId)) return;
  s.seen.add(e.eventId);
  return e;
}
export class EventsClient {
  readonly deliverySemantics = "at-least-once" as const;
  private readonly subs = new Map<number, Subscription>();
  private seq = 0;
  private disposed = false;
  private readonly clock: Clock;
  constructor(private readonly opts: EventsOptions) {
    this.clock = opts.clock ?? systemClock;
  }
  private capability() {
    const caps = this.opts.peerCapabilities();
    const ext =
      object(caps) &&
      object(caps.extensions) &&
      caps.extensions[EVENTS_EXTENSION_ID];
    return !this.disposed &&
      this.opts.extension.health() === "working" &&
      object(ext) &&
      (ext.revision === undefined || ext.revision === "2026-07-28")
      ? ext
      : undefined;
  }
  private gate() {
    if (!this.capability()) throw new Error("Events unavailable");
  }
  expectsListChanged() {
    return this.capability()?.listChanged === true;
  }
  private async rpc(method: string, params: Obj) {
    this.gate();
    const out = await this.opts.request(
      method,
      params,
      typeof params.name === "string"
        ? { headersHint: { name: params.name } }
        : {},
    );
    if (out.kind !== "ok")
      throw new Error(`Events request failed: ${out.kind}`, { cause: out });
    return out.value;
  }
  list(page?: string) {
    return this.rpc("events/list", page === undefined ? {} : { cursor: page });
  }
  subscription(name: string, args: Obj = {}) {
    if (this.disposed) throw new Error("Events client disposed");
    const id = ++this.seq;
    this.subs.set(id, {
      name,
      args: structuredClone(args),
      cursor: null,
      seen: new Set(),
      generation: 0,
    });
    return id;
  }
  subscriptions() {
    return Array.from(this.subs, ([id, s]) => ({
      id,
      name: s.name,
      cursor: s.cursor,
    }));
  }
  private state(id: number) {
    const s = this.subs.get(id);
    if (!s) throw new Error("Unknown local subscription");
    return s;
  }
  private params(s: Subscription) {
    return {
      name: s.name,
      arguments: structuredClone(s.args),
      cursor: s.cursor,
    };
  }
  async poll(id: number) {
    const s = this.state(id),
      r = await this.rpc("events/poll", this.params(s));
    if (!Array.isArray(r.events)) throw new Error("Invalid Events poll result");
    const events = r.events
      .map((p) => occurrence(s, p))
      .filter((e) => e !== undefined);
    s.cursor = cursor(r.cursor);
    return {
      events,
      cursor: s.cursor,
      truncated: r.truncated === true,
      gap: r.truncated === true,
      nextDelayMs:
        r.hasMore === true
          ? 0
          : Math.max(
              1000,
              typeof r.nextPollMs === "number" ? r.nextPollMs : 1000,
            ),
    };
  }
  push(id: number, deliver: (message: PushMessage) => void) {
    this.gate();
    const s = this.state(id),
      open = this.opts.openStream;
    if (!open) throw new Error("Live Events stream port required");
    s.stop?.();
    const stop = watchStream(
      () => {
        this.gate();
        return open("events/stream", this.params(s), {
          headersHint: { name: s.name },
        });
      },
      this.clock,
      this.opts.jitterMs ?? (() => 50 + Math.floor(Math.random() * 200)),
      (p) => {
        s.cursor = cursor(p);
      },
      (p) => occurrence(s, p),
      deliver,
    );
    s.stop = stop;
    return { close: stop };
  }
  private endpoint() {
    const ep = this.opts.endpoint;
    if (this.opts.enableWebhook !== true || !ep?.isReady())
      throw new Error("Webhook unavailable");
    if (
      !ep.url.startsWith("https://") ||
      new URL(ep.url).protocol !== "https:" ||
      !/^whsec_(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(
        ep.secret,
      )
    )
      throw new Error("Invalid webhook endpoint");
    return ep;
  }
  async subscribe(id: number) {
    const ep = this.endpoint(),
      s = this.state(id);
    if (s.url && s.url !== ep.url) throw new Error("Webhook identity changed");
    const generation = ++s.generation;
    s.refresh?.();
    const r = await this.rpc("events/subscribe", {
      ...this.params(s),
      delivery: { url: ep.url, secret: ep.secret },
    });
    if (s.generation === generation) {
      s.url = ep.url;
      s.cursor = cursor(r.cursor);
      if (r.refreshBefore != null) {
        const remaining =
          Date.parse(String(r.refreshBefore)) - this.clock.now();
        if (!(remaining > 0))
          throw new Error("Invalid webhook refresh deadline");
        s.refresh = this.clock.setTimeout(
          () => {
            void this.subscribe(id).catch((e) => this.opts.onRefreshError?.(e));
          },
          Math.min(2 ** 31 - 1, Math.floor(remaining * 0.8)),
        );
      }
    }
    return {
      ...r,
      cursor: cursor(r.cursor),
      gap: r.truncated === true,
      truncated: r.truncated === true,
    };
  }
  async unsubscribe(id: number) {
    const s = this.state(id),
      ep = this.endpoint();
    ++s.generation;
    s.refresh?.();
    await this.rpc("events/unsubscribe", {
      name: s.name,
      arguments: structuredClone(s.args),
      delivery: { url: s.url ?? ep.url },
    });
    this.forget(id);
  }
  forget(id: number) {
    const s = this.state(id);
    ++s.generation;
    s.refresh?.();
    s.stop?.();
    this.subs.delete(id);
  }
  dispose() {
    this.disposed = true;
    for (const id of this.subs.keys()) this.forget(id);
  }
}
