import { McpClient, type ConsentPort, type DiscoverResult, type Outcome, type RequestOptions, type Transport } from "@mcp-client/core";
import { StatefulClient } from "@mcp-client/mrtr-cache";
import { createOps, type Ops } from "@mcp-client/ops";
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
}

export interface LiveMcpServerRuntime {
  readonly client: McpClient;
  readonly stateful: StatefulClient;
  readonly ops: Ops;
  readonly capabilities: Record<string, unknown> | undefined;
  readonly transportClosed: AbortSignal;
  ready(signal?: AbortSignal): Promise<Outcome<DiscoverResult>>;
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
      ...(descriptor.auth && opts?.resolveProviderToken
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
  const client = new McpClient({
    transport,
    server: { key: descriptor.name },
    ...(opts?.consent ? { ports: { consent: cancellableConsentPort(opts.consent, opts.signal) } } : {}),
    ...(descriptor.timeout !== undefined ? { defaults: { timeoutMs: descriptor.timeout * 1000 } } : {}),
  });
  const stateful = new StatefulClient({
    request: (m, p, o) => client.request(m, p, o),
    serverRef: descriptor.name,
    serverLabel: descriptor.name,
    transportClosed: closedCtrl.signal,
  });
  let caps: Record<string, unknown> | undefined;
  const ops = createOps(client, { capabilities: () => caps, serverTrusted: descriptor.trusted });
  let readyPromise: Promise<Outcome<DiscoverResult>> | undefined;
  const ready = (signal?: AbortSignal): Promise<Outcome<DiscoverResult>> => (readyPromise ??= Promise.resolve(client.discover(signal ? { signal } : undefined)).then((disc) => {
    caps = disc.kind === "ok" ? (disc.value.capabilities as Record<string, unknown>) : undefined;
    return disc;
  }));
  const close = async () => { closedCtrl.abort(); await client.close(); };
  return { client, stateful, ops, get capabilities() { return caps; }, transportClosed: closedCtrl.signal, ready, close };
}

export interface PiExtensionAPI {
  registerCommand(name: "mcp", cmd: { description: string; handler(args: string, ctx: { ui: { notify(msg: string, type?: "info" | "warning" | "error"): void }; signal?: AbortSignal }): Promise<void> }): void;
  registerTool(def: Record<string, unknown>): void;
  on(event: string, handler: (event: any, ctx: any) => unknown): () => void;
  getAllTools?(): readonly { name: string; reachesTools?: (input: Record<string, unknown>) => "all" | readonly string[] }[];
}

export interface PiMcpExtensionOptions {
  readonly configDir: string;
  readonly project?: { readonly configPath: string; readonly trusted: boolean };
  readonly createTransport?: (descriptor: LegacyServerConfig) => Transport | Promise<Transport>;
  readonly resolveProviderToken?: (provider: string) => Promise<string>;
  readonly consent?: ConsentPort;
  readonly branchStore?: BranchSessionPort;
  readonly sandbox?: CodingToolsHost["sandbox"];
  readonly pipeline?: CodingToolsHost["pipeline"];
}

export function createPiMcpExtension(options: PiMcpExtensionOptions): (pi: PiExtensionAPI) => void {
  return (pi: PiExtensionAPI) => {
    const activeServers = new Map<string, LegacyServerConfig>();
    const pendingReady = new Set<Promise<unknown>>();
    const host: PiHostPort = {
      disableBuiltin: () => ({ dispose() {} }),
      registerCommand: (_name, def) => {
        pi.registerCommand("mcp", {
          description: def.description,
          handler: (args, ctx) => def.handler(args, { notify: (m, k) => ctx.ui.notify(m, k), ...(ctx.signal ? { signal: ctx.signal } : {}) }),
        });
        return { dispose() {} };
      },
      on: (ev: PiSessionEvent, h: PiSessionHandler) => {
        const unsub = pi.on(ev, (_e, ctx) => h({ notify: (m, k) => ctx?.ui?.notify?.(m, k) } as McpCommandContext));
        return { dispose: typeof unsub === "function" ? unsub : () => {} };
      },
    };
    const toolHost: CodingToolsHost = {
      sandbox: options.sandbox ?? { bind: () => ({ dispose() {} }) },
      pipeline: options.pipeline ?? (async () => { throw new Error("No host pipeline configured"); }),
      registerTool: (def) => {
        const reg = {
          ...def,
          label: def.name,
          parameters: def.parameters ?? { type: "object", properties: {} },
          ...(def.name === "tool_search" ? { reachesTools: () => "all" as const } : { outputSchema: def.outputSchema ?? createCallToolResultSchema() }),
          execute: (id: string, params: unknown, signal: AbortSignal | undefined) => def.execute(id, params, signal ?? new AbortController().signal),
        };
        pi.registerTool(reg);
        return { dispose() { pi.registerTool({ ...reg, exposure: "hidden" }); } };
      },
    };
    installCodingAgentAdapter<LiveMcpServerRuntime>(host, {
      configDir: options.configDir,
      ...(options.project ? { project: options.project } : {}),
      ...(options.consent ? { consent: options.consent } : {}),
      ...(options.branchStore ? { branchStore: options.branchStore } : {}),
      createClient: async (ctx) => {
        const rt = await createLiveMcpServerRuntime(ctx.descriptor, {
          signal: ctx.signal,
          ...(options.consent ? { consent: options.consent } : {}),
          ...(options.createTransport ? { createTransport: options.createTransport } : {}),
          ...(options.resolveProviderToken ? { resolveProviderToken: options.resolveProviderToken } : {}),
        });
        activeServers.set(ctx.descriptor.name, ctx.descriptor);
        const p = rt.ready(ctx.signal).finally(() => pendingReady.delete(p));
        pendingReady.add(p);
        await p;
        return { ...rt, close: async () => { activeServers.delete(ctx.descriptor.name); await rt.close(); } };
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
