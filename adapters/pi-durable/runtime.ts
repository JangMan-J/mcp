import { McpClient, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSION, type ConsentPort, type DiscoverResult, type Outcome, type RequestOptions, type TelemetryPort, type Transport } from "@mcp-client/core";
import { TasksExtension } from "@mcp-client/ext-tasks";
import { StatefulClient, openListenStream } from "@mcp-client/mrtr-cache";
import type { AuthProvider } from "@mcp-client/core";
import { createEventsExtension, openEventsStream, type EventsExtension, type EventsOptions } from "@mcp-client/ext-events";
import { AppsClient, AppsExtension, extractToolAppMeta, type AppRenderPort, type AppViewPayload } from "@mcp-client/ext-apps";
import { createOps, type Ops, type OpsClient } from "@mcp-client/ops";
import { StdioTransport } from "@mcp-client/transport-stdio";
import { HttpTransport } from "@mcp-client/transport-http";
import { createOtelTelemetry, type OtelTelemetryOptions } from "@mcp-client/telemetry-otel";
import { normalizeServer, type ServerDescriptor } from "./config.js";
export { loadServers, normalizeServer, type ServerDescriptor } from "./config.js";
import { createLiveAuth, inspectServerCard } from "./auth.js";
import type { McpToolDescriptor, McpCallToolResult } from "./extension.js";
import type { ToolWire } from "./adapter.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpOutcomeError } from "@mcp-client/core";

export interface RuntimeOptions extends Partial<Parameters<typeof createLiveAuth>[1]> {
  readonly allowLegacyInitialize?: boolean;
  readonly inheritEnv?: boolean | readonly string[];
  readonly signal?: AbortSignal;
  readonly consent?: ConsentPort;
  readonly createTransport?: (descriptor: ServerDescriptor) => Transport | Promise<Transport>;
  readonly resolveProviderToken?: (provider: string) => Promise<string>;
  /** Overrides the descriptor-derived bearer provider (e.g. OAuth from createLiveAuth). */
  readonly authProvider?: AuthProvider;
  /** Enables the MCP Apps extension; without it the extension is neither attached nor advertised. */
  readonly appRenderer?: AppRenderPort;
  readonly telemetry?: TelemetryPort;
  /** OTel tracer/context source; used when `telemetry` is not given. Content capture stays off unless set. */
  readonly otel?: OtelTelemetryOptions;
}

