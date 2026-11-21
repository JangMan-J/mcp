import { McpClient, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSION, type ConsentPort, type DiscoverResult, type Outcome, type RequestOptions, type TelemetryPort, type Transport } from "@mcp-client/core";
import { TasksExtension } from "@mcp-client/ext-tasks";
import { StatefulClient, openListenStream } from "@mcp-client/mrtr-cache";
import type { AuthProvider } from "@mcp-client/core";
import { createEventsExtension, openEventsStream, type EventsExtension, type EventsOptions } from "@mcp-client/ext-events";
import type { Extension } from "@mcp-client/core";
import type { AppRenderPort } from "@mcp-client/ext-apps";
import { createOps, type Ops, type OpsClient } from "@mcp-client/ops";
import { StdioTransport } from "@mcp-client/transport-stdio";
import { HttpTransport } from "@mcp-client/transport-http";
import { ConfiguredBearer } from "@mcp-client/auth";
import { installCodingAgentAdapter } from "./adapter.js";
import type { BranchSessionPort } from "./branch-host.js";
import type { LegacyServerConfig } from "./config.js";
import type { McpCommandContext, PiHostPort, PiSessionEvent, PiSessionHandler } from "./host.js";
import { cancellableConsentPort } from "./pipeline.js";
import { createCallToolResultSchema } from "./results.js";
import type { CodingToolsHost } from "./tools.js";

export interface LiveRuntimeOptions {
  readonly signal?: AbortSignal;
  readonly consent?: ConsentPort;
  readonly createTransport?: (descriptor: LegacyServerConfig) => Transport | Promise<Transport>;
  readonly resolveProviderToken?: (provider: string) => Promise<string>;
  /** Overrides the descriptor-derived bearer provider (e.g. OAuth from createLiveAuth). */
  readonly authProvider?: AuthProvider;
  /** Optional extra client extension, e.g. AppsExtension. */
  readonly apps?: Extension;
  readonly telemetry?: TelemetryPort;
}

export interface LiveMcpServerRuntime {
  readonly client: McpClient;
  readonly stateful: StatefulClient;
  readonly eventsExtension: EventsExtension;
  /** events/stream opener sharing the client ID space and transport. */
  readonly openEventsStream: NonNullable<EventsOptions["openStream"]>;
  readonly ops: Ops;
  /** Tasks extension attached to the client before discovery. */
  readonly tasks?: TasksExtension;
  readonly capabilities: Record<string, unknown> | undefined;
  readonly transportClosed: AbortSignal;
  ready(signal?: AbortSignal): Promise<Outcome<DiscoverResult>>;
  /** Drop the cached discovery (e.g. after sign-in) and discover again. */
  rediscover(signal?: AbortSignal): Promise<Outcome<DiscoverResult>>;
  close(): Promise<void>;
}

