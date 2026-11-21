import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadLayeredMcpConfig, mcpServerNamespace, resolveServerVariables, type LegacyServerConfig } from "./config.js";
import { createCredentialStore } from "./credentials.js";
import { installHost, type Disposable, type HostPorts, type McpServerPort,
  type McpServerSummary, type PiHostPort, type ServerStatus } from "./host.js";
import { startSession } from "./session.js";
import { createBranchHost, type BranchSessionPort } from "./branch-host.js";
import type { BranchCustomEntry, BranchState } from "./branch.js";
import { installCodingTools, type CodingToolsHost, type HostToolDefinition, type ToolClient,
  type ToolSourceDescriptor } from "./tools.js";
import { createResourceTools } from "./resources.js";
import type { ResourcesApi } from "@mcp-client/ops";

type Client = { close(): void | Promise<void>; ready?(signal: AbortSignal): unknown };
type Project = { readonly configPath: string; readonly trusted: boolean };
type AuthPorts = Pick<HostPorts, "browser" | "consent" | "redirect">;

export interface ClientContext {
  readonly descriptor: LegacyServerConfig;
  readonly signal: AbortSignal;
  readonly trust: boolean;
  readonly credentialStore: ReturnType<typeof createCredentialStore>;
}

export interface CodingAgentAdapterOptions<C extends Client> extends AuthPorts {
  /** Trusted global directory: reads mcp.json and stores adapter credentials separately. */
  readonly configDir: string;
  /** A getter or function is evaluated at session start; untrusted files are never read. */
  readonly project?: Project | (() => Project | undefined);
  /** Snapshot of the host's current registrations, keyed by server name. */
  readonly dynamicServers?: () => Readonly<Record<string, unknown>>;
  readonly createClient: (context: ClientContext) => C | Promise<C>;
  readonly clientStatus?: (client: C) => ServerStatus;
  readonly card?: (descriptor: LegacyServerConfig, signal: AbortSignal) => Promise<unknown>;
  /** Optional typed tool host; needs `toolClient` to adapt session clients. */
  readonly toolHost?: CodingToolsHost;
  /** Adapt a session client to list/call; readiness comes from the session. */
  readonly toolClient?: (client: C) => Pick<ToolClient, "list" | "call">;
  /** Adapt a session client to resources ops; registers native resource tools on `toolHost`. */
  readonly resourcesClient?: (client: C) => ResourcesApi;
  /** Optional branch store; a restored snapshot makes connections lazy. */
  readonly branchStore?: BranchSessionPort;
  /** Called when a lazily restored session first connects a client. */
  readonly reconnect?: (server: string, client: C, branch: BranchState, signal: AbortSignal) => void | Promise<void>;
  readonly signIn?: (context: ClientContext & AuthPorts & { readonly client: C }) => void | Promise<void>;
}

type SessionClient<C extends Client> = { client: C; ready(signal: AbortSignal): Promise<void>; close(): void | Promise<void> };
type Connection<C extends Client> = Awaited<ReturnType<typeof startSession<SessionClient<C>>>>;
interface Active<C extends Client> {
  readonly abort: AbortController;
  readonly handle: Promise<Connection<C>>;
  readonly ready: Promise<Connection<C>>;
  client?: C;
}
interface Server<C extends Client> {
  readonly descriptor: LegacyServerConfig;
  enabled: boolean;
  status: ServerStatus;
  active?: Active<C>;
}

function readConfig(path: string): unknown {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return JSON.parse(text);
}
const readProject = (project: Project | undefined): unknown =>
  project?.trusted === true ? readConfig(project.configPath) : undefined;

