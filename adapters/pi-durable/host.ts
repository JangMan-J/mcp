import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { DurableToolAdapter, type ToolIntent, type ToolWire } from './adapter.js';
import type { PerKeyMutex } from './calls.js';
import {
  createDurableMcpExtension, type DurableExtension, type DurablePromptSection, type DurableToolExecutionApi,
  type DurableContext, type Exposure, type McpCallToolResult, type McpToolDescriptor,
} from './extension.js';
import {
  errorToHostResult, featureParameters, outcomeToHostResult, valueToHostResult, type HostToolResult,
} from './durable-tools.js';
import { createSqliteDurableCallStore } from './sqlite-store.js';
import { loadServers, openRuntime } from './runtime.js';
import { createCoreFeatures } from './core-features.js';
import { createStreamFeatures } from './stream-features.js';
import { createExtendedFeatures } from './extended-features.js';

/** One MCP server as described by explicit options or mcp.json (parsed by ./runtime.js). */
export interface DurableServerDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly instructions?: string;
  readonly exposure?: Exposure;
  readonly toolExposure?: Readonly<Record<string, Exposure>>;
  readonly readOnlyTools?: readonly string[];
  readonly toolOverrides?: Readonly<Record<string, 'replay' | 'interrupt'>>;
  readonly acceptDuplicate?: boolean;
  readonly [k: string]: unknown;
}

