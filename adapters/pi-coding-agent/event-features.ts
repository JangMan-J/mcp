import type { ConsentPort } from "@mcp-client/core";
import {
  createEventsExtension,
  EVENTS_EXTENSION_ID,
  EventsClient,
  type EventsExtension,
  type EventsOptions,
  type Obj,
  type Occurrence,
  type PushMessage,
} from "@mcp-client/ext-events";
import type { LegacyServerConfig } from "./config.js";
import type { LiveMcpServerRuntime } from "./pi-extension.js";

export interface EventFeaturesHost {
  registerTool(def: Record<string, unknown>): void;
  registerCommand?(name: string, cmd: { description: string; handler(args: string, ctx: any): Promise<void> }): void;
  wake(server: string, reason: string): void;
  refreshTools(): void;
  getBranch(): readonly unknown[];
  appendEntry(type: string, data: unknown): void;
  readonly consent?: ConsentPort;
  readonly configDir: string;
}

/** Structural runtime extension for live Events push streams and shared EventsExtension instances. */
// ## YAGNI: local intersection until pi-extension.ts adds openEventsStream to LiveMcpServerRuntime.
export type EventsRuntime = LiveMcpServerRuntime & {
  readonly openEventsStream?: NonNullable<EventsOptions["openStream"]>;
  readonly eventsExtension?: EventsExtension;
};

/** Delivery preference and rule options for auto-subscribed events. */
export interface SubscribeRuleOptions {
  readonly enabled?: boolean;
  readonly arguments?: Obj;
  readonly delivery?: "push" | "poll" | "auto";
  readonly holdSettle?: boolean;
  readonly maxAgeMs?: number;
}
/** A subscribe rule: a glob over event names, optionally with fixed arguments and delivery options. */
export type SubscribeRule = string | ({ readonly name: string } & SubscribeRuleOptions);
export type SubscribeRules = readonly SubscribeRule[] | Readonly<Record<string, boolean | SubscribeRuleOptions>>;
// ## YAGNI: local intersection until config.ts exports its subscribe rule type directly.
export type EventsServerConfig = LegacyServerConfig & { readonly subscribe?: SubscribeRules };

export const EVENTS_ENTRY_TYPE = "mcp-client/events-state";
export const DEDUP_LIMIT = 256;
const QUEUE_LIMIT = 1000;
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 60_000;

/** Persisted per server: event name, accepted cursor, bounded recent eventIds. No arguments, data or credentials. */
export interface PersistedSub { readonly name: string; readonly cursor: string | null; readonly seen: readonly string[] }
export interface EventsEntry { readonly server: string; readonly subs: readonly PersistedSub[] }

export interface MatchedSubscribeRule {
  readonly name: string;
  readonly arguments: Obj;
  readonly delivery?: "push" | "poll" | "auto";
  readonly holdSettle?: boolean;
  readonly maxAgeMs?: number;
}

