import { createHash } from 'node:crypto';
import {
  EventsClient, createEventsExtension, EVENTS_EXTENSION_ID,
  type EventsOptions, type Obj, type Occurrence, type PushMessage,
} from '@mcp-client/ext-events';
import { ConversationEvents } from './events.js';
import type { DurableFeature, DurableFeatureContext } from './core-features.js';

export type SubscribeRuleOptions = {
  readonly enabled?: boolean;
  readonly arguments?: Obj;
  readonly delivery?: 'push' | 'poll' | 'auto';
  readonly holdSettle?: boolean;
  readonly maxAgeMs?: number;
};
export type SubscribeRule = string | ({ readonly name: string } & SubscribeRuleOptions);
export type SubscribeRules = readonly SubscribeRule[] | Readonly<Record<string, boolean | SubscribeRuleOptions>>;
export interface MatchedSubscribeRule extends SubscribeRuleOptions { readonly name: string; readonly arguments: Obj }

const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 60_000;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const clampPollMs = (ms: number) => Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Number.isFinite(ms) ? ms : MIN_POLL_MS));

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}
function normalizeRules(rules: SubscribeRules | undefined): MatchedSubscribeRule[] {
  if (!rules) return [];
  if (Array.isArray(rules)) return rules.map(r => typeof r === 'string' ? { name: r, arguments: {} } : { arguments: {}, ...r })
    .filter(r => r.enabled !== false);
  const out: MatchedSubscribeRule[] = [];
  for (const [name, rule] of Object.entries(rules)) {
    if (rule === false) continue;
    out.push(rule === true ? { name, arguments: {} } : { ...rule, name, arguments: { ...(rule.arguments ?? {}) } });
  }
  return out.filter(r => r.enabled !== false);
}
export function matchRules(names: readonly string[], rules: SubscribeRules | undefined): MatchedSubscribeRule[] {
  const matched = new Map<string, MatchedSubscribeRule>();
  for (const rule of normalizeRules(rules)) {
    const re = globToRegExp(rule.name);
    for (const name of names) if (re.test(name) && !matched.has(name)) matched.set(name, {
      ...rule, name, arguments: { ...(rule.arguments ?? {}) },
    });
  }
  return [...matched.values()];
}
function hasEventsCapability(caps: unknown): boolean {
  if (!isObj(caps) || !isObj(caps.extensions)) return false;
  const ext = caps.extensions[EVENTS_EXTENSION_ID];
  return isObj(ext) && (ext.revision === undefined || ext.revision === '2026-07-28');
}
function eventNames(list: Obj): string[] {
  return (Array.isArray(list.events) ? list.events : []).map(e => isObj(e) ? e.name : undefined)
    .filter((name): name is string => typeof name === 'string');
}
async function listNames(client: EventsClient): Promise<string[]> {
  const names: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await client.list(cursor);
    names.push(...eventNames(result));
    if (typeof result.nextCursor !== 'string' || !result.nextCursor) return names;
    if (seen.has(result.nextCursor)) throw new Error('Repeated events/list cursor');
    seen.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw new Error('Events discovery exceeded 20 pages');
}
function subscriptionId(server: string, name: string, args: Obj): string {
  return createHash('sha256').update(JSON.stringify([server, name, args])).digest('hex');
}

type StoredSub = { subscription: string; name: string; arguments: string; options: string | null };
type LocalSub = {
  readonly id: string;
  readonly name: string;
  readonly arguments: Obj;
  readonly options: SubscribeRuleOptions;
  readonly client: EventsClient;
  readonly subscription: number;
  accepted: string | null;
  push?: { close(): void };
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
};

