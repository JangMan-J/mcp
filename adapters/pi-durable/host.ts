import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  McpOutcomeError,
  type AuthProvider,
  type BrowserPort,
  type ConsentPort,
  type DiscoverResult,
  type Outcome,
  type TelemetryPort,
  type Transport,
} from '@mcp-client/core';
import type { AuthorizationConsent } from '@mcp-client/auth';
import type { AppRenderPort } from '@mcp-client/ext-apps';
import type { OtelTelemetryOptions } from '@mcp-client/telemetry-otel';
import type { ToolIntent } from './adapter.js';
import type { PerKeyMutex } from './calls.js';
import { featureParameters } from './durable-tools.js';
import {
  durableToolNames,
  type Exposure,
  type McpCallToolResult,
  type McpContent,
  type McpToolDescriptor,
} from './extension.js';
import { registerOperation, type HostToolRegistration, type HostToolResult } from './host-tools.js';
import { nestedCallKey } from './nested-key.js';
import type { IdempotencyPolicy } from './policies.js';
import {
  loadServers,
  normalizeServer,
  openRuntime,
  type DurableRuntime,
  type RuntimeOptions,
  type ServerDescriptor,
} from './runtime.js';
import { createSqliteDurableCallStore } from './sqlite-store.js';
import { createCoreFeatures } from './core-features.js';
import { createStreamFeatures } from './stream-features.js';
import { createExtendedFeatures } from './extended-features.js';

export type { HostToolRegistration, HostToolResult } from './host-tools.js';
export type { DurableRuntime, RuntimeOptions, ServerDescriptor } from './runtime.js';

/** Structural prompt section assignable to @earendil-works/pi-durable@1.6.0 PromptSection. */
export interface HostPromptSection {
  readonly key: string;
  readonly tag?: boolean;
  render(): string | undefined | Promise<string | undefined>;
}

/** Structural extension assignable to @earendil-works/pi-durable@1.6.0 Extension. */
export interface HostExtension {
  readonly name: string;
  readonly namespace?: {
    readonly name: string;
    readonly description: string;
    readonly instructions?: string;
  };
  readonly tools?: readonly HostToolRegistration[];
  readonly sections?: readonly HostPromptSection[];
}

/** Input accepted in DurableHostOptions.servers (raw config object or normalized ServerDescriptor). */
export interface DurableServerInput {
  readonly name: string;
  readonly transport?: 'stdio' | 'http';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly description?: string;
  readonly instructions?: string;
  readonly exposure?: Exposure;
  readonly toolExposure?: Readonly<Record<string, Exposure>>;
  readonly readOnlyTools?: readonly string[];
  readonly toolOverrides?: Readonly<Record<string, 'replay' | 'interrupt'>>;
  readonly acceptDuplicate?: boolean;
  readonly enabled?: boolean;
  readonly timeout?: number;
  readonly timeoutMs?: number;
  readonly aliases?: readonly string[];
  readonly allowLegacyInitialize?: boolean;
  readonly inheritEnv?: boolean | readonly string[];
  readonly trusted?: boolean;
  readonly source?: 'project' | 'global' | 'dynamic';
  readonly [k: string]: unknown;
}