export function globToRegExp(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${src}$`);
}

function normalizeRules(rules: SubscribeRules | undefined): readonly ({ readonly name: string } & SubscribeRuleOptions)[] {
  if (!rules) return [];
  if (Array.isArray(rules)) {
    return rules
      .map((r) => (typeof r === "string" ? { name: r } : r))
      .filter((r) => r.enabled !== false);
  }
  const out: ({ readonly name: string } & SubscribeRuleOptions)[] = [];
  for (const [name, v] of Object.entries(rules)) {
    if (v === false) continue;
    if (v === true) { out.push({ name }); continue; }
    if (v && typeof v === "object" && v.enabled !== false) out.push({ ...v, name });
  }
  return out;
}

export function matchRules(names: readonly string[], rules: SubscribeRules | undefined): MatchedSubscribeRule[] {
  const out = new Map<string, MatchedSubscribeRule>();
  for (const r of normalizeRules(rules)) {
    const re = globToRegExp(r.name);
    for (const n of names) {
      if (re.test(n) && !out.has(n)) {
        out.set(n, {
          name: n,
          arguments: { ...(r.arguments ?? {}) },
          ...(r.delivery !== undefined ? { delivery: r.delivery } : {}),
          ...(r.holdSettle !== undefined ? { holdSettle: r.holdSettle } : {}),
          ...(r.maxAgeMs !== undefined ? { maxAgeMs: r.maxAgeMs } : {}),
        });
      }
    }
  }
  return [...out.values()];
}

/** Bounded insertion-ordered eventId set. */
export class Dedup {
  private readonly ids = new Set<string>();
  constructor(private readonly limit = DEDUP_LIMIT, init: readonly string[] = []) { for (const i of init) this.add(i); }
  has(id: string) { return this.ids.has(id); }
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    while (this.ids.size > this.limit) this.ids.delete(this.ids.values().next().value!);
    return true;
  }
  list(): string[] { return [...this.ids]; }
}

export function restoreEntry(branch: readonly unknown[], server: string): EventsEntry | undefined {
  let found: EventsEntry | undefined;
  for (const e of branch) {
    const x = e as { type?: unknown; customType?: unknown; data?: unknown };
    if ((x.type === EVENTS_ENTRY_TYPE || (x.type === "custom" && x.customType === EVENTS_ENTRY_TYPE)) && (x.data as EventsEntry | undefined)?.server === server) found = x.data as EventsEntry;
  }
  return found;
}

interface LocalSub {
  client: EventsClient;
  poll(): ReturnType<EventsClient["poll"]>;
  name: string;
  arguments: Obj;
  accepted: string | null;
  dedup: Dedup;
  delivery?: "push" | "poll" | "auto";
  holdSettle?: boolean;
  maxAgeMs?: number;
  push?: { close(): void } | undefined;
  timer?: ReturnType<typeof setTimeout> | undefined;
}
interface Queued { sub: LocalSub; event: Occurrence }

const text = (t: string, details?: unknown) => ({ content: [{ type: "text", text: t }], details });

function names(list: Obj): string[] {
  const ev = Array.isArray(list.events) ? list.events : [];
  return ev.map((e) => (e as Obj)?.name).filter((n): n is string => typeof n === "string");
}

async function listNames(ec: EventsClient): Promise<string[]> {
  const all: string[] = [];
  let page: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const list = await ec.list(page);
    all.push(...names(list));
    if (typeof list.nextCursor !== "string" || !list.nextCursor) return all;
    page = list.nextCursor;
    if (seen.has(page)) throw new Error("Repeated events/list cursor");
    seen.add(page);
  }
  throw new Error("Events discovery exceeded 20 pages");
}

function hasEventsCapability(caps: unknown): boolean {
  if (typeof caps !== "object" || caps === null || Array.isArray(caps)) return false;
  const exts = (caps as Obj).extensions;
  if (typeof exts !== "object" || exts === null || Array.isArray(exts)) return false;
  const ext = (exts as Obj)[EVENTS_EXTENSION_ID];
  if (typeof ext !== "object" || ext === null || Array.isArray(ext)) return false;
  const rev = (ext as Obj).revision;
  return rev === undefined || rev === "2026-07-28";
}

interface ServerEntry {
  ec: EventsClient;
  options: EventsOptions;
  subs: Set<LocalSub>;
  queue: Queued[];
  rt: LiveMcpServerRuntime;
  signal: AbortSignal;
  cleanup: () => void;
}

export function createEventFeatures(host: EventFeaturesHost) {
  const servers = new Map<string, ServerEntry>();
  let toolRegistered = false;

  const persist = (server: string) => {
    const s = servers.get(server);
    if (!s) return;
    const data: EventsEntry = { server, subs: [...s.subs.values()].map((x) => ({ name: x.name, cursor: x.accepted, seen: x.dedup.list() })) };
    host.appendEntry(EVENTS_ENTRY_TYPE, data);
  };

  const get = (server: unknown) => {
    const s = typeof server === "string" ? servers.get(server) : undefined;
    if (!s) throw new Error(`No events-capable server: ${String(server)}`);
    return s;
  };

  const enqueue = (server: string, sub: LocalSub, e: Occurrence) => {
    const s = servers.get(server);
    if (!s || !s.subs.has(sub) || sub.dedup.has(e.eventId)) return;
    if (sub.maxAgeMs !== undefined && sub.maxAgeMs > 0) {
      const ts = Date.parse(e.timestamp);
      if (Number.isFinite(ts) && Date.now() - ts > sub.maxAgeMs) return;
    }
    s.queue.push({ sub, event: e });
    if (s.queue.length > QUEUE_LIMIT) s.queue.shift();
    host.wake(server, `event ${e.name}`);
  };

  const clampPollMs = (ms: number) => Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Number.isFinite(ms) ? ms : MIN_POLL_MS));

  const subscribe = (
    server: string,
    name: string,
    args: Obj,
    restored?: PersistedSub,
    opts?: Pick<SubscribeRuleOptions, "delivery" | "holdSettle" | "maxAgeMs">,
  ) => {
    const s = get(server);
    for (const x of s.subs.values()) if (x.name === name && JSON.stringify(x.arguments) === JSON.stringify(args)) return x;
    // Scope the replay seed to this subscription, including retries before catch-up succeeds.
    let seed = restored?.cursor;
    const seeded = (params: Obj) => params.cursor === null && seed != null ? { ...params, cursor: seed } : params;
    const open = s.options.openStream;
    const client = new EventsClient({
      ...s.options,
      request: (m, p, o) => s.options.request(m, seeded(p), o),
      ...(open ? { openStream: (m, p, o) => open(m, seeded(p), o) } : {}),
    });
    const id = client.subscription(name, args);
    const sub: LocalSub = {
      client,
      async poll() {
        const result = await client.poll(id);
        seed = undefined;
        return result;
      },
      name,
      arguments: args,
      accepted: restored?.cursor ?? null,
      dedup: new Dedup(DEDUP_LIMIT, restored?.seen ?? []),
      ...(opts?.delivery !== undefined ? { delivery: opts.delivery } : {}),
      ...(opts?.holdSettle !== undefined ? { holdSettle: opts.holdSettle } : {}),
      ...(opts?.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
    };
    s.subs.add(sub);
    const isAlive = () => !s.rt.transportClosed.aborted && !s.signal.aborted && s.subs.has(sub);
    const catchUp = async (): Promise<number> => {
      let nextMs = MIN_POLL_MS;
      for (let i = 0; i < 20 && isAlive(); i++) {
        const r = await sub.poll();
        for (const e of r.events) enqueue(server, sub, e);
        nextMs = r.nextDelayMs;
        if (r.nextDelayMs > 0) break;
      }
      return clampPollMs(nextMs);
    };
    const schedulePoll = (delayMs: number) => {
      if (!isAlive()) return;
      if (sub.timer) clearTimeout(sub.timer);
      sub.timer = setTimeout(() => {
        sub.timer = undefined;
        if (!isAlive()) return;
        void catchUp()
          .then((ms) => schedulePoll(ms))
          .catch(() => schedulePoll(clampPollMs(delayMs * 2)));
      }, clampPollMs(delayMs));
      sub.timer.unref?.();
    };
    void catchUp().catch(() => MIN_POLL_MS).then((nextMs) => {
      if (!isAlive()) return;
      if (sub.delivery !== "poll") {
        try {
          const push = client.push(id, (m: PushMessage) => {
            if (m.type === "active") seed = undefined;
            if (m.type === "event") enqueue(server, sub, m.event);
            if (m.type === "terminated" || m.type === "error") {
              sub.push?.close();
              sub.push = undefined;
              schedulePoll(nextMs);
            }
          });
          // An open failure can be reported synchronously, before push() returns.
          if (!sub.timer) sub.push = push;
          return;
        } catch { /* no live stream port: fall through to bounded scheduled polling */ }
      }
      schedulePoll(nextMs);
    });
    return sub;
  };

  const unsubscribe = (server: string, name: string) => {
    const s = get(server);
    let n = 0;
    for (const x of s.subs) {
      if (x.name === name) {
        if (x.timer) { clearTimeout(x.timer); x.timer = undefined; }
        x.client.dispose();
        s.subs.delete(x);
        s.queue = s.queue.filter((q) => q.sub !== x);
        n++;
      }
    }
    return n;
  };

  /** Drain queued events; only now do cursors and eventIds become accepted and persisted. */
  const drain = async (server: string) => {
    const s = get(server);
    await Promise.all([...s.subs.values()].filter((x) => !x.push).map(async (x) => {
      const r = await x.poll().catch(() => undefined);
      for (const e of r?.events ?? []) enqueue(server, x, e);
    }));
    const out: Occurrence[] = [];
    for (const { sub, event } of s.queue.splice(0)) {
      if (!sub.dedup.add(event.eventId)) continue;
      out.push(event);
      if (event.cursor !== null) sub.accepted = event.cursor;
    }
    for (const x of s.subs.values()) {
      const c = x.client.subscriptions()[0]?.cursor;
      if (c !== undefined && c !== null && !s.queue.some((q) => q.sub === x)) x.accepted = c;
    }
    persist(server);
    return out;
  };

  const registerTool = () => {
    if (toolRegistered) return;
    toolRegistered = true;
    host.registerTool({
      name: "mcp_events",
      label: "MCP Events",
      description: "Discover, subscribe to and poll MCP server events.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["servers", "list", "subscribe", "unsubscribe", "subscriptions", "poll"] },
          server: { type: "string", description: "Server name" },
          name: { type: "string", description: "Event name (subscribe also accepts * and ? globs)" },
          arguments: { type: "object", description: "Event subscription arguments" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      execute: async (_id: string, p: { action: string; server?: string; name?: string; arguments?: Obj }) => {
        try {
          switch (p.action) {
            case "servers": { const l = [...servers.keys()]; return text(l.length ? l.join("\n") : "No events-capable servers.", { servers: l }); }
            case "list": { const r = await get(p.server).ec.list(); return text(JSON.stringify(r.events ?? [], null, 2), r); }
            case "subscribe": {
              if (!p.name || typeof p.name !== "string") throw new Error("name required");
              if (p.arguments !== undefined && (typeof p.arguments !== "object" || p.arguments === null || Array.isArray(p.arguments))) {
                throw new Error("arguments must be an object");
              }
              const s = get(p.server);
              const glob = /[*?]/.test(p.name);
              const matches = glob ? matchRules(await listNames(s.ec), [p.name]).map((m) => m.name) : [p.name];
              if (get(p.server) !== s) throw new Error("Server reconnected during discovery");
              if (!matches.length) throw new Error(`No events match ${p.name}`);
              const restored = restoreEntry(host.getBranch(), p.server!);
              for (const name of matches) subscribe(p.server!, name, p.arguments ?? {}, restored?.subs.find((r) => r.name === name));
              persist(p.server!);
              return text(`Subscribed to ${matches.join(", ")} on ${p.server}.`, glob ? { names: matches } : { name: p.name });
            }
            case "unsubscribe": {
              if (!p.name || typeof p.name !== "string") throw new Error("name required");
              const n = unsubscribe(p.server!, p.name); persist(p.server!);
              return text(`Removed ${n} subscription(s).`, { removed: n });
            }
            case "subscriptions": {
              const l = [...get(p.server).subs.values()].map((x) => ({ name: x.name, cursor: x.accepted }));
              return text(l.length ? l.map((x) => x.name).join("\n") : "No subscriptions.", { subscriptions: l });
            }
            case "poll": {
              const ev = await drain(p.server!);
              return text(ev.length ? ev.map((e) => `[${e.timestamp}] ${e.name} ${e.eventId}: ${JSON.stringify(e.data)}`).join("\n") : "No new events.", { events: ev });
            }
            default: throw new Error(`Unknown action: ${p.action}`);
          }
        } catch (e) {
          return { ...text(`mcp_events error: ${(e as Error).message}`), isError: true };
        }
      },
    });
    host.refreshTools();
  };

  return {
    connect(rt: LiveMcpServerRuntime, descriptor: LegacyServerConfig, signal: AbortSignal): void {
      const server = descriptor.name;
      const ert = rt as EventsRuntime;
      const ext = ert.eventsExtension ?? createEventsExtension({ enabled: true });
      const reqSignal = AbortSignal.any([signal, rt.transportClosed]);
      const options: EventsOptions = {
        extension: ext,
        peerCapabilities: () => rt.capabilities,
        request: (m, params, o) => rt.client.request(m, params, {
          ...o,
          signal: o?.signal ? AbortSignal.any([o.signal, reqSignal]) : reqSignal,
        }),
        ...(ert.openEventsStream ? { openStream: ert.openEventsStream } : {}),
      };
      const ec = new EventsClient(options);
      const cleanup = () => {
        rt.transportClosed.removeEventListener("abort", cleanup);
        signal.removeEventListener("abort", cleanup);
        const cur = servers.get(server);
        if (cur?.ec === ec) {
          for (const x of cur.subs) {
            x.client.dispose();
            if (x.timer) { clearTimeout(x.timer); x.timer = undefined; }
          }
          cur.subs.clear();
          cur.queue.length = 0;
          servers.delete(server);
        }
        ec.dispose();
      };
      if (rt.transportClosed.aborted || signal.aborted) {
        ec.dispose();
        return;
      }
      rt.transportClosed.addEventListener("abort", cleanup, { once: true });
      signal.addEventListener("abort", cleanup, { once: true });
      // Background: negotiate, then glob auto-subscribe; never block connect.
      void (async () => {
        const disc = await rt.ready(signal);
        if (disc.kind !== "ok" || rt.transportClosed.aborted || signal.aborted) return;
        if (ext.health() !== "working" || !hasEventsCapability(rt.capabilities)) return;
        servers.get(server)?.cleanup();
        servers.set(server, { ec, options, subs: new Set(), queue: [], rt, signal, cleanup });
        registerTool();
        const rules = (descriptor as EventsServerConfig).subscribe;
        const hasRules = Array.isArray(rules) ? rules.length > 0 : Boolean(rules && Object.keys(rules).length > 0);
        const restored = restoreEntry(host.getBranch(), server);
        for (const r of restored?.subs ?? []) {
          const rule = matchRules([r.name], rules)[0];
          if (rule) subscribe(server, r.name, rule.arguments, r, rule);
        }
        if (hasRules) {
          const allNames = await listNames(ec);
          if (servers.get(server)?.ec !== ec) return;
          for (const m of matchRules(allNames, rules)) subscribe(server, m.name, m.arguments, restored?.subs.find((x) => x.name === m.name), m);
        }
      })().catch(() => {});
    },
  };
}