/** Structural contract implemented by ./runtime.js openRuntime(). */
export interface DurableRuntime {
  listTools(signal?: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(request: ToolWire, signal?: AbortSignal): Promise<McpCallToolResult>;
  onToolsChanged?(listener: () => void): void;
  signIn?(signal?: AbortSignal): Promise<unknown>;
  inspectCard?(signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface FeatureModule {
  names: string[];
  run(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}
export interface FeatureContext {
  id: string;
  runtime: DurableRuntime;
  descriptor: DurableServerDescriptor;
  db: DatabaseSync;
  options: DurableHostOptions;
}

export interface DurableHostOptions {
  readonly servers?: readonly DurableServerDescriptor[];
  readonly mcpConfig?: string;
  /** SQLite file for call records, cursors and handles; defaults to in-memory. */
  readonly databasePath?: string;
  readonly toolNaming?: 'prefixed' | 'bare';
  readonly readOnlyTools?: ReadonlySet<string> | readonly string[];
  admitTool?(toolName: string, serverId: string): boolean;
  /** Remaining hooks (consent, authorizationConsent, deliver, appRenderer, ...) pass through to runtime/features. */
  readonly [k: string]: unknown;
}

export interface DurableMcpHost {
  readonly extensions: readonly DurableExtension[];
  readonly toolNames: readonly string[];
  readonly servers: readonly string[];
  call(key: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolResult>;
  refreshTools(serverId?: string): Promise<void>;
  signIn(serverId: string, signal?: AbortSignal): Promise<unknown>;
  inspectCard(serverId: string, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

interface Server {
  id: string;
  descriptor: DurableServerDescriptor;
  runtime: DurableRuntime;
  features: FeatureModule[];
  tools: McpToolDescriptor[];
  extension: DurableExtension;
  adapter: DurableToolAdapter<McpCallToolResult>;
  /** registered name -> MCP tool name */
  names: Map<string, string>;
}

function keyedMutex(): PerKeyMutex {
  const tails = new Map<string, Promise<unknown>>();
  return {
    withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
      const tail = run.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return run;
    },
  } as PerKeyMutex;
}

export async function startDurableMcpHost(options: DurableHostOptions = {}): Promise<DurableMcpHost> {
  const db = new DatabaseSync(options.databasePath ?? ':memory:');
  const store = createSqliteDurableCallStore<ToolIntent, McpCallToolResult>(db);
  const mutex = keyedMutex();
  const signals = new AsyncLocalStorage<AbortSignal>();
  /** callId -> in-flight controller, for idempotent cancel(). */
  const inflight = new Map<string, AbortController>();
  const globalReadOnly = [...(options.readOnlyTools ?? [])];
  const servers = new Map<string, Server>();
  const featureRoutes = new Map<string, Server[]>();
  let extensions: DurableExtension[] = [];
  let closed = false;

  const send = (runtime: DurableRuntime) => (wire: ToolWire) => runtime.callTool(wire, signals.getStore());

  const buildExtension = (s: Server): void => {
    const admitted = s.tools.filter(t => options.admitTool?.(t.name, s.id) ?? true);
    const readOnlyTools = [...globalReadOnly, ...(s.descriptor.readOnlyTools ?? [])];
    const ext = createDurableMcpExtension({
      serverId: s.id,
      description: s.descriptor.description ?? `MCP server ${s.id}`,
      ...(s.descriptor.instructions !== undefined ? { instructions: s.descriptor.instructions } : {}),
      ...(s.descriptor.exposure ? { exposure: s.descriptor.exposure } : {}),
      ...(s.descriptor.toolExposure ? { toolExposure: s.descriptor.toolExposure } : {}),
      ...(s.descriptor.toolOverrides ? { toolOverrides: s.descriptor.toolOverrides } : {}),
      ...(s.descriptor.acceptDuplicate !== undefined ? { acceptDuplicate: s.descriptor.acceptDuplicate } : {}),
      tools: admitted, readOnlyTools, store, mutex, send: send(s.runtime),
      onCancel: ({ callId }) => { inflight.get(callId)?.abort(); },
    });
    s.names.clear();
    const prefix = `mcp__${s.id}__`;
    const tools = (ext.tools ?? []).map(t => {
      const mcpName = admitted.find(a => t.name === `${prefix}${a.name}` || t.name.startsWith(prefix) && a.name === t.name.slice(prefix.length))?.name
        ?? t.description.replace(/^MCP tool (\S+) on .*$/, '$1');
      const name = options.toolNaming === 'bare' ? mcpName : t.name;
      s.names.set(name, mcpName);
      return {
        ...t, name,
        async execute(args: Readonly<Record<string, unknown>>, api: DurableToolExecutionApi, ctx: DurableContext) {
          const ac = new AbortController();
          ctx.signal?.addEventListener('abort', () => ac.abort(), { once: true });
          inflight.set(api.callId, ac);
          try {
            const r = await signals.run(ac.signal, () => t.execute(args, api, ctx));
            const outcome = r.details && (r.details as { status?: string }).status === 'interrupted'
              ? { status: 'interrupted' as const, ...(r.details as object) }
              : { status: 'completed' as const, result: r.structuredOutput as McpCallToolResult };
            return outcomeToHostResult(outcome as never);
          } finally { inflight.delete(api.callId); }
        },
      };
    });
    s.extension = { ...ext, tools: tools as never };
  };

  const featureExtension = (): DurableExtension | undefined => {
    if (featureRoutes.size === 0) return undefined;
    const tools = [...featureRoutes.entries()].map(([name, owners]) => ({
      name,
      description: `MCP ${name.replace(/^mcp_/, '')} across servers: ${owners.map(o => o.id).join(', ')}. Pass "server" and "action".`,
      parameters: featureParameters([]),
      replay: 'unsafe' as const,
      callers: ['model', 'tools'] as const,
      async execute(args: Readonly<Record<string, unknown>>, api: DurableToolExecutionApi, ctx: DurableContext) {
        const id = typeof args['server'] === 'string' ? args['server'] : owners.length === 1 ? owners[0]!.id : undefined;
        const owner = owners.find(o => o.id === id);
        if (!owner) return errorToHostResult(`"server" must be one of: ${owners.map(o => o.id).join(', ')}`);
        const ac = new AbortController();
        ctx.signal?.addEventListener('abort', () => ac.abort(), { once: true });
        inflight.set(api.callId, ac);
        try {
          const mod = owner.features.find(f => f.names.includes(name))!;
          return valueToHostResult(await mod.run(name, { ...args }, ac.signal));
        } catch (e) { return errorToHostResult(e); } finally { inflight.delete(api.callId); }
      },
      async cancel(_args: unknown, api: DurableToolExecutionApi) { inflight.get(api.callId)?.abort(); },
    }));
    const sections: DurablePromptSection[] = [];
    return { name: 'mcp-features', tools: tools as never, sections };
  };

  const rebuild = (): void => {
    extensions = [...servers.values()].map(s => s.extension);
    const f = featureExtension();
    if (f) extensions.push(f);
  };

  const refresh = async (s: Server, signal?: AbortSignal): Promise<void> => {
    s.tools = [...await s.runtime.listTools(signal)];
    buildExtension(s);
    rebuild();
  };

  // Explicit servers win over same-named mcp.json entries.
  const fromConfig = options.mcpConfig ? (await loadServers(options.mcpConfig)) as DurableServerDescriptor[] : [];
  const explicit = options.servers ?? [];
  const descriptors = [...fromConfig.filter(d => !explicit.some(e => e.name === d.name)), ...explicit];
  const opened = await Promise.allSettled(descriptors.map(async descriptor => {
    const runtime = (await openRuntime(descriptor as never, options as never)) as unknown as DurableRuntime;
    const s: Server = {
      id: descriptor.name, descriptor, runtime, features: [], tools: [], names: new Map(),
      extension: { name: `mcp-${descriptor.name}` },
      adapter: new DurableToolAdapter<McpCallToolResult>({ store, mutex, send: send(runtime) }),
    };
    try {
      const ctx: FeatureContext = { id: s.id, runtime, descriptor, db, options };
      s.features = (await Promise.all([createCoreFeatures(ctx as never), createStreamFeatures(ctx as never), createExtendedFeatures(ctx as never)]))
        .map(m => m as FeatureModule);
      await refresh(s);
      runtime.onToolsChanged?.(() => { if (!closed) void refresh(s).catch(() => undefined); });
    } catch (e) {
      await Promise.allSettled(s.features.map(f => f.close()));
      await runtime.close().catch(() => undefined);
      throw e;
    }
    return s;
  }));
  const failure = opened.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  for (const r of opened) if (r.status === 'fulfilled') servers.set(r.value.id, r.value);
  if (failure) { await closeAll(); throw failure.reason; }
  for (const s of servers.values()) for (const f of s.features) for (const n of f.names) {
    featureRoutes.set(n, [...(featureRoutes.get(n) ?? []), s]);
  }
  rebuild();

  async function closeAll(): Promise<void> {
    if (closed) return;
    closed = true;
    for (const ac of inflight.values()) ac.abort();
    await Promise.allSettled([...servers.values()].flatMap(s => [...s.features.map(f => f.close()), s.runtime.close()]));
    db.close();
  }

  const server = (id: string): Server => {
    const s = servers.get(id);
    if (!s) throw new Error(`Unknown MCP server: ${id}`);
    return s;
  };

  return {
    get extensions() { return extensions; },
    get toolNames() { return extensions.flatMap(e => (e.tools ?? []).map(t => t.name)); },
    get servers() { return [...servers.keys()]; },
    async call(key, name, args, signal) {
      for (const s of servers.values()) {
        const mcpName = s.names.get(name);
        if (mcpName === undefined) continue;
        const tool = s.tools.find(t => t.name === mcpName)!;
        // Same durable pipeline as registered tools: intent-before-send, digest, outcome-before-return.
        const outcome = await signals.run(signal ?? new AbortController().signal, () =>
          s.adapter.callTool(key, { key: 'mcp' }, { serverId: s.id, toolName: mcpName, inputSchema: tool.inputSchema, args }));
        return outcomeToHostResult(outcome);
      }
      const owners = featureRoutes.get(name);
      const reg = owners && extensions.at(-1)?.tools?.find(t => t.name === name);
      if (!reg) throw new Error(`Unknown tool: ${name}`);
      return reg.execute(args, { callId: key, executeTool: async () => { throw new Error('nested calls unsupported in host.call'); } },
        signal ? { signal } : {}) as unknown as Promise<HostToolResult>;
    },
    refreshTools: async (id) => { await Promise.all((id ? [server(id)] : [...servers.values()]).map(s => refresh(s))); },
    async signIn(id, signal) {
      const s = server(id);
      if (!s.runtime.signIn) throw new Error(`Server ${id} has no sign-in`);
      const r = await s.runtime.signIn(signal);
      await refresh(s, signal);
      return r;
    },
    async inspectCard(id, signal) {
      const s = server(id);
      if (!s.runtime.inspectCard) throw new Error(`Server ${id} has no server card support`);
      return s.runtime.inspectCard(signal);
    },
    close: closeAll,
  };
}
