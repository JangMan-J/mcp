import type { DatabaseSync } from 'node:sqlite';
import type { ListenFilter, Subscription } from '@mcp-client/mrtr-cache';
import type { DurableRuntime, ServerDescriptor } from './runtime.js';
import { DurableHandles } from './handles.js';

/** Common per-server feature contract consumed by the durable host. */
export interface DurableFeature {
  readonly names: string[];
  run(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface DurableFeatureContext {
  readonly id: string;
  readonly runtime: DurableRuntime;
  readonly descriptor: Pick<ServerDescriptor, 'name' | 'aliases' | 'subscribe'>;
  readonly db: DatabaseSync;
  readonly options: {
    readonly wake?: (server: string, reason: string) => void | Promise<void>;
    readonly refreshTools?: () => void | Promise<void>;
    readonly deliver?: (event: Record<string, unknown>) => void | Promise<void>;
  };
}

type Obj = Record<string, unknown>;
type Outcome<T> = { kind: 'ok'; value: T } | { kind: string; [key: string]: unknown };
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function field(args: Obj, name: string, empty = false): string {
  const value = args[name];
  if (typeof value !== 'string' || (!empty && !value)) throw new TypeError(`Expected ${name} to be ${empty ? 'a' : 'a non-empty'} string`);
  return value;
}
function promptArgs(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isObj(value) || Object.values(value).some(v => typeof v !== 'string')) throw new TypeError('Expected arguments to be an object of strings');
  return value as Record<string, string>;
}
function capabilities(rt: DurableRuntime): Obj {
  return isObj(rt.capabilities) ? rt.capabilities : {};
}
function supports(rt: DurableRuntime, name: string, flag?: string): boolean {
  const cap = capabilities(rt)[name];
  return isObj(cap) && (flag === undefined || cap[flag] === true);
}
function value<T>(out: Outcome<T>, project: (v: T) => unknown): unknown {
  return out.kind === 'ok' ? project((out as { value: T }).value) : out;
}

/** Acknowledged resource URIs, persisted per server so a reopened host can resubscribe. */
function resourceHandles(ctx: DurableFeatureContext): DurableHandles {
  ctx.db.exec('CREATE TABLE IF NOT EXISTS durable_resource_handles (server TEXT PRIMARY KEY, handle TEXT NOT NULL)');
  return new DurableHandles({
    storage: {
      read: () => {
        const row = ctx.db.prepare('SELECT handle FROM durable_resource_handles WHERE server = ?').get(ctx.id) as { handle: string } | undefined;
        return row ? JSON.parse(row.handle) : null;
      },
      write: data => { ctx.db.prepare('INSERT OR REPLACE INTO durable_resource_handles (server, handle) VALUES (?, ?)').run(ctx.id, JSON.stringify(data)); },
    },
    send: async () => { throw new Error('resource handles are restored locally'); },
  });
}

/** Prompts/resources and MCP subscriptions/listen for one already-connected server. */
export async function createCoreFeatures(ctx: DurableFeatureContext): Promise<DurableFeature> {
  const { runtime: rt } = ctx;
  const discovered = await rt.ready();
  if (discovered.kind !== 'ok') return {
    names: [],
    async run() { return discovered; },
    async close() {},
  };

  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, rt.transportClosed]);
  let stream: Subscription | undefined;
  let pending: Subscription | undefined;
  let uris: readonly string[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const filter: ListenFilter = {
    tools: supports(rt, 'tools', 'listChanged'),
    prompts: supports(rt, 'prompts', 'listChanged'),
    resources: supports(rt, 'resources', 'listChanged'),
  };

  async function consume(current: Subscription): Promise<void> {
    try {
      for await (const { method, params } of current.events) {
        if (signal.aborted || stream !== current) break;
        try {
          if (method === 'notifications/tools/list_changed') await ctx.options.refreshTools?.();
          else if (method === 'notifications/resources/updated' && typeof params.uri === 'string') {
            await ctx.options.deliver?.({ server: ctx.id, method, params });
            await ctx.options.wake?.(ctx.id, `Resource updated: ${params.uri}`);
          }
          else if (method === 'notifications/resources/list_changed') await ctx.options.wake?.(ctx.id, 'Resource list changed');
          else if (method === 'notifications/prompts/list_changed') await ctx.options.wake?.(ctx.id, 'Prompt list changed');
        } catch { /* Host callbacks do not own the protocol stream. */ }
      }
    } finally {
      if (stream === current) { stream = undefined; uris = []; }
    }
  }

  async function listen(nextUris: readonly string[], active: AbortSignal): Promise<void> {
    active.throwIfAborted();
    const manager = rt.stateful.subscriptions;
    const old = stream;
    if (!manager) return;
    if (!nextUris.length && !Object.values(filter).some(Boolean)) {
      stream = undefined; uris = []; old?.close(); return;
    }
    const next = manager.listen({ ...filter, ...(nextUris.length ? { resourceUris: nextUris } : {}) });
    pending = next;
    const abort = () => next.close();
    active.addEventListener('abort', abort, { once: true });
    try {
      const { granted } = await next.acknowledged;
      active.throwIfAborted();
      const grantedUris = granted.resourceSubscriptions ?? [];
      if (nextUris.some(uri => !grantedUris.includes(uri))) throw new Error('MCP server did not grant the requested resource subscriptions');
      stream = next; uris = nextUris; old?.close();
      void consume(next).catch(() => {});
    } catch (error) {
      next.close(); throw error;
    } finally {
      active.removeEventListener('abort', abort);
      if (pending === next) pending = undefined;
    }
  }

  const handles = resourceHandles(ctx);
  const canSubscribe = supports(rt, 'resources', 'subscribe') && !!rt.stateful.subscriptions;
  const saveUris = () => handles.save({ kind: 'subscription', subscriptions: [...uris] });
  // Background interest is best effort and must not delay tool availability.
  queue = (async () => {
    const handle = canSubscribe ? await handles.load().catch(() => null) : null;
    const stored = handle?.kind === 'subscription' ? handle.subscriptions.filter((u): u is string => typeof u === 'string') : [];
    if (stored.length) try { await listen(stored, signal); return; } catch { /* fall back to list-changed interest only */ }
    await listen([], signal);
  })().catch(() => {});
  const serverName = ctx.descriptor.name || ctx.id;
  const checkServer = (args: Obj) => {
    if (args.server !== undefined && args.server !== ctx.id && args.server !== serverName && !ctx.descriptor.aliases?.includes(field(args, 'server')))
      throw new Error(`Unknown MCP server: ${String(args.server)}`);
  };
  const opts = (active: AbortSignal, cursor?: string) => ({ signal: active, ...(cursor !== undefined ? { cursor } : {}) });
  const requireCapability = (name: string) => {
    if (!supports(rt, name)) throw new Error(`MCP server ${ctx.id} does not advertise ${name}`);
  };

  async function prompts(args: Obj, active: AbortSignal): Promise<unknown> {
    const action = field(args, 'action');
    requireCapability('prompts');
    if (action === 'list') {
      const out = await rt.ops.prompts.list(opts(active, args.cursor === undefined ? undefined : field(args, 'cursor', true)));
      return value(out, v => ({ server: ctx.id, prompts: v.prompts, ...(v.nextCursor !== undefined ? { nextCursor: v.nextCursor } : {}) }));
    }
    if (action === 'get') {
      const out = await rt.ops.prompts.get(field(args, 'name'), promptArgs(args.arguments), { signal: active });
      return value(out, v => ({ server: ctx.id, ...(v.description !== undefined ? { description: v.description } : {}), messages: v.messages.map(m => m.raw) }));
    }
    if (action === 'complete') {
      if (!supports(rt, 'completions')) throw new Error(`MCP server ${ctx.id} does not advertise completions`);
      const context = promptArgs(args.arguments);
      const out = await rt.ops.completion.complete({
        ref: { type: 'ref/prompt', name: field(args, 'name') },
        argument: { name: field(args, 'argument'), value: field(args, 'value', true) },
        ...(context ? { context: { arguments: context } } : {}),
      }, { signal: active });
      return value(out, v => ({ server: ctx.id, ...v }));
    }
    throw new Error(`Unknown MCP prompts action: ${action}`);
  }

  async function resources(args: Obj, active: AbortSignal): Promise<unknown> {
    const action = field(args, 'action');
    requireCapability('resources');
    const cursor = args.cursor === undefined ? undefined : field(args, 'cursor', true);
    if (action === 'list' || action === 'templates') {
      const out = action === 'list' ? await rt.ops.resources.list(opts(active, cursor)) : await rt.ops.resources.listTemplates(opts(active, cursor));
      return value(out, v => ({
        server: ctx.id, [action === 'list' ? 'resources' : 'resourceTemplates']: v.items.map(i => i.raw),
        ...(v.nextCursor !== undefined ? { nextCursor: v.nextCursor } : {}),
      }));
    }
    if (action === 'directory') {
      const [resources, templates] = await Promise.all([rt.ops.resources.list(opts(active, cursor)), rt.ops.resources.listTemplates(opts(active, cursor))]);
      return {
        server: ctx.id,
        ...(resources.kind === 'ok' ? { resources: resources.value.items.map(i => i.raw), ...(resources.value.nextCursor !== undefined ? { nextResourceCursor: resources.value.nextCursor } : {}) } : { resourcesError: resources }),
        ...(templates.kind === 'ok' ? { resourceTemplates: templates.value.items.map(i => i.raw), ...(templates.value.nextCursor !== undefined ? { nextTemplateCursor: templates.value.nextCursor } : {}) } : { templatesError: templates }),
      };
    }
    if (action === 'read') {
      const uri = field(args, 'uri');
      const out = await rt.ops.resources.read(uri, { signal: active });
      return value(out, v => ({ server: ctx.id, uri, contents: v.raw.contents }));
    }
    if (action === 'subscriptions') return { subscriptions: [{ server: ctx.id, uris: [...uris], state: stream?.state ?? 'ended' }] };
    if (action === 'subscribe' || action === 'unsubscribe') {
      if (!supports(rt, 'resources', 'subscribe') || !rt.stateful.subscriptions) throw new Error(`MCP resource subscriptions unavailable on ${ctx.id}`);
      const uri = field(args, 'uri');
      const update = queue.then(async () => {
        active.throwIfAborted();
        const next = new Set(uris);
        const had = next.has(uri);
        if (action === 'subscribe') next.add(uri); else next.delete(uri);
        if (had !== next.has(uri)) { await listen([...next], active); await saveUris(); }
        return { server: ctx.id, uris: [...uris] };
      });
      queue = update.catch(() => {});
      return update;
    }
    throw new Error(`Unknown MCP resources action: ${action}`);
  }

  const close = async () => {
    lifetime.abort();
    pending?.close(); stream?.close();
    pending = undefined; stream = undefined; uris = [];
    await queue.catch(() => {});
  };
  if (signal.aborted) await close();
  else signal.addEventListener('abort', () => { void close(); }, { once: true });

  return {
    names: [...(supports(rt, 'prompts') ? ['mcp_prompts'] : []), ...(supports(rt, 'resources') ? ['mcp_resources'] : [])],
    async run(name, args, active) {
      active.throwIfAborted(); signal.throwIfAborted(); checkServer(args);
      const combined = AbortSignal.any([active, signal]);
      if (name === 'mcp_prompts') return prompts(args, combined);
      if (name === 'mcp_resources') return resources(args, combined);
      throw new Error(`Unknown tool: ${name}`);
    },
    close,
  };
}
