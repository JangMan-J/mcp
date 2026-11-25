import {
  NotificationQueue,
  systemClock,
  type Clock,
  type JsonRpcNotification,
  type RequestId,
  type StreamHandle,
} from "@mcp/core";
import { object, type Obj, type Diagnostic } from "./common.js";
import type { ResultCache } from "./cache.js";
export const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
export interface ListenFilter {
  tools?: boolean;
  prompts?: boolean;
  resources?: boolean;
  resourceUris?: readonly string[];
}
export interface GrantedFilter {
  toolsListChanged?: true;
  promptsListChanged?: true;
  resourcesListChanged?: true;
  resourceSubscriptions?: string[];
}
export interface Acknowledgment {
  granted: GrantedFilter;
  unsupported: GrantedFilter;
}
export interface ChangeEvent {
  method: string;
  params: Obj;
}
export interface Subscription {
  readonly id: RequestId;
  readonly state: "opening" | "active" | "reconnecting" | "ended";
  readonly reason?: string | undefined;
  readonly acknowledged: Promise<Acknowledgment>;
  readonly events: AsyncIterable<ChangeEvent>;
  close(): void;
}
/** open allocates a fresh request id, applies auth + normal meta and returns a live stream.
 * StreamHandle.close implements binding-specific cancellation. No ordinary request timeout. */