/** Events push/poll, durable event dedupe/cursors, and automatic glob subscriptions. */
export async function createStreamFeatures(ctx: DurableFeatureContext): Promise<DurableFeature> {
  const { runtime: rt } = ctx;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, rt.transportClosed]);
  const conversation = new ConversationEvents(ctx.db);
  ctx.db.exec(`CREATE TABLE IF NOT EXISTS durable_event_subscriptions (
    subscription TEXT PRIMARY KEY, server TEXT NOT NULL, name TEXT NOT NULL,
    arguments TEXT NOT NULL, options TEXT
  )`);
  const discovered = await rt.ready();
  const capable = discovered.kind === 'ok' && hasEventsCapability(rt.capabilities);
  const extension = rt.eventsExtension ?? createEventsExtension({ enabled: true });
  const requestSignal = (options: { signal?: AbortSignal } = {}) => ({
    ...options, signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
  });
  const options: EventsOptions = {
    extension,
    peerCapabilities: () => rt.capabilities,
    request: (method, params, opts) => rt.client.request(method, params, requestSignal(opts)),
    ...(rt.openEventsStream ? { openStream: (method, params, opts) => rt.openEventsStream(method, params, requestSignal(opts)) } : {}),
  };
  const subs = new Set<LocalSub>();
  const queued: { sub: LocalSub; event: Occurrence }[] = [];

  const persist = (sub: LocalSub) => ctx.db.prepare(`INSERT INTO durable_event_subscriptions
    (subscription, server, name, arguments, options) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(subscription) DO UPDATE SET arguments = excluded.arguments, options = excluded.options`)
    .run(sub.id, ctx.id, sub.name, JSON.stringify(sub.arguments), JSON.stringify(sub.options));
  const restoredRows = () => ctx.db.prepare('SELECT subscription, name, arguments, options FROM durable_event_subscriptions WHERE server = ? ORDER BY rowid')
    .all(ctx.id) as unknown as StoredSub[];

  const alive = (sub: LocalSub) => !signal.aborted && !sub.closed && subs.has(sub);
  const enqueue = (sub: LocalSub, event: Occurrence) => {
    if (!alive(sub) || event.name !== sub.name) return;
    if (sub.options.maxAgeMs !== undefined && sub.options.maxAgeMs > 0) {
      const timestamp = Date.parse(event.timestamp);
      if (Number.isFinite(timestamp) && Date.now() - timestamp > sub.options.maxAgeMs) return;
    }
    const seen = ctx.db.prepare('SELECT 1 AS seen FROM conversation_events WHERE subscription = ? AND event_id = ?').get(sub.id, event.eventId);
    if (seen) return;
    // Commit before delivery/wake. A restart may redeliver, but cannot skip the event.
    conversation.deliver(sub.id, event);
    if (event.cursor !== null) sub.accepted = event.cursor;
    queued.push({ sub, event });
    try { void Promise.resolve(ctx.options.deliver?.({ ...event })).catch(() => {}); } catch { /* delivery is best effort after commit */ }
    try { void Promise.resolve(ctx.options.wake?.(ctx.id, `event ${event.name}`)).catch(() => {}); } catch { /* host wake is best effort */ }
  };

  const subscribe = (name: string, args: Obj, rule: SubscribeRuleOptions = {}): LocalSub => {
    const id = subscriptionId(ctx.id, name, args);
    const existing = [...subs].find(s => s.id === id);
    if (existing) return existing;
    let seed = conversation.cursor(id);
    const seeded = (params: Obj) => params.cursor === null && seed !== null ? { ...params, cursor: seed } : params;
    const client = new EventsClient({
      ...options,
      request: (method, params, opts) => options.request(method, seeded(params), opts),
      ...(options.openStream ? { openStream: (method, params, opts) => options.openStream!(method, seeded(params), opts) } : {}),
    });
    const subscription = client.subscription(name, args);
    const sub: LocalSub = { id, name, arguments: structuredClone(args), options: { ...rule }, client, subscription, accepted: seed, closed: false };
    subs.add(sub); persist(sub);

    const catchUp = async (): Promise<number> => {
      let delay = MIN_POLL_MS;
      for (let i = 0; i < 20 && alive(sub); i++) {
        const result = await client.poll(subscription);
        seed = null;
        for (const event of result.events) enqueue(sub, event);
        delay = result.nextDelayMs;
        if (delay > 0) break;
      }
      return clampPollMs(delay);
    };
    const schedule = (delay: number) => {
      if (!alive(sub)) return;
      if (sub.timer) clearTimeout(sub.timer);
      sub.timer = setTimeout(() => {
        delete sub.timer;
        if (!alive(sub)) return;
        void catchUp().then(schedule).catch(() => schedule(clampPollMs(delay * 2)));
      }, clampPollMs(delay));
      sub.timer.unref?.();
    };
    void catchUp().catch(() => MIN_POLL_MS).then(delay => {
      if (!alive(sub)) return;
      if (rule.delivery !== 'poll' && options.openStream) {
        try {
          const push = client.push(subscription, (message: PushMessage) => {
            if (message.type === 'active') seed = null;
            else if (message.type === 'event') enqueue(sub, message.event);
            else {
              sub.push?.close(); delete sub.push; schedule(delay);
            }
          });
          if (!sub.timer) sub.push = push;
          return;
        } catch { /* polling remains available */ }
      }
      schedule(delay);
    });
    return sub;
  };

  const remove = (sub: LocalSub) => {
    sub.closed = true;
    if (sub.timer) clearTimeout(sub.timer);
    sub.push?.close(); sub.client.dispose(); subs.delete(sub);
    for (let i = queued.length - 1; i >= 0; i--) if (queued[i]?.sub === sub) queued.splice(i, 1);
  };
  const checkServer = (args: Obj) => {
    if (args.server !== undefined && args.server !== ctx.id && args.server !== ctx.descriptor.name && !ctx.descriptor.aliases?.includes(String(args.server)))
      throw new Error(`Unknown MCP server: ${String(args.server)}`);
  };
  const requireEvents = () => { if (!capable) throw new Error(`No events-capable server: ${ctx.id}`); };

  if (capable && !signal.aborted) {
    // Manual and automatic subscriptions are both durable. Auto rules update options on restore.
    const rules = normalizeRules(ctx.descriptor.subscribe);
    for (const row of restoredRows()) {
      try {
        const args = JSON.parse(row.arguments) as Obj;
        const stored = row.options ? JSON.parse(row.options) as SubscribeRuleOptions : {};
        const rule = rules.find(r => globToRegExp(r.name).test(row.name));
        subscribe(row.name, args, rule ? { ...stored, ...rule } : stored);
      } catch { /* Ignore only malformed legacy rows; valid rows remain available for repair. */ }
    }
    if (rules.length) {
      const names = await listNames(new EventsClient(options));
      for (const rule of matchRules(names, rules)) subscribe(rule.name, rule.arguments, rule);
    }
  }

  const close = async () => {
    lifetime.abort();
    for (const sub of [...subs]) remove(sub);
    queued.length = 0;
  };
  if (signal.aborted) await close();
  else signal.addEventListener('abort', () => { void close(); }, { once: true });

  return {
    names: capable ? ['mcp_events'] : [],
    async run(name, args, active) {
      active.throwIfAborted(); signal.throwIfAborted(); checkServer(args);
      if (name !== 'mcp_events') throw new Error(`Unknown tool: ${name}`);
      const action = args.action;
      if (typeof action !== 'string') throw new TypeError('Expected action to be a non-empty string');
      if (action === 'servers') return { servers: capable ? [ctx.id] : [] };
      requireEvents();
      if (action === 'list') return new EventsClient(options).list(typeof args.cursor === 'string' ? args.cursor : undefined);
      if (action === 'subscriptions') return { subscriptions: [...subs].map(s => ({ name: s.name, arguments: structuredClone(s.arguments), cursor: s.accepted })) };
      if (action === 'subscribe') {
        if (typeof args.name !== 'string' || !args.name) throw new TypeError('name required');
        if (args.arguments !== undefined && !isObj(args.arguments)) throw new TypeError('arguments must be an object');
        const rule: SubscribeRuleOptions = {
          ...(args.delivery === 'push' || args.delivery === 'poll' || args.delivery === 'auto' ? { delivery: args.delivery } : {}),
          ...(typeof args.maxAgeMs === 'number' ? { maxAgeMs: args.maxAgeMs } : {}),
        };
        const matches = /[*?]/.test(args.name) ? matchRules(await listNames(new EventsClient(options)), [args.name]).map(r => r.name) : [args.name];
        if (!matches.length) throw new Error(`No events match ${args.name}`);
        const created = matches.map(eventName => subscribe(eventName, (args.arguments ?? {}) as Obj, rule));
        return /[*?]/.test(args.name) ? { names: created.map(s => s.name) } : { name: created[0]!.name };
      }
      if (action === 'unsubscribe') {
        if (typeof args.name !== 'string' || !args.name) throw new TypeError('name required');
        const re = /[*?]/.test(args.name) ? globToRegExp(args.name) : undefined;
        const matches = [...subs].filter(s => re ? re.test(s.name) : s.name === args.name);
        for (const sub of matches) {
          remove(sub);
          ctx.db.prepare('DELETE FROM durable_event_subscriptions WHERE subscription = ?').run(sub.id);
        }
        return { removed: matches.length };
      }
      if (action === 'poll') {
        await Promise.all([...subs].filter(s => !s.push).map(async s => {
          // Use the same cursor-seeded client as background polling.
          const result = await s.client.poll(s.subscription).catch(() => undefined);
          for (const event of result?.events ?? []) enqueue(s, event);
        }));
        const events = queued.splice(0).map(q => q.event);
        return { events };
      }
      throw new Error(`Unknown action: ${action}`);
    },
    close,
  };
}