export async function createLiveMcpServerRuntime(
  descriptor: LegacyServerConfig,
  opts?: LiveRuntimeOptions,
): Promise<LiveMcpServerRuntime> {
  const closedCtrl = new AbortController();
  const transport = (await opts?.createTransport?.(descriptor)) ?? (descriptor.transport === "http"
    ? new HttpTransport({
      url: descriptor.url!,
      ...(opts?.authProvider ? { authProvider: opts.authProvider } : descriptor.auth && opts?.resolveProviderToken
        ? { authProvider: new ConfiguredBearer({ resource: descriptor.url!, token: () => opts.resolveProviderToken!(descriptor.auth!.provider), allowInsecureDev: true }) }
        : {}),
      ...(descriptor.headers ? { extraHeaders: descriptor.headers } : {}),
    })
    : new StdioTransport({
      command: descriptor.command!,
      ...(descriptor.args ? { args: descriptor.args } : {}),
      ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
      ...(descriptor.env ? { env: descriptor.env } : {}),
    }));
  // One ID space for the client and side streams so request IDs never collide on a shared transport.
  let lastId = 0;
  const idGenerator = () => ++lastId;
  const timeoutMs = descriptor.timeoutMs ?? (descriptor.timeout !== undefined ? descriptor.timeout * 1000 : undefined);
  const client = new McpClient({
    transport,
    idGenerator,
    server: { key: descriptor.name },
    ...(opts?.consent || opts?.telemetry ? { ports: {
      ...(opts.consent ? { consent: cancellableConsentPort(opts.consent, opts.signal) } : {}),
      ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
    } } : {}),
    ...(timeoutMs !== undefined ? { defaults: { timeoutMs } } : {}),
  });
  const eventsExt = createEventsExtension({ enabled: true });
  client.use(eventsExt);
  if (opts?.apps) client.use(opts.apps);
  const consent = opts?.consent ? cancellableConsentPort(opts.consent, opts.signal) : undefined;
  const stateful = new StatefulClient({
    request: (m, p, o) => client.request(m, p, o),
    serverRef: descriptor.name,
    serverLabel: descriptor.name,
    transportClosed: closedCtrl.signal,
    subscriptions: {
      open: openListenStream(transport, idGenerator),
      binding: descriptor.transport === "http" ? "streamable-http" : "stdio",
    },
    ...(consent ? {
      port: {
        url: async (r, s) => (await consent.request({ kind: "url-elicitation", serverLabel: r.serverLabel, url: r.url, message: r.message }, s)).decision,
        form: async (r, s) => {
          const res = await consent.request({ kind: "form-elicitation", serverLabel: r.serverLabel, message: r.message, schema: r.schema }, s);
          return res.decision === "accept" ? { action: "accept", content: res.content ?? {} } : { action: res.decision };
        },
      },
      // ## YAGNI: the consent port owns opening the page; MRTR only needs a browser to declare url mode.
      browser: { open: async () => {} },
    } : {}),
  });
  let caps: Record<string, unknown> | undefined;
  const tasks = new TasksExtension({
    serverKey: descriptor.name,
    peerCapabilities: () => caps ?? {},
    request: (method, params, options) => stateful.request(method, params, options) as PromiseLike<Outcome<unknown>>,
  });
  client.use(tasks);
  const mrtrMethods = new Set(["tools/call", "prompts/get", "resources/read"]);
  // MRTR-capable methods go through StatefulClient (input_required -> consent -> retry); the rest stay on the raw client.
  const opsClient: OpsClient = {
    request: ((method: string, params?: Record<string, unknown>, o?: RequestOptions) => {
      if (!mrtrMethods.has(method)) return client.request(method, params, o);
      const ac = new AbortController();
      const p = stateful.request(method, params, { ...o, signal: o?.signal ? AbortSignal.any([o.signal, ac.signal]) : ac.signal });
      const none = { async *[Symbol.asyncIterator]() {} };
      return { id: 0, progress: none, notifications: none, signal: ac.signal, cancel: () => ac.abort(), then: p.then.bind(p) };
    }) as OpsClient["request"],
  };
  const eventsStream = openEventsStream(transport, idGenerator, () => {
    // Merge extension maps explicitly so events and tasks both appear in the side-stream capabilities.
    const ev = eventsExt.capabilities(true) as { extensions?: Record<string, unknown> };
    const tk = tasks.capabilities(true) as { extensions?: Record<string, unknown> };
    return {
      [META_PROTOCOL_VERSION]: SUPPORTED_PROTOCOL_VERSION,
      [META_CLIENT_CAPABILITIES]: { ...ev, ...tk, extensions: { ...ev.extensions, ...tk.extensions } },
    };
  });
  const ops = createOps(opsClient, { capabilities: () => caps, serverTrusted: descriptor.trusted });
  let readyPromise: Promise<Outcome<DiscoverResult>> | undefined;
  const ready = (signal?: AbortSignal): Promise<Outcome<DiscoverResult>> => (readyPromise ??= Promise.resolve(client.discover(signal ? { signal } : undefined)).then((disc) => {
    caps = disc.kind === "ok" ? (disc.value.capabilities as Record<string, unknown>) : undefined;
    return disc;
  }));
  const rediscover = (signal?: AbortSignal) => { readyPromise = undefined; return ready(signal); };
  const close = async () => { closedCtrl.abort(); await client.close(); };
  return { client, stateful, eventsExtension: eventsExt, openEventsStream: eventsStream, ops, tasks, get capabilities() { return caps; }, transportClosed: closedCtrl.signal, ready, rediscover, close };
}