export interface ListenOptions {
  open: (
    method: "subscriptions/listen",
    params: { notifications: GrantedFilter },
  ) => StreamHandle;
  binding: "stdio" | "http" | "streamable-http";
  serverRef: string;
  cache?: ResultCache;
  capabilities?: Obj;
  clock?: Clock;
  random?: () => number;
  ackTimeoutMs?: number;
  listenIdleMs?: number;
  maxResourceUris?: number;
  /** Local cap on concurrent (non-ended) listen streams (LIM-SUB-1). Default 8. */
  maxListenStreams?: number;
  maxAttemptsPerMinute?: number;
  reconnect?: "never" | "on-abrupt";
  diagnostic?: Diagnostic;
}
const kinds = ["tools", "prompts", "resources"] as const;
const key = (k: (typeof kinds)[number]) => `${k}ListChanged` as const;
function subset(requested: GrantedFilter, offered: Obj, accepted: boolean) {
  const f: GrantedFilter = {};
  for (const k of kinds) {
    const n = key(k);
    if (requested[n] && (offered[n] === true) === accepted) f[n] = true;
  }
  const uris = requested.resourceSubscriptions?.filter(
    (u) =>
      (Array.isArray(offered.resourceSubscriptions) &&
        offered.resourceSubscriptions.includes(u)) === accepted,
  );
  if (uris?.length) f.resourceSubscriptions = uris;
  return f;
}
function grantedMethod(n: string, params: Obj, f: GrantedFilter) {
  return (
    kinds.some((k) => n === `notifications/${k}/list_changed` && f[key(k)]) ||
    (n === "notifications/resources/updated" &&
      typeof params.uri === "string" &&
      f.resourceSubscriptions?.includes(params.uri))
  );
}
class Listener implements Subscription {
  state: Subscription["state"] = "opening";
  reason: string | undefined;
  readonly events = new NotificationQueue<ChangeEvent>();
  private stream!: StreamHandle;
  private resolve!: (value: Acknowledgment) => void;
  private reject!: (error: Error) => void;
  acknowledged = new Promise<Acknowledgment>((r, j) => {
    this.resolve = r;
    this.reject = j;
  });
  private cancelTimer: () => void = () => {};
  private grant: GrantedFilter | undefined;
  private previous: GrantedFilter | undefined;
  private retries = 0;
  private attempts: number[] = [];
  private clock: Clock;
  constructor(
    private owner: SubscriptionManager,
    private opt: ListenOptions,
    private filter: GrantedFilter,
  ) {
    this.clock = opt.clock ?? systemClock;
    this.acknowledged.catch(() => {});
    this.start();
  }
  get id() {
    return this.stream.id;
  }
  private timer(ms: number, fn: () => void) {
    this.cancelTimer();
    this.cancelTimer = this.clock.setTimeout(fn, ms);
  }
  private watchdog() {
    this.cancelTimer();
    if (this.opt.listenIdleMs)
      this.timer(this.opt.listenIdleMs, () => {
        const stream = this.stream;
        this.abrupt();
        stream.close();
      });
  }
  start() {
    if (this.state === "ended") return;
    this.cancelTimer();
    this.state = "opening";
    this.grant = undefined;
    const stream = this.opt.open("subscriptions/listen", {
      notifications: structuredClone(this.filter),
    });
    this.stream = stream;
    this.owner.register(this);
    this.timer(this.opt.ackTimeoutMs ?? 10_000, () => {
      this.end("transport-failure/no-ack");
      stream.close();
    });
    const pump = (async () => {
      for await (const n of stream) {
        if (stream !== this.stream || this.state === "ended") break;
        this.owner.route(
          n,
          this.opt.binding === "stdio" ? undefined : stream.id,
        );
      }
    })();
    void pump.catch(() => {
      if (this.stream === stream) this.abrupt();
    });
    void stream.done
      .then(async (out) => {
        if (out.kind === "ok") await pump;
        if (
          stream !== this.stream ||
          this.state === "ended" ||
          this.state === "reconnecting"
        )
          return;
        if (out.kind === "ok") {
          if (
            this.grant &&
            object(out.value) &&
            out.value.resultType === "complete" &&
            object(out.value._meta) &&
            out.value._meta[SUBSCRIPTION_ID] === this.id
          )
            this.end("server-graceful");
          else this.end("protocol-violation");
        } else if (
          out.kind === "transport-failure" &&
          [401, 403].includes(out.failure.status ?? 0)
        )
          this.end("authorization");
        else this.abrupt();
      })
      .catch(() => {
        if (stream === this.stream) this.abrupt();
      });
  }
  private resync(f: GrantedFilter) {
    const c = this.opt.cache,
      s = this.opt.serverRef;
    c?.invalidate(s, "server/discover");
    for (const k of kinds) if (f[key(k)]) c?.invalidate(s, `${k}/list`);
    for (const u of f.resourceSubscriptions ?? [])
      c?.invalidate(s, "resources/read", u);
  }
  receive(n: JsonRpcNotification) {
    const p = object(n.params) ? n.params : {};
    if (n.method === "notifications/cancelled") {
      this.end("server-cancelled");
      return;
    }
    if (
      !this.grant &&
      n.method === "notifications/subscriptions/acknowledged" &&
      object(p.notifications)
    ) {
      this.grant = subset(this.filter, p.notifications, true);
      this.state = "active";
      this.watchdog();
      this.resolve({
        granted: structuredClone(this.grant),
        unsupported: subset(this.filter, p.notifications, false),
      });
      if (this.retries) {
        this.resync(this.previous ?? this.filter);
        this.resync(this.grant);
        this.events.push({ method: "resync-needed", params: {} });
      }
      return;
    }
    if (!this.grant || !grantedMethod(n.method, p, this.grant)) {
      this.opt.diagnostic?.(
        this.grant ? "ungranted-notification" : "before-ack",
      );
      return;
    }
    this.watchdog();
    this.opt.cache?.notification(this.opt.serverRef, n.method, p);
    this.events.push({ method: n.method, params: p });
  }
  private abrupt() {
    if (this.state === "ended" || this.state === "reconnecting") return;
    this.cancelTimer();
    this.owner.unregister(this);
    if (this.grant) this.previous = this.grant;
    if (this.opt.binding !== "stdio" && this.opt.reconnect === "never") {
      this.end("transport");
      return;
    }
    this.state = "reconnecting";
    this.reason = "transport";
    this.retries++;
    if (this.opt.binding !== "stdio") {
      const now = this.clock.now();
      this.attempts = this.attempts.filter((t) => t > now - 60_000);
      const cap = Math.max(1, this.opt.maxAttemptsPerMinute ?? 12);
      const wait =
        this.attempts.length >= cap
          ? Math.max(0, this.attempts[0]! + 60_000 - now)
          : 0;
      this.timer(
        Math.max(
          wait,
          (this.opt.random ?? Math.random)() *
            Math.min(60_000, 1000 * 2 ** (this.retries - 1)),
        ),
        () => {
          this.attempts.push(this.clock.now());
          this.restart();
        },
      );
    }
  }
  restart() {
    if (this.state !== "reconnecting") return;
    this.reason = undefined;
    try {
      this.start();
    } catch {
      this.abrupt();
    }
  }
  end(reason: string) {
    if (this.state === "ended") return;
    this.cancelTimer();
    this.owner.remove(this);
    this.state = "ended";
    this.reason = reason;
    this.reject(new Error(reason));
    this.events.close();
  }
  close() {
    if (this.state === "ended") return;
    const live = this.state !== "reconnecting";
    this.end("client");
    if (live) this.stream.close();
  }
}
export class SubscriptionManager {
  private readonly listeners = new Set<Listener>();
  private readonly active = new Map<RequestId, Listener>();
  constructor(private readonly options: ListenOptions) {}
  register(l: Listener) {
    this.listeners.add(l);
    this.active.set(l.id, l);
  }
  unregister(l: Listener) {
    this.active.delete(l.id);
  }
  remove(l: Listener) {
    this.unregister(l);
    this.listeners.delete(l);
  }
  listen(f: ListenFilter): Subscription {
    const caps = this.options.capabilities,
      filter: GrantedFilter = {};
    for (const k of kinds) {
      const c = caps?.[k];
      if (f[k] && (!caps || (object(c) && c.listChanged === true)))
        filter[key(k)] = true;
    }
    const c = caps?.resources;
    if (
      f.resourceUris?.length &&
      (!caps || (object(c) && c.subscribe === true))
    ) {
      if (f.resourceUris.length > (this.options.maxResourceUris ?? 1000))
        throw RangeError("too many subscription URIs");
      filter.resourceSubscriptions = [...new Set(f.resourceUris)];
    }
    if (this.listeners.size >= (this.options.maxListenStreams ?? 8))
      throw RangeError("too many concurrent listen streams");
    return new Listener(this, this.options, filter);
  }
  route(n: JsonRpcNotification, streamId?: RequestId) {
    const p = n.params;
    const id = object(p)
      ? n.method === "notifications/cancelled"
        ? p.requestId
        : object(p._meta)
          ? p._meta[SUBSCRIPTION_ID]
          : undefined
      : undefined;
    const l =
      typeof id === "number" || typeof id === "string"
        ? this.active.get(id)
        : undefined;
    if (!l || (streamId !== undefined && id !== streamId)) {
      this.options.diagnostic?.("subscription-id-mismatch");
      return;
    }
    l.receive(n);
  }
  async change(old: Subscription, f: ListenFilter) {
    const next = this.listen(f);
    await next.acknowledged;
    old.close();
    return next;
  }
  reconnected() {
    this.options.cache?.invalidate(this.options.serverRef, "server/discover");
    if (this.options.binding === "stdio")
      for (const l of this.listeners) l.restart();
  }
}