export interface FeatureModule {
  readonly names: readonly string[];
  run(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface FeatureOptions {
  readonly consent?: ConsentPort;
  readonly deliver?: (event: Record<string, unknown>) => void | Promise<void>;
  readonly skillsCacheDir?: string;
  readonly appRenderer?: AppRenderPort;
  readonly stateDir?: string;
}

export interface FeatureContext {
  readonly id: string;
  readonly runtime: DurableRuntime;
  readonly descriptor: ServerDescriptor;
  readonly db: DatabaseSync;
  readonly options: FeatureOptions;
}

export interface DurableHostOptions {
  readonly servers?: readonly (ServerDescriptor | DurableServerInput)[];
  readonly mcpConfig?: string;
  /** SQLite file for call records, cursors and handles; defaults to in-memory. */
  readonly databasePath?: string;
  /** Isolated state directory for credentials and caches; defaults to `${databasePath}.state` or an isolated temp dir. */
  readonly stateDir?: string;
  readonly skillsCacheDir?: string;
  readonly toolNaming?: 'prefixed' | 'bare';
  readonly readOnlyTools?: ReadonlySet<string> | readonly string[];
  readonly admitTool?: (toolName: string, serverId: string) => boolean;
  readonly consent?: ConsentPort;
  readonly authorizationConsent?: AuthorizationConsent;
  readonly browser?: BrowserPort;
  readonly resolveProviderToken?: (provider: string) => Promise<string>;
  readonly deliver?: (event: Record<string, unknown>) => void | Promise<void>;
  readonly appRenderer?: AppRenderPort;
  readonly telemetry?: TelemetryPort;
  readonly otel?: OtelTelemetryOptions;
  readonly createTransport?: (descriptor: ServerDescriptor) => Transport | Promise<Transport>;
  readonly authProvider?: AuthProvider;
  readonly allowLegacyInitialize?: boolean;
  readonly inheritEnv?: boolean | readonly string[];
  readonly acceptDuplicate?: boolean;
  readonly restartLimit?: number;
  readonly policies?: readonly IdempotencyPolicy[];
  readonly newRequestId?: () => string;
  readonly signal?: AbortSignal;
}

export interface DurableMcpHost {
  readonly extensions: readonly HostExtension[];
  readonly toolNames: readonly string[];
  readonly servers: readonly string[];
  call(key: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<HostToolResult>;
  refreshTools(serverId?: string): Promise<void>;
  signIn(serverId: string, signal?: AbortSignal): Promise<unknown>;
  inspectCard(serverId: string, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

interface Server {
  readonly id: string;
  readonly descriptor: ServerDescriptor;
  readonly instructions?: string;
  readonly readOnlyTools?: readonly string[];
  readonly toolOverrides?: Readonly<Record<string, 'replay' | 'interrupt'>>;
  readonly acceptDuplicate?: boolean;
  readonly runtime: DurableRuntime;
  features: FeatureModule[];
  tools: McpToolDescriptor[];
  authorized: boolean;
  extension: HostExtension;
  readonly operations: Map<string, HostToolRegistration>;
  unsubToolsChanged?: () => void;
}

interface NormalizedEntry {
  readonly descriptor: ServerDescriptor;
  readonly instructions?: string;
  readonly readOnlyTools?: readonly string[];
  readonly toolOverrides?: Readonly<Record<string, 'replay' | 'interrupt'>>;
  readonly acceptDuplicate?: boolean;
}

const FEATURE_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  mcp_prompts: ['list', 'get', 'complete'],
  mcp_resources: ['list', 'templates', 'read', 'directory', 'subscribe', 'unsubscribe', 'subscriptions'],
  mcp_events: ['servers', 'list', 'subscribe', 'unsubscribe', 'subscriptions', 'poll'],
  mcp_tasks: ['call', 'get', 'update', 'cancel', 'active'],
  mcp_skills: ['list', 'get', 'load', 'read_file', 'directory'],
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

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
  };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`);
}

/** Exact key wins, then `*` wildcard patterns in insertion order, then the server default. */
function resolveToolExposure(
  descriptor: Pick<ServerDescriptor, 'exposure' | 'toolExposure'>,
  toolName: string,
): Exposure {
  const map = descriptor.toolExposure;
  if (map) {
    if (Object.hasOwn(map, toolName)) return map[toolName]!;
    for (const [pattern, exp] of Object.entries(map)) {
      if (!pattern.includes('*')) continue;
      if (globToRegExp(pattern).test(toolName)) return exp;
    }
  }
  return descriptor.exposure ?? 'direct';
}

function normalizeEntry(raw: ServerDescriptor | DurableServerInput): NormalizedEntry {
  // normalizeServer also preserves the durable replay fields on raw and normalized inputs.
  const descriptor = normalizeServer(raw.name, raw);
  return {
    descriptor,
    ...(descriptor.instructions !== undefined ? { instructions: descriptor.instructions } : {}),
    ...(descriptor.readOnlyTools !== undefined ? { readOnlyTools: descriptor.readOnlyTools } : {}),
    ...(descriptor.toolOverrides !== undefined ? { toolOverrides: descriptor.toolOverrides } : {}),
    ...(descriptor.acceptDuplicate !== undefined ? { acceptDuplicate: descriptor.acceptDuplicate } : {}),
  };
}

function isUnauthorizedOutcome(outcome: Outcome<DiscoverResult>): boolean {
  if (outcome.kind === 'auth-failure' || outcome.kind === 'auth-unavailable') return true;
  if (outcome.kind === 'transport-failure') {
    const f = outcome.failure;
    return (
      f.kind === 'auth-failure' ||
      f.kind === 'auth-unavailable' ||
      f.kind === 'forbidden' ||
      f.status === 401 ||
      f.status === 403
    );
  }
  return false;
}

function rawToMcpResult(raw: unknown): McpCallToolResult {
  if (isRecord(raw) && Array.isArray(raw['content'])) {
    return {
      content: raw['content'] as McpContent[],
      ...(raw['structuredContent'] !== undefined
        ? { structuredContent: raw['structuredContent'] }
        : { structuredContent: raw }),
      ...(raw['isError'] === true ? { isError: true } : {}),
    };
  }
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null, null, 2);
  return {
    content: [{ type: 'text', text }],
    structuredContent: raw ?? null,
  };
}

function featureSchema(name: string): Record<string, unknown> {
  const actions = FEATURE_ACTIONS[name];
  if (actions) return featureParameters(actions);
  return {
    type: 'object',
    properties: {
      server: { type: 'string', description: 'MCP server id' },
      action: { type: 'string' },
    },
    required: ['action'],
    additionalProperties: true,
  };
}

function isFileDatabase(databasePath: string | undefined): databasePath is string {
  return (
    typeof databasePath === 'string' &&
    databasePath.length > 0 &&
    databasePath !== ':memory:' &&
    !databasePath.startsWith('file::memory:')
  );
}

export async function startDurableMcpHost(options: DurableHostOptions = {}): Promise<DurableMcpHost> {
  const db = new DatabaseSync(options.databasePath ?? ':memory:');
  const store = createSqliteDurableCallStore<ToolIntent, McpCallToolResult>(db);
  const mutex = keyedMutex();
  const shutdownCtrl = new AbortController();
  const lifetimeSignal = options.signal
    ? AbortSignal.any([shutdownCtrl.signal, options.signal])
    : shutdownCtrl.signal;
  const activeExecutions = new Set<Promise<unknown>>();
  const globalReadOnly = [...(options.readOnlyTools ?? [])];
  const servers = new Map<string, Server>();
  const featureRoutes = new Map<string, Server[]>();
  const featureOperations = new Map<string, HostToolRegistration>();
  const cancelledTasks = new Set<string>();
  let extensions: HostExtension[] = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  let tempStateDir: string | undefined;

  let stateDir: string;
  if (options.stateDir !== undefined) {
    stateDir = options.stateDir;
  } else if (isFileDatabase(options.databasePath)) {
    stateDir = `${resolve(options.databasePath)}.state`;
  } else {
    tempStateDir = await mkdtemp(join(tmpdir(), 'pi-durable-'));
    stateDir = tempStateDir;
  }

  const featureOptions: FeatureOptions = {
    stateDir,
    skillsCacheDir: options.skillsCacheDir ?? join(stateDir, 'skills'),
    ...(options.consent !== undefined ? { consent: options.consent } : {}),
    ...(options.deliver !== undefined ? { deliver: options.deliver } : {}),
    ...(options.appRenderer !== undefined ? { appRenderer: options.appRenderer } : {}),
  };

  const runtimeOptions: RuntimeOptions = {
    stateDir,
    signal: lifetimeSignal,
    ...(options.consent !== undefined ? { consent: options.consent } : {}),
    ...(options.authorizationConsent !== undefined ? { authorizationConsent: options.authorizationConsent } : {}),
    ...(options.browser !== undefined ? { browser: options.browser } : {}),
    ...(options.resolveProviderToken !== undefined ? { resolveProviderToken: options.resolveProviderToken } : {}),
    ...(options.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
    ...(options.otel !== undefined ? { otel: options.otel } : {}),
    ...(options.createTransport !== undefined ? { createTransport: options.createTransport } : {}),
    ...(options.authProvider !== undefined ? { authProvider: options.authProvider } : {}),
    ...(options.appRenderer !== undefined ? { appRenderer: options.appRenderer } : {}),
    ...(options.allowLegacyInitialize !== undefined ? { allowLegacyInitialize: options.allowLegacyInitialize } : {}),
    ...(options.inheritEnv !== undefined ? { inheritEnv: options.inheritEnv } : {}),
  };

  function closeAll(): Promise<void> {
    if (closing) return closing;
    closed = true;
    shutdownCtrl.abort(new Error('Durable MCP host closed'));
    closing = (async () => {
      await Promise.allSettled([...activeExecutions]);
      for (const s of servers.values()) s.unsubToolsChanged?.();
      await Promise.allSettled(
        [...servers.values()].flatMap(s => [...s.features.map(f => f.close()), s.runtime.close()]),
      );
      if (db.isOpen) db.close();
      if (tempStateDir) await rm(tempStateDir, { recursive: true, force: true }).catch(() => undefined);
    })();
    return closing;
  }

  const wrapExecution = (reg: HostToolRegistration): HostToolRegistration => ({
    ...reg,
    execute(args, api, context) {
      if (closed || lifetimeSignal.aborted) {
        return Promise.reject(new Error('Durable MCP host is closed'));
      }
      // Chord exposes abortSignal (possibly as a non-enumerable getter); older peers expose signal.
      const abortSignal = (context as typeof context & { readonly abortSignal?: AbortSignal }).abortSignal;
      const sig = AbortSignal.any([
        lifetimeSignal,
        ...(abortSignal ? [abortSignal] : []),
        ...(context.signal ? [context.signal] : []),
      ]);
      const combinedContext = { ...context, abortSignal: sig, signal: sig };
      const p = reg.execute(args, api, combinedContext);
      activeExecutions.add(p);
      return p.finally(() => { activeExecutions.delete(p); });
    },
  });

  const operationDeps = (serverAcceptDuplicate?: boolean) => ({
    store,
    mutex,
    ...((serverAcceptDuplicate ?? options.acceptDuplicate) !== undefined
      ? { acceptDuplicate: serverAcceptDuplicate ?? options.acceptDuplicate }
      : {}),
    ...(options.restartLimit !== undefined ? { restartLimit: options.restartLimit } : {}),
    ...(options.policies !== undefined ? { policies: options.policies } : {}),
    ...(options.newRequestId !== undefined ? { newRequestId: options.newRequestId } : {}),
  });

  const isServerHidden = (s: Server): boolean =>
    s.descriptor.exposure === 'hidden' &&
    !Object.values(s.descriptor.toolExposure ?? {}).some(e => e !== 'hidden');

  const buildExtension = (s: Server): void => {
    s.operations.clear();
    const description = s.descriptor.description ?? `MCP server ${s.id}`;
    if (!s.authorized) {
      s.extension = {
        name: `mcp-${s.id}`,
        namespace: {
          name: s.id,
          description,
          ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
        },
        tools: [],
        sections: [],
      };
      return;
    }

    const admitted = s.tools.filter(t => options.admitTool?.(t.name, s.id) ?? true);
    const nameMap = durableToolNames(s.id, admitted.map(t => t.name));
    const readOnlyTools = [...globalReadOnly, ...(s.readOnlyTools ?? [])];
    const visible: { tool: McpToolDescriptor; name: string; exposure: 'direct' | 'codemode' | 'deferred' }[] = [];

    for (const tool of admitted) {
      const exposure = resolveToolExposure(s.descriptor, tool.name);
      if (exposure === 'hidden') continue;
      const name = options.toolNaming === 'bare' ? tool.name : nameMap.get(tool.name)!;
      visible.push({ tool, name, exposure });
    }

    const tools: HostToolRegistration[] = visible.map(({ tool, name, exposure }) => {
      const override = s.toolOverrides?.[tool.name];
      const reg = wrapExecution(registerOperation({
        name,
        serverId: s.id,
        wireName: tool.name,
        description: tool.description ?? `MCP tool ${tool.name} on ${s.id}`,
        inputSchema: tool.inputSchema,
        exposure,
        readOnly: readOnlyTools.includes(tool.name),
        ...(override !== undefined ? { override } : {}),
        invoke: async (args, signal, requestId) => {
          const active = signal ?? lifetimeSignal;
          const result = await s.runtime.callTool(
            { requestId, serverId: s.id, toolName: tool.name, args },
            active,
          );
          if (options.appRenderer) {
            // Rendering follows the wire call: a UI/resource failure must not reject the
            // durable attempt and leave its already-sent tools/call eligible for resend.
            await s.runtime.renderToolApp(tool, active).catch(() => undefined);
          }
          return result;
        },
      }, operationDeps(s.acceptDuplicate)));
      s.operations.set(name, reg);
      return reg;
    });

    const sections: HostPromptSection[] = visible.length === 0 ? [] : [{
      key: 'mcp_servers',
      render: () => {
        const lines = [`MCP server ${s.id}: ${description}`];
        if (s.instructions) lines.push(s.instructions);
        for (const v of visible) {
          lines.push(`- ${v.name} (${v.exposure})${v.tool.description ? `: ${v.tool.description}` : ''}`);
        }
        return lines.join('\n');
      },
    }];

    s.extension = {
      name: `mcp-${s.id}`,
      namespace: {
        name: s.id,
        description,
        ...(s.instructions !== undefined ? { instructions: s.instructions } : {}),
      },
      tools,
      sections,
    };
  };

  const buildFeatureExtension = (): HostExtension | undefined => {
    featureOperations.clear();
    if (featureRoutes.size === 0) return undefined;
    const tools: HostToolRegistration[] = [...featureRoutes.entries()].map(([name, owners]) => {
      const reg = wrapExecution(registerOperation({
        name,
        serverId: 'mcp-features',
        wireName: name,
        description: `MCP ${name.replace(/^mcp_/, '')} across servers: ${owners.map(o => o.id).join(', ')}. Pass "server" and "action".`,
        inputSchema: featureSchema(name),
        exposure: 'direct',
        readOnly: name === 'mcp_prompts' || globalReadOnly.includes(name),
        invoke: async (args, signal) => {
          const action = args['action'];
          if (typeof args['server'] !== 'string' && owners.length > 1 && name === 'mcp_events' && action === 'servers') {
            return rawToMcpResult({ servers: owners.map(o => o.id) });
          }
          const id = typeof args['server'] === 'string'
            ? args['server']
            : owners.length === 1
              ? owners[0]!.id
              : undefined;
          const owner = owners.find(o => o.id === id);
          if (!owner) {
            throw new Error(`"server" must be one of: ${owners.map(o => o.id).join(', ')}`);
          }
          const mod = owner.features.find(f => f.names.includes(name));
          if (!mod) throw new Error(`Server ${owner.id} does not support ${name}`);
          const taskTool = args['tool'];
          if (name === 'mcp_tasks' && action === 'call' && typeof taskTool === 'string' &&
            (!(options.admitTool?.(taskTool, owner.id) ?? true) || resolveToolExposure(owner.descriptor, taskTool) === 'hidden')) {
            throw new Error(`MCP tool ${taskTool} on ${owner.id} is not admitted`);
          }
          const raw = await mod.run(name, { ...args }, signal ?? lifetimeSignal);
          const result = rawToMcpResult(raw);
          if (name === 'mcp_tasks' && isRecord(result.structuredContent)) {
            return { ...result, structuredContent: { ...result.structuredContent, server: owner.id } };
          }
          return result;
        },
      }, {
        ...operationDeps(),
        ...(name === 'mcp_tasks' ? {
          onCancel: async ({ callId }: { callId: string }) => {
            const record = await store.get(nestedCallKey(callId, { key: 'mcp' }));
            const data = record?.status === 'completed' ? record.result?.structuredContent : undefined;
            if (!isRecord(data) || typeof data['taskId'] !== 'string' || typeof data['server'] !== 'string') return;
            const taskId = data['taskId'];
            const owner = servers.get(data['server']);
            const mod = owner?.features.find(f => f.names.includes('mcp_tasks'));
            if (!owner || !mod) return;
            const key = `${owner.id}\0${taskId}`;
            if (cancelledTasks.has(key)) return;
            cancelledTasks.add(key);
            await mod.run('mcp_tasks', { action: 'cancel', taskId }, lifetimeSignal);
          },
        } : {}),
      }));
      featureOperations.set(name, reg);
      return reg;
    });
    return { name: 'mcp-features', tools, sections: [] };
  };

  const rebuildFeatureRoutes = (): void => {
    featureRoutes.clear();
    for (const s of servers.values()) {
      for (const f of s.features) {
        for (const n of f.names) {
          featureRoutes.set(n, [...(featureRoutes.get(n) ?? []), s]);
        }
      }
    }
  };

  const rebuild = (): void => {
    const nextExtensions = [...servers.values()].map(s => s.extension);
    const featureExt = buildFeatureExtension();
    if (featureExt) nextExtensions.push(featureExt);

    // Detect colliding registered tool names across servers and feature tools.
    const seenTools = new Map<string, string>();
    for (const ext of nextExtensions) {
      for (const tool of ext.tools ?? []) {
        const prev = seenTools.get(tool.name);
        if (prev !== undefined) {
          throw new Error(`Colliding MCP tool name "${tool.name}" across ${prev} and ${ext.name}`);
        }
        seenTools.set(tool.name, ext.name);
      }
    }
    extensions = nextExtensions;
  };

  const buildFeatures = async (s: Server): Promise<FeatureModule[]> => {
    if (isServerHidden(s)) return [];
    const ctx: FeatureContext = {
      id: s.id,
      runtime: s.runtime,
      descriptor: s.descriptor,
      db,
      options: featureOptions,
    };
    const settled = await Promise.allSettled([
      createCoreFeatures(ctx),
      createStreamFeatures(ctx),
      createExtendedFeatures(ctx),
    ]);
    const modules: FeatureModule[] = [];
    let firstFailure: unknown;
    let hasFailure = false;
    for (const r of settled) {
      if (r.status === 'fulfilled') modules.push(r.value);
      else if (!hasFailure) { hasFailure = true; firstFailure = r.reason; }
    }
    if (hasFailure) {
      await Promise.allSettled(modules.map(m => m.close()));
      throw firstFailure;
    }
    return modules;
  };

  const wireToolsChanged = (s: Server): void => {
    s.unsubToolsChanged?.();
    s.unsubToolsChanged = s.runtime.onToolsChanged?.(() => {
      if (!closed) void refreshServer(s).then(() => rebuild()).catch(() => undefined);
    });
  };

  const refreshServer = async (s: Server, signal?: AbortSignal): Promise<void> => {
    if (!s.authorized) {
      buildExtension(s);
      return;
    }
    s.tools = [...await s.runtime.listTools(signal)];
    buildExtension(s);
  };

  try {
    const fromConfig = options.mcpConfig ? await loadServers(options.mcpConfig) : [];
    const explicitRaw = options.servers ?? [];
    const seenExplicit = new Set<string>();
    const explicitEntries: NormalizedEntry[] = [];
    for (const raw of explicitRaw) {
      if (seenExplicit.has(raw.name)) {
        throw new Error(`Duplicate MCP server name: ${raw.name}`);
      }
      seenExplicit.add(raw.name);
      explicitEntries.push(normalizeEntry(raw));
    }

    const entries: NormalizedEntry[] = [
      ...fromConfig.filter(d => !seenExplicit.has(d.name)).map(d => normalizeEntry(d)),
      ...explicitEntries,
    ].filter(e => e.descriptor.enabled !== false);

    const opened = await Promise.allSettled(entries.map(async entry => {
      const { descriptor } = entry;
      const runtime = await openRuntime(descriptor, runtimeOptions);
      const s: Server = {
        id: descriptor.name,
        descriptor,
        ...(entry.instructions !== undefined ? { instructions: entry.instructions } : {}),
        ...(entry.readOnlyTools !== undefined ? { readOnlyTools: entry.readOnlyTools } : {}),
        ...(entry.toolOverrides !== undefined ? { toolOverrides: entry.toolOverrides } : {}),
        ...(entry.acceptDuplicate !== undefined ? { acceptDuplicate: entry.acceptDuplicate } : {}),
        runtime,
        features: [],
        tools: [],
        authorized: false,
        extension: { name: `mcp-${descriptor.name}`, tools: [], sections: [] },
        operations: new Map(),
      };
      try {
        // Discover capabilities before constructing any feature modules.
        const disc = await runtime.ready(lifetimeSignal);
        if (isUnauthorizedOutcome(disc)) {
          s.authorized = false;
          buildExtension(s);
          return s;
        }
        if (disc.kind !== 'ok') {
          throw new McpOutcomeError(disc);
        }
        s.authorized = true;
        s.features = await buildFeatures(s);
        await refreshServer(s, lifetimeSignal);
        wireToolsChanged(s);
        return s;
      } catch (e) {
        s.unsubToolsChanged?.();
        await Promise.allSettled(s.features.map(f => f.close()));
        await runtime.close().catch(() => undefined);
        throw e;
      }
    }));

    const failure = opened.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    for (const r of opened) {
      if (r.status === 'fulfilled') servers.set(r.value.id, r.value);
    }
    if (failure) throw failure.reason;

    rebuildFeatureRoutes();
    rebuild();
  } catch (e) {
    await closeAll();
    throw e;
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
      if (closed || lifetimeSignal.aborted) throw new Error('Durable MCP host is closed');
      for (const s of servers.values()) {
        const reg = s.operations.get(name);
        if (reg) return reg.execute(args, { callId: key }, signal ? { signal } : {});
      }
      const featureReg = featureOperations.get(name);
      if (featureReg) return featureReg.execute(args, { callId: key }, signal ? { signal } : {});
      throw new Error(`Unknown tool: ${name}`);
    },
    async refreshTools(id) {
      const targets = id !== undefined ? [server(id)] : [...servers.values()];
      await Promise.all(targets.map(s => refreshServer(s, lifetimeSignal)));
      rebuild();
    },
    async signIn(id, signal) {
      const s = server(id);
      if (!s.runtime.signIn) throw new Error(`Server ${id} has no sign-in`);
      const sig = signal ? AbortSignal.any([lifetimeSignal, signal]) : lifetimeSignal;
      const result = await s.runtime.signIn(sig);
      s.unsubToolsChanged?.();
      await Promise.allSettled(s.features.map(f => f.close()));
      s.features = [];
      s.authorized = true;
      s.features = await buildFeatures(s);
      await refreshServer(s, sig);
      wireToolsChanged(s);
      rebuildFeatureRoutes();
      rebuild();
      return result;
    },
    async inspectCard(id, signal) {
      const s = server(id);
      if (!s.runtime.inspectCard) throw new Error(`Server ${id} has no server card support`);
      const sig = signal ? AbortSignal.any([lifetimeSignal, signal]) : lifetimeSignal;
      return s.runtime.inspectCard(sig);
    },
    close: closeAll,
  };
}