export interface PiExtensionAPI {
  registerCommand(name: string, cmd: { description: string; handler(args: string, ctx: { ui: { notify(msg: string, type?: "info" | "warning" | "error"): void }; signal?: AbortSignal }): Promise<void> }): void;
  registerTool(def: Record<string, unknown>): void;
  on(event: string, handler: (event: any, ctx: any) => unknown): () => void;
  getActiveTools?(): string[];
  setActiveTools?(names: string[]): void;
  getAllTools?(): readonly { name: string; reachesTools?: (input: Record<string, unknown>) => "all" | readonly string[] }[];
  sendMessage?(message: { customType: string; content: string; display: boolean }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void;
  appendEntry?(customType: string, data?: unknown): void;
  /** Host-registered MCP servers; changes arrive as the `mcp_servers_change` event. */
  getMcpServers?(): readonly ({ name: string } & Record<string, unknown>)[];
}

/** Host handed to feature factories (core/events/extended); each returns a per-server connector. */
export interface PiFeatureHost {
  registerTool(def: object): void;
  registerCommand(name: string, cmd: { description: string; handler(args: string, ctx: { notify(msg: string, type?: "info" | "warning" | "error"): void; signal?: AbortSignal }): Promise<void> }): void;
  wake(server: string, reason: string): void;
  refreshTools(): void;
  getBranch(): readonly unknown[];
  appendEntry(customType: string, data: unknown): void;
  readonly consent?: ConsentPort;
  readonly configDir: string;
  readonly appRenderer?: AppRenderPort;
}
export interface PiFeatureConnector {
  connect(rt: LiveMcpServerRuntime, descriptor: LegacyServerConfig, signal: AbortSignal): unknown;
}
export interface PiLiveAuth {
  readonly provider?: AuthProvider;
  signIn?(signal: AbortSignal): Promise<void>;
  close?(): void | Promise<void>;
}

export interface PiMcpExtensionOptions {
  readonly configDir: string;
  readonly project?: Project | (() => Project | undefined);
  readonly dynamicServers?: () => Readonly<Record<string, unknown>>;
  /** Feature factories, injected so standalone tests stay independent of feature modules. */
  readonly features?: readonly ((host: PiFeatureHost) => PiFeatureConnector)[];
  readonly createAuth?: (descriptor: LegacyServerConfig, ctx: { signal: AbortSignal; credentialStore: unknown }) => Promise<PiLiveAuth>;
  readonly appRenderer?: AppRenderPort;
  readonly card?: (descriptor: LegacyServerConfig, signal: AbortSignal) => Promise<unknown>;
  /** Receives the latest Pi context (commands/events) for UI-bound ports. */
  readonly onContext?: (ctx: unknown) => void;
  /** Optional telemetry port per server (e.g. createOtelTelemetry); receives the latest Pi context. */
  readonly createOtelTelemetry?: (descriptor: LegacyServerConfig, options: { context: unknown }) => TelemetryPort | undefined;
  readonly createTransport?: (descriptor: LegacyServerConfig) => Transport | Promise<Transport>;
  readonly resolveProviderToken?: (provider: string) => Promise<string>;
  readonly consent?: ConsentPort;
  readonly branchStore?: BranchSessionPort;
  readonly sandbox?: CodingToolsHost["sandbox"];
  readonly pipeline?: CodingToolsHost["pipeline"];
}

type Project = { readonly configPath: string; readonly trusted: boolean };

export function createPiMcpExtension(options: PiMcpExtensionOptions): (pi: PiExtensionAPI) => void {
  return (pi: PiExtensionAPI) => {
    const activeServers = new Map<string, LegacyServerConfig>();
    const pendingReady = new Set<Promise<unknown>>();
    const seen = (ctx: unknown) => { if (ctx) options.onContext?.(ctx); lastCtx = ctx; };
    let lastCtx: any;
    let installed: { refreshTools(): void; refreshServers(): Promise<void> } | undefined;
    // Pi passes (toolCallId, params, signal, onUpdate, ctx); surface ctx to UI-bound ports.
    const withCtx = <F extends (...a: any[]) => unknown>(exec: F) =>
      (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate?: unknown, ctx?: unknown) => { if (ctx) seen(ctx); return exec(id, params, signal ?? new AbortController().signal, onUpdate, ctx); };
    const featureHost: PiFeatureHost = {
      registerTool: (def) => {
        const exec = (def as { execute?: (...a: any[]) => unknown }).execute;
        pi.registerTool({ label: (def as { name?: unknown }).name, ...def, ...(exec ? { execute: withCtx(exec) } : {}) });
      },
      registerCommand: (name, def) => pi.registerCommand(name, {
        description: def.description,
        handler: (args, ctx) => { seen(ctx); return def.handler(args, { notify: (m, k) => ctx.ui.notify(m, k), ...(ctx.signal ? { signal: ctx.signal } : {}) }); },
      }),
      // Server notifications wake the agent: start a turn when idle, otherwise follow up after the current one.
      wake: (server, reason) => pi.sendMessage?.({ customType: "mcp-wake", content: `[MCP ${server}] ${reason}`, display: true }, { triggerTurn: true, deliverAs: "followUp" }),
      refreshTools: () => installed?.refreshTools(),
      getBranch: () => lastCtx?.sessionManager?.getBranch?.() ?? [],
      appendEntry: (type, data) => pi.appendEntry?.(type, data),
      ...(options.consent ? { consent: options.consent } : {}),
      configDir: options.configDir,
      ...(options.appRenderer ? { appRenderer: options.appRenderer } : {}),
    };
    const connectors = (options.features ?? []).map(f => f(featureHost));
    const host: PiHostPort = {
      disableBuiltin: () => ({ dispose() {} }),
      registerCommand: (_name, def) => {
        pi.registerCommand("mcp", {
          description: def.description,
          handler: (args, ctx) => (seen(ctx), def.handler)(args, { notify: (m, k) => ctx.ui.notify(m, k), ...(ctx.signal ? { signal: ctx.signal } : {}) }),
        });
        return { dispose() {} };
      },
      on: (ev: PiSessionEvent, h: PiSessionHandler) => {
        const unsub = pi.on(ev, (_e, ctx) => (seen(ctx), h)({ notify: (m, k) => ctx?.ui?.notify?.(m, k) } as McpCommandContext));
        return { dispose: typeof unsub === "function" ? unsub : () => {} };
      },
    };
    const toolHost: CodingToolsHost = {
      sandbox: options.sandbox ?? { bind: () => ({ dispose() {} }) },
      pipeline: options.pipeline ?? (async () => { throw new Error("No host pipeline configured"); }),
      registerTool: (def) => {
        const reg = {
          ...def,
          // Pi at the pin has no "builtin" exposure; adapter-internal builtins stay model-visible as "direct".
          exposure: def.exposure === "builtin" ? "direct" : def.exposure,
          label: def.name,
          parameters: def.parameters ?? { type: "object", properties: {} },
          ...(def.name === "tool_search" ? { reachesTools: () => "all" as const } : { outputSchema: def.outputSchema ?? createCallToolResultSchema() }),
          execute: withCtx((id: string, params: unknown, signal: AbortSignal) => def.execute(id, params, signal)),
        };
        pi.registerTool(reg);
        // Pi never activates deferred tools on registration; they register only once tool_search matches them, so declare them to the model now.
        if (reg.exposure === "deferred" && pi.getActiveTools && pi.setActiveTools) {
          const active = pi.getActiveTools();
          if (!active.includes(def.name)) pi.setActiveTools([...active, def.name]);
        }
        return { dispose() { pi.registerTool({ ...reg, exposure: "hidden" }); } };
      },
    };
    type LiveClient = LiveMcpServerRuntime & { auth?: PiLiveAuth; reconnect?(signal: AbortSignal): Promise<void> };
    const piServers = pi.getMcpServers
      ? () => Object.fromEntries(pi.getMcpServers!().map(({ name, ...cfg }) => [name, cfg]))
      : undefined;
    const dynamicServers = options.dynamicServers && piServers
      ? () => ({ ...piServers(), ...options.dynamicServers!() })
      : options.dynamicServers ?? piServers;
    installed = installCodingAgentAdapter<LiveClient>(host, {
      configDir: options.configDir,
      ...(dynamicServers ? { dynamicServers } : {}),
      ...(options.card ? { card: options.card } : {}),
      signIn: async ({ client, signal }) => {
        if (!client.auth?.signIn) throw new Error("Server has no interactive sign-in configured");
        await client.auth.signIn(signal);
        // Fresh discovery, feature connectors and tool list so everything reflects the authorized session.
        await client.reconnect?.(signal);
        installed?.refreshTools();
      },
      ...(options.project ? { project: options.project } : {}),
      ...(options.consent ? { consent: options.consent } : {}),
      ...(options.branchStore ? { branchStore: options.branchStore } : {}),
      createClient: async (ctx) => {
        const auth = await options.createAuth?.(ctx.descriptor, { signal: ctx.signal, credentialStore: ctx.credentialStore });
        const telemetry = options.createOtelTelemetry?.(ctx.descriptor, { context: lastCtx });
        const rt = await createLiveMcpServerRuntime(ctx.descriptor, {
          signal: ctx.signal,
          ...(telemetry ? { telemetry } : {}),
          ...(auth?.provider ? { authProvider: auth.provider } : {}),
          ...(options.consent ? { consent: options.consent } : {}),
          ...(options.createTransport ? { createTransport: options.createTransport } : {}),
          ...(options.resolveProviderToken ? { resolveProviderToken: options.resolveProviderToken } : {}),
        });
        activeServers.set(ctx.descriptor.name, ctx.descriptor);
        const p = rt.ready(ctx.signal).finally(() => pendingReady.delete(p));
        pendingReady.add(p);
        // Connect features only for successful discovery of model-visible servers.
        const connect = (disc: Outcome<DiscoverResult>) => {
          if (disc.kind !== "ok" || ctx.descriptor.exposure === "hidden") return;
          for (const c of connectors) c.connect(rt, ctx.descriptor, ctx.signal);
        };
        connect(await p);
        return {
          ...rt,
          // Spread copies a snapshot; keep capabilities live.
          get capabilities() { return rt.capabilities; },
          ...(auth ? { auth } : {}),
          reconnect: async (signal: AbortSignal) => connect(await rt.rediscover(signal)),
          close: async () => { activeServers.delete(ctx.descriptor.name); await rt.close(); await auth?.close?.(); },
        };
      },
      toolHost,
      toolClient: (rt) => ({
        list: async (signal) => {
          const out = await rt.ops.tools.listAll(signal ? { signal } : undefined);
          return out.kind === "ok" ? out.value.items.map(i => ({
            name: i.name,
            ...(typeof i.tool.description === "string" ? { description: i.tool.description } : {}),
            ...(i.tool.inputSchema !== undefined ? { inputSchema: i.tool.inputSchema } : {}),
          })) : [];
        },
        call: async (name, args, signal) => {
          const out = await rt.ops.tools.call(name, args, { signal });
          return out.kind === "ok" ? { kind: "ok" as const, value: out.value.raw, meta: out.meta } : out;
        },
      }),
      resourcesClient: (rt) => rt.ops.resources,
    });
    if (pi.getMcpServers) pi.on("mcp_servers_change", () => installed?.refreshServers());
    pi.on("before_agent_start", async (ev: { systemPromptOptions?: { sections?: Record<string, string> } }) => {
      const sections = ev?.systemPromptOptions?.sections;
      if (!sections) return;
      if (activeServers.size === 0) { delete sections["mcp_servers"]; return; }
      sections["mcp_servers"] = Array.from(activeServers.values(), s => `- ${s.name}${s.description ? `: ${s.description}` : ""}`).join("\n");
    });
    pi.on("tool_call", async (ev: { toolName?: string; input?: Record<string, unknown> }) => {
      const name = ev?.toolName;
      if (!name) return;
      const tool = pi.getAllTools?.().find(t => t.name === name);
      if (tool?.reachesTools?.(ev.input ?? {}) || name.startsWith("mcp__") || name === "list_mcp_resources" || name === "list_mcp_resource_templates" || name === "read_mcp_resource" || name === "tool_search") {
        await Promise.allSettled(Array.from(pendingReady));
      }
    });
  };
}

export default createPiMcpExtension;