/** Compose the command and session ports without importing Pi or registering tools. */
export function installCodingAgentAdapter<C extends Client>(
  host: PiHostPort,
  options: CodingAgentAdapterOptions<C>,
): Disposable & {
  saveBranch(state: BranchState): BranchCustomEntry;
  refreshServers(): Promise<void>;
  refreshTools(): void;
} {
  const { configDir, createClient, clientStatus, card, dynamicServers, signIn, browser, consent, redirect,
    toolHost, toolClient, resourcesClient, branchStore, reconnect } = options;
  // Preserve eager validation for files supplied at install without evaluating a project getter.
  const staticProject = Object.getOwnPropertyDescriptor(options, "project")?.value as CodingAgentAdapterOptions<C>["project"];
  const eagerProject = staticProject !== undefined && typeof staticProject !== "function";
  const globalInput = readConfig(resolve(configDir, "mcp.json"));
  let projectInput = eagerProject ? readProject(staticProject) : undefined;
  const load = (registrations?: Readonly<Record<string, unknown>>) => {
    const loaded = loadLayeredMcpConfig({ globalInput, projectInput, projectTrusted: true,
      ...(registrations !== undefined && { dynamicServers: registrations }) });
    if (loaded.errors.length) throw new TypeError(loaded.errors.join("\n"));
    return loaded.servers.map(descriptor => resolveServerVariables(descriptor, {
      env: process.env, cwd: process.cwd(), disallowShellSubstitution: true,
    }));
  };
  const servers = new Map<string, Server<C>>();
  const closing = new Map<string, Promise<void>>();
  const addServer = (descriptor: LegacyServerConfig): Server<C> => {
    const server: Server<C> = { descriptor, enabled: descriptor.enabled, status: "disconnected" };
    servers.set(descriptor.name, server);
    return server;
  };
  load().forEach(addServer);
  const credentialStore = createCredentialStore(configDir);
  let sessionSignal: AbortSignal | undefined;
  let branch: BranchState | undefined;
  // On a restored branch, servers without direct tools stay unopened until demanded.
  const demand = new Map<string, { open(): void; opened: Promise<void> }>();
  const gate = (id: string) => {
    let entry = demand.get(id);
    if (!entry) {
      let open!: () => void;
      entry = { open, opened: new Promise<void>(resolve => { open = resolve; }) };
      entry.open = open;
      demand.set(id, entry);
    }
    return entry;
  };
  let toolsInstall: Disposable | undefined;
  let resourceRegistrations: Disposable[] = [];

  const context = (descriptor: LegacyServerConfig, signal: AbortSignal): ClientContext =>
    ({ descriptor, signal, trust: descriptor.trusted, credentialStore });
  const summary = (server: Server<C>): McpServerSummary => {
    const client = server.active?.client;
    return { id: server.descriptor.name, enabled: server.enabled,
      status: client && clientStatus ? clientStatus(client) : server.status };
  };
  function requireServer(id: string): Server<C> {
    const server = servers.get(id);
    if (!server) throw new Error(`Unknown MCP server: ${id}`);
    return server;
  }

  async function connect(server: Server<C>, hostSignal: AbortSignal): Promise<void> {
    if (server.active) {
      await server.active.ready.catch(() => undefined);
      return;
    }
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, hostSignal]);
    const { descriptor } = server;
    const previous = closing.get(mcpServerNamespace(descriptor.name));
    const restored = branch;
    server.status = restored ? "disconnected" : "connecting";
    // Keep the handle before readiness so reconnect can abort and close a client still initializing.
    const handle = Promise.resolve().then(async () => {
      await previous;
      signal.throwIfAborted();
      return startSession<SessionClient<C>>([], async (_id, internalSignal) => {
        const combined = AbortSignal.any([signal, internalSignal]);
        combined.throwIfAborted();
        if (server.active === active) server.status = "connecting";
        const client = await createClient(context(descriptor, combined));
        return {
          client, close: () => client.close(),
          async ready() {
            try { await client.ready?.(combined); }
            catch (error) { if (clientStatus?.(client) !== "needs-auth") throw error; }
            combined.throwIfAborted();
            active.client = client;
            if (server.active === active) server.status = "connected";
          },
        };
      }, { ...(restored && { branch: restored }),
        ...(restored && reconnect && { reestablish: (id, { client }, state, s) => reconnect(id, client, state, s) }) });
    });
    const ready = handle.then(async session => {
      signal.throwIfAborted();
      await session.enable(descriptor.name);
      return session;
    });
    const active: Active<C> = { abort, handle, ready };
    server.active = active;
    try { await ready; }
    catch {
      if (server.active !== active) return;
      const cleanup = disconnect(server);
      server.status = signal.aborted ? "disconnected" : "error";
      await cleanup?.catch(() => undefined);
    }
  }

  function disconnect(server: Server<C>): Promise<void> | undefined {
    const key = mcpServerNamespace(server.descriptor.name);
    const active = server.active;
    server.status = "disconnected";
    if (!active) return closing.get(key);
    delete server.active;
    active.abort.abort();
    const closed = active.handle.then(handle => handle.shutdown(), () => undefined).finally(() => {
      if (closing.get(key) === closed) closing.delete(key);
    });
    closing.set(key, closed);
    return closed;
  }

  const withHandle = async <T>(id: string, run: (c: C, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => {
    const server = servers.get(id);
    const active = server?.active;
    if (!server?.enabled || !active) throw new Error(`No session client for server: ${id}`);
    demand.get(id)?.open();
    const handle = await active.ready;
    return handle.run(id, ({ client }, s) => run(client, s), signal
      ? AbortSignal.any([active.abort.signal, signal]) : active.abort.signal);
  };

  function installTools() {
    toolsInstall?.dispose();
    toolsInstall = undefined;
    if (!toolHost || !toolClient || !sessionSignal || sessionSignal.aborted) return;
    const lazyIds: string[] = [];
    const sources: ToolSourceDescriptor[] = Array.from(servers.values())
      .filter(server => server.enabled && server.active && server.descriptor.exposure !== "hidden")
      .map(({ descriptor }) => {
        const lazy = branch !== undefined && descriptor.exposure !== "direct"
          && !Object.values(descriptor.toolExposure ?? {}).includes("direct");
        if (lazy) lazyIds.push(descriptor.name);
        // Hidden overrides pass through; the tools layer drops hidden tools from host, sandbox and tool_search.
        const overrides = Object.entries(descriptor.toolExposure ?? {})
          .map(([k, v]) => [k, { exposure: v }] as const);
        return {
        server: descriptor.name,
        exposure: descriptor.exposure as "direct" | "codemode" | "deferred",
        ...(overrides.length && { tools: Object.fromEntries(overrides) }),
        client: {
          async ready(signal) {
            if (lazy) {
              const opened = gate(descriptor.name);
              await new Promise<void>((resolve, reject) => {
                signal?.throwIfAborted();
                signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
                void opened.opened.then(resolve);
              });
            }
            const active = servers.get(descriptor.name)?.active;
            if (!active) throw new Error(`No session client for server: ${descriptor.name}`);
            await active.ready;
            signal?.throwIfAborted();
          },
          list: (signal) => withHandle(descriptor.name, (c, s) => toolClient(c).list(s), signal),
          call: (tool, args, signal) => withHandle(descriptor.name, (c, s) => toolClient(c).call(tool, args, s), signal),
        },
        }; });
    // tool_search is the explicit demand signal for lazily restored servers.
    const demandAll = () => lazyIds.forEach(id => gate(id).open());
    const gated: CodingToolsHost = { sandbox: toolHost.sandbox, pipeline: toolHost.pipeline, registerTool: def => toolHost.registerTool(def.name !== "tool_search" ? def : {
      ...def,
      ...(def.reachesTools && { reachesTools: (a: unknown, s: AbortSignal) => { demandAll(); return def.reachesTools!(a, s); } }),
      execute: (id, a, s) => { demandAll(); return def.execute(id, a, s); },
    }) };
    toolsInstall = installCodingTools(gated, sources);
  }

  function registerResources() {
    if (!toolHost || !resourcesClient) return;
    const targets = (alias?: string) => Array.from(servers.values())
      .filter(s => s.enabled && s.active && s.descriptor.exposure !== "hidden"
        && (alias === undefined || s.descriptor.name === alias || s.descriptor.aliases?.includes(alias) === true))
      .map(s => s.descriptor.name);
    const tools = createResourceTools(targets, (server, run, signal) =>
      withHandle(server, (c, s) => run(resourcesClient(c), s), signal));
    resourceRegistrations = tools.map(tool =>
      toolHost.registerTool({ ...tool, exposure: "builtin" } as unknown as HostToolDefinition));
  }

  function disposeRegistrations() {
    toolsInstall?.dispose();
    toolsInstall = undefined;
    for (const d of resourceRegistrations.splice(0)) d.dispose();
  }

  async function waitForCloses(work: Iterable<Promise<void> | undefined>) {
    const results = await Promise.allSettled(work);
    const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Adapter session close failed");
  }

  async function shutdown() {
    sessionSignal = undefined;
    disposeRegistrations();
    for (const server of servers.values()) disconnect(server);
    await waitForCloses(closing.values());
  }

  function reconcile(descriptors: readonly LegacyServerConfig[]) {
    const next = new Map(descriptors.map(descriptor => [descriptor.name, descriptor]));
    const removed: (Promise<void> | undefined)[] = [];
    for (const [id, server] of servers) {
      const descriptor = next.get(id);
      if (descriptor && isDeepStrictEqual(server.descriptor, descriptor)
        // Wildcard precedence depends on insertion order.
        && isDeepStrictEqual(Object.keys(server.descriptor.toolExposure ?? {}), Object.keys(descriptor.toolExposure ?? {}))) {
        next.delete(id);
        continue;
      }
      servers.delete(id);
      demand.delete(id);
      removed.push(disconnect(server));
    }
    return { removed, added: Array.from(next.values(), addServer) };
  }

  async function refreshServers() {
    const signal = sessionSignal;
    if (!dynamicServers || !signal || signal.aborted) return;
    const { removed, added } = reconcile(load(dynamicServers()));
    if (removed.length) installTools();
    try {
      await waitForCloses([...removed, ...added.map(server => server.enabled ? connect(server, signal) : undefined)]);
    } finally {
      if (added.length) installTools();
    }
  }

  const port: McpServerPort = {
    list: () => Array.from(servers.values(), summary),
    status(id) {
      const server = servers.get(id);
      return server && summary(server);
    },
    async setEnabled(id, enabled) {
      const server = requireServer(id);
      server.enabled = enabled;
      if (!enabled) {
        const closed = disconnect(server);
        installTools();
        await closed;
      } else if (sessionSignal && !sessionSignal.aborted) {
        await connect(server, sessionSignal);
        installTools();
      }
    },
    async reconnect(id, request) {
      const server = requireServer(id);
      const signal = sessionSignal;
      if (!signal || !server.enabled) throw new Error(`No enabled session server: ${id}`);
      request.throwIfAborted();
      signal.throwIfAborted();
      const closed = disconnect(server);
      installTools();
      await closed;
      request.throwIfAborted();
      signal.throwIfAborted();
      if (!server.enabled || servers.get(id) !== server) return;
      try {
        await connect(server, signal);
        if (branch && server.active && servers.get(id) === server) await withHandle(id, async () => {}, request);
        request.throwIfAborted();
      } finally {
        installTools();
      }
    },
    ...(card && { card: (id: string, signal: AbortSignal) => card(requireServer(id).descriptor, signal) }),
    async signIn(id, request) {
      const server = requireServer(id);
      if (!signIn) throw new Error("MCP sign-in is unavailable");
      if (!sessionSignal) throw new Error(`No session client for server: ${id}`);
      const signal = AbortSignal.any([request, sessionSignal]);
      signal.throwIfAborted();
      await withHandle(id, async (client, operationSignal) => signIn({
        ...context(server.descriptor, operationSignal), client,
        ...(browser && { browser }), ...(consent && { consent }), ...(redirect && { redirect }),
      }), signal);
      installTools();
    },
    async start(signal) {
      if (sessionSignal) await shutdown();
      if (signal.aborted) return;
      if (!eagerProject) {
        const project = options.project;
        projectInput = readProject(typeof project === "function" ? project() : project);
      }
      await waitForCloses(reconcile(load(dynamicServers?.())).removed);
      if (signal.aborted) return;
      sessionSignal = signal;
      demand.clear();
      branch = branchStore && createBranchHost(branchStore).restoreBranch();
      await Promise.all(Array.from(servers.values(), server => server.enabled ? connect(server, signal) : undefined));
      if (signal.aborted) return;
      registerResources();
      installTools();
    },
    shutdown,
  };
  const branchHost = branchStore && createBranchHost(branchStore);
  /** Append an allowlisted, namespaced branch snapshot via the branch store. */
  const saveBranch = (state: BranchState): BranchCustomEntry => {
    if (!branchHost) throw new Error("No branch store configured");
    return branchHost.appendEntry(state);
  };
  return Object.assign(installHost({ host, servers: port }), { saveBranch, refreshServers, refreshTools: installTools });
}