export interface DurableRuntime {
  readonly client: McpClient;
  readonly stateful: StatefulClient;
  readonly eventsExtension: EventsExtension;
  /** events/stream opener sharing the client ID space and transport. */
  readonly openEventsStream: NonNullable<EventsOptions["openStream"]>;
  readonly ops: Ops;
  /** Tasks extension attached to the client before discovery. */
  readonly tasks: TasksExtension;
  readonly capabilities: Record<string, unknown> | undefined;
  /** Present only when `appRenderer` was supplied. */
  readonly apps: AppsClient | undefined;
  /** Load and render a tool's `_meta.ui.resourceUri` view; undefined when apps are off or the tool has no UI. */
  renderToolApp(tool: McpToolDescriptor, signal?: AbortSignal): Promise<Outcome<AppViewPayload> | undefined>;
  readonly transportClosed: AbortSignal;
  ready(signal?: AbortSignal): Promise<Outcome<DiscoverResult>>;
  /** Drop the cached discovery (e.g. after sign-in) and discover again. */
  rediscover(signal?: AbortSignal): Promise<Outcome<DiscoverResult>>;
  listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]>;
  callTool(wire: ToolWire, signal?: AbortSignal): Promise<McpCallToolResult>;
  onToolsChanged(cb: () => unknown): () => void;
  signIn(signal?: AbortSignal): Promise<void>;
  inspectCard(signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export async function openRuntime(
  input: ServerDescriptor | { readonly name: string; readonly [key: string]: unknown },
  opts?: RuntimeOptions,
): Promise<DurableRuntime> {
  const descriptor = input.source && input.trusted !== undefined && (input.transport === "stdio" || input.transport === "http")
    ? input as ServerDescriptor : normalizeServer(input.name, input);
  const closedCtrl = new AbortController();
  // Never default into ~/.pi: without an explicit stateDir, credentials live in a private temp dir removed on close.
  const tempDir = opts?.stateDir ? undefined : await mkdtemp(join(tmpdir(), "pi-durable-"));
  const removeTemp = async () => { if (tempDir) await rm(tempDir, { recursive: true, force: true }); };
  try {
    return await build(descriptor, opts, closedCtrl, opts?.stateDir ?? tempDir!, removeTemp);
  } catch (e) { await removeTemp(); throw e; }
}

async function build(
  descriptor: ServerDescriptor, opts: RuntimeOptions | undefined, closedCtrl: AbortController, stateDir: string, removeTemp: () => Promise<void>,
): Promise<DurableRuntime> {
  const auth = await createLiveAuth(descriptor, { ...opts, stateDir });
  const inherit = descriptor.inheritEnv ?? opts?.inheritEnv;
  const authProvider = opts?.authProvider ?? auth.provider;
  const transport = (await opts?.createTransport?.(descriptor)) ?? (descriptor.transport === "http"
    ? new HttpTransport({
      url: descriptor.url!,
      ...(authProvider ? { authProvider } : {}),
      ...(descriptor.headers ? { extraHeaders: descriptor.headers } : {}),
    })
    : new StdioTransport({
      command: descriptor.command!,
      ...(inherit !== undefined && { inheritEnv: inherit === true ? Object.keys(process.env) : inherit === false ? [] : inherit }),
      ...(descriptor.args ? { args: descriptor.args } : {}),
      ...(descriptor.cwd ? { cwd: descriptor.cwd } : {}),
      ...(descriptor.env ? { env: descriptor.env } : {}),
    }));
  // One ID space for the client and side streams so request IDs never collide on a shared transport.
  let lastId = 0;
  // The first request in this call must use its persisted attempt ID. MRTR continuations get fresh IDs.
  const attempts = new AsyncLocalStorage<{ id?: string }>();
  const idGenerator = () => {
    const attempt = attempts.getStore();
    if (!attempt?.id) return ++lastId;
    const id = attempt.id; delete attempt.id; return id;
  };
  const telemetry = opts?.telemetry ?? (opts?.otel ? createOtelTelemetry(opts.otel) : undefined);
  const timeoutMs = descriptor.timeoutMs ?? (descriptor.timeout !== undefined ? descriptor.timeout * 1000 : undefined);
  const lifetime = opts?.signal ? AbortSignal.any([opts.signal, closedCtrl.signal]) : closedCtrl.signal;
  const consent: ConsentPort | undefined = opts?.consent && {
    request: (prompt, signal) => opts.consent!.request(prompt, AbortSignal.any([signal, lifetime])),
  };
  const client = new McpClient({
    transport,
    idGenerator,
    server: { key: descriptor.name },
    ...(opts?.consent || telemetry ? { ports: {
      ...(consent ? { consent } : {}),
      ...(telemetry ? { telemetry } : {}),
    } } : {}),
    ...(timeoutMs !== undefined ? { defaults: { timeoutMs } } : {}),
  });
  const eventsExt = createEventsExtension({ enabled: true });
  client.use(eventsExt);
  const appsExt = opts?.appRenderer && new AppsExtension({ renderer: opts.appRenderer });
  if (appsExt) client.use(appsExt);
  const stateful = new StatefulClient({
    request: (m, p, o) => client.request(m, p, o),
    serverRef: descriptor.name,
    ...(authProvider && { auth: authProvider }),
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
  const discover = async (signal: AbortSignal): Promise<Outcome<DiscoverResult>> => {
    const out = await client.discover({ signal });
    // Legacy initialize is an opt-in stdio-only fallback for servers that predate server/discover.
    const legacy = descriptor.transport === "stdio" && (descriptor.allowLegacyInitialize ?? opts?.allowLegacyInitialize) === true;
    if (!legacy || out.kind !== "jsonrpc-error" || out.code !== -32601) return out;
    const capabilities = appsExt ? appsExt.capabilities(appsExt.health() === "working") : {};
    const init = await client.request("initialize", { protocolVersion: "2025-11-25", capabilities, clientInfo: { name: "pi-durable", version: "1" } }, { signal });
    if (init.kind === "mrtr-interim") return { kind: "protocol-violation", detail: "unexpected interim initialize result", meta: init.meta };
    if (init.kind !== "ok") return init;
    const { capabilities: serverCaps, protocolVersion } = init.value;
    if (!serverCaps || typeof serverCaps !== "object" || Array.isArray(serverCaps) || typeof protocolVersion !== "string")
      return { kind: "protocol-violation", detail: "invalid initialize result", meta: init.meta };
    await transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, { signal, idempotent: false, timeoutMs: timeoutMs ?? 30_000 });
    return { ...init, value: { ...init.value, capabilities: serverCaps, supportedVersions: [protocolVersion], cacheScope: "private", ttlMs: 0, resultType: "complete" } as DiscoverResult };
  };
  const ready = (signal?: AbortSignal): Promise<Outcome<DiscoverResult>> => (readyPromise ??= discover(signal ? AbortSignal.any([lifetime, signal]) : lifetime).then((disc) => {
    caps = disc.kind === "ok" ? (disc.value.capabilities as Record<string, unknown>) : undefined;
    return disc;
  }));
  const rediscover = (signal?: AbortSignal) => { readyPromise = undefined; return ready(signal); };
  const close = async () => {
    closedCtrl.abort();
    try { await client.close(); } finally { try { await auth.close?.(); } finally { await removeTemp(); } }
  };
  const apps = opts?.appRenderer && new AppsClient({
    ops, renderer: opts.appRenderer, serverLabel: descriptor.name, ...(consent ? { consent } : {}),
  });
  const renderToolApp = async (tool: McpToolDescriptor, signal?: AbortSignal) => {
    const meta = extractToolAppMeta(tool as unknown as Record<string, unknown>);
    if (!apps || !meta) return undefined;
    await ready(signal);
    return apps.loadAppResource(meta, { toolName: tool.name, signal: signal ? AbortSignal.any([signal, lifetime]) : lifetime });
  };
  const signIn = async (signal: AbortSignal = lifetime) => {
    if (!auth.signIn) throw new Error("Server has no interactive sign-in configured");
    await auth.signIn(signal);
    const out = await rediscover(signal);
    if (out.kind !== "ok") throw new Error(`Rediscovery after sign-in failed: ${out.kind}`);
  };
  const inspectCard = (signal: AbortSignal = lifetime) => inspectServerCard(descriptor, AbortSignal.any([signal, lifetime]));
  const listTools = async (signal?: AbortSignal) => {
    const discovery = await ready(signal);
    // Keep an unauthenticated runtime addressable so the operator can sign in and rediscover.
    if (discovery.kind === "auth-unavailable" || discovery.kind === "auth-failure" ||
      (discovery.kind === "transport-failure" && [401, 403].includes(discovery.failure.status ?? 0))) return [];
    if (discovery.kind !== "ok") throw new McpOutcomeError(discovery);
    if (!caps?.tools) return [];
    const result = await ops.tools.listAll(signal ? { signal } : {});
    if (result.kind !== "ok") throw new McpOutcomeError(result);
    return result.value.items.map(({ tool }) => tool as unknown as McpToolDescriptor);
  };
  const callTool = async (wire: ToolWire, signal?: AbortSignal) => {
    if (wire.serverId !== descriptor.name) throw new Error("Tool call server mismatch");
    const out = await attempts.run({ id: wire.requestId }, () => ops.tools.call(wire.toolName, wire.args, signal ? { signal } : {}));
    if (out.kind === "tool-isError") return out.result as McpCallToolResult;
    if (out.kind !== "ok") throw new McpOutcomeError(out);
    return out.value.raw as McpCallToolResult;
  };
  const onToolsChanged = (cb: () => unknown) => {
    if (!(caps?.tools as { listChanged?: boolean } | undefined)?.listChanged || lifetime.aborted) return () => {};
    const stream = stateful.listen({ tools: true });
    const stop = () => stream.close();
    lifetime.addEventListener("abort", stop, { once: true });
    void (async () => {
      await stream.acknowledged;
      for await (const event of stream.events) if (event.method === "notifications/tools/list_changed") await cb();
    })().catch(() => {}).finally(() => { lifetime.removeEventListener("abort", stop); stop(); });
    return stop;
  };
  return { listTools, callTool, onToolsChanged, signIn, inspectCard, client, stateful, eventsExtension: eventsExt, openEventsStream: eventsStream, ops, tasks, get capabilities() { return caps; }, apps, renderToolApp, transportClosed: closedCtrl.signal, ready, rediscover, close };
}

