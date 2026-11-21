import type { Outcome } from "@mcp-client/core";
import { runNestedTool, type HostToolPipeline, type NestedToolCall } from "./pipeline.ts";
import { createDeferredToolRegistry, type SearchableTool } from "./registry.ts";
import { renderOutcome } from "./results.ts";
import { toolName } from "./tool-name.ts";

export type Exposure = "direct" | "codemode" | "deferred";
export type ExposureWithHidden = Exposure | "hidden";
export type Disposable = { dispose(): void };

export interface ToolAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolNamespace {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly instructions?: string;
}

export interface RemoteTool extends SearchableTool {
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: ToolAnnotations;
}
export interface ToolClient {
  ready(signal?: AbortSignal): Promise<void>;
  list(signal?: AbortSignal): Promise<readonly RemoteTool[]>;
  call(tool: string, args: unknown, signal: AbortSignal): Promise<Outcome<unknown>>;
}
export interface ToolSourceDescriptor {
  readonly server: string;
  readonly client: ToolClient;
  readonly exposure?: ExposureWithHidden;
  /** Per-tool overrides keyed by remote tool name. */
  readonly tools?: Readonly<Record<string, { alias?: string; exposure?: ExposureWithHidden }>>;
  readonly toolExposure?: Readonly<Record<string, ExposureWithHidden>>;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly instructions?: string;
}

export type ToolResult = Awaited<ReturnType<typeof renderOutcome>>;
export interface HostToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly outputSchema?: unknown;
  readonly annotations?: ToolAnnotations;
  readonly namespace?: ToolNamespace;
  readonly exposure: Exposure | "builtin";
  /** Destinations (tool names) a call may reach, resolved before execution for permission checks. */
  reachesTools?(args: unknown, signal: AbortSignal): Promise<readonly string[]>;
  execute(toolCallId: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
}
export interface CodingToolsHost {
  registerTool(def: HostToolDefinition): Disposable;
  /** Host codemode sandbox binding; the adapter never implements one. */
  sandbox: { bind(name: string, fn: (args: unknown, ctx: { parentToolCallId: string; signal?: AbortSignal }) => Promise<unknown>): Disposable };
  pipeline: HostToolPipeline<NestedToolCall, ToolResult>;
}

interface Entry { name: string; remote: string; source: ToolSourceDescriptor; tool: RemoteTool; exposure: Exposure }

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map(s => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${escaped}$`);
}

export function resolveToolConfig(
  source: ToolSourceDescriptor,
  tool: RemoteTool,
): { alias: string; exposure: ExposureWithHidden } {
  const exact = source.tools?.[tool.name];
  const alias = exact?.alias ?? tool.name;

  const exactExposure = exact?.exposure ?? source.toolExposure?.[tool.name];
  if (exactExposure !== undefined) return { alias, exposure: exactExposure };

  if (source.tools) {
    for (const [pattern, override] of Object.entries(source.tools)) {
      if (!pattern.includes("*") || override.exposure === undefined) continue;
      if (globToRegExp(pattern).test(tool.name)) return { alias, exposure: override.exposure };
    }
  }

  if (source.toolExposure) {
    for (const [pattern, exposure] of Object.entries(source.toolExposure)) {
      if (!pattern.includes("*")) continue;
      if (globToRegExp(pattern).test(tool.name)) return { alias, exposure };
    }
  }

  return { alias, exposure: source.exposure ?? "direct" };
}

function matchesNamespace(source: ToolSourceDescriptor, ns: string): boolean {
  return source.server === ns || `mcp__${source.server}` === ns || source.aliases?.includes(ns) === true;
}

export function installCodingTools(host: CodingToolsHost, sources: readonly ToolSourceDescriptor[]): Disposable {
  const disposables: Disposable[] = [];

  const abort = new AbortController();
  const live = () => {
    if (abort.signal.aborted) throw new Error("MCP tools adapter disposed; tool invocation blocked");
  };

  /** Raw CallToolResult for codemode; every other outcome is a thrown, non-retried error. */
  const rawResult = (name: string, outcome: Outcome<unknown>): unknown => {
    switch (outcome.kind) {
      case "ok": return outcome.value;
      case "tool-isError": return outcome.result;
      case "uncertain-write":
        throw new Error(`${name}: uncertain write; it may or may not have run. Not retried; check its effects before retrying.`);
      case "jsonrpc-error": throw new Error(`${name}: JSON-RPC error ${outcome.code}: ${outcome.message}`);
      case "transport-failure": throw new Error(`${name}: transport failure (${outcome.failure.kind}): ${outcome.failure.message}`);
      default: throw new Error(`${name}: MCP outcome ${outcome.kind}`);
    }
  };

  const define = (e: Entry) => {
    if (abort.signal.aborted) return;
    const namespace: ToolNamespace = {
      name: `mcp__${e.source.server}`,
      ...(e.source.aliases ? { aliases: e.source.aliases } : {}),
      ...(e.source.description !== undefined ? { description: e.source.description } : {}),
      ...(e.source.instructions !== undefined ? { instructions: e.source.instructions } : {}),
    };
    disposables.push(host.registerTool({
      name: e.name, exposure: e.exposure,
      ...(e.tool.description !== undefined ? { description: e.tool.description } : {}),
      ...(e.tool.inputSchema !== undefined ? { parameters: e.tool.inputSchema } : {}),
      ...(e.tool.outputSchema !== undefined ? { outputSchema: e.tool.outputSchema } : {}),
      ...(e.tool.annotations !== undefined ? { annotations: e.tool.annotations } : {}),
      namespace,
      execute: async (_id, args, signal) => {
        live();
        return renderOutcome(await e.source.client.call(e.remote, args, signal), { server: e.source.server });
      },
    }));
    // Every non-hidden tool is callable from codemode, whatever its model-facing exposure.
    disposables.push(host.sandbox.bind(e.name, async (args, ctx) => {
      live();
      const call = { parentToolCallId: ctx.parentToolCallId, name: e.name, arguments: args };
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
      const result = await runNestedTool(host.pipeline, call, signal);
      live();
      return rawResult(e.name, result.details.outcome);
    }));
  };

  const registries = sources.map(source => ({
    source,
    registry: createDeferredToolRegistry<RemoteTool & { remote: string }>(
      [{
        server: source.server,
        ready: signal => source.client.ready(signal),
        async listDeferredTools(signal) {
          const tools = await source.client.list(signal);
          return tools
            .map(t => ({ tool: t, cfg: resolveToolConfig(source, t) }))
            .filter(({ cfg }) => cfg.exposure === "deferred")
            .map(({ tool, cfg }) => ({ ...tool, name: cfg.alias, remote: tool.name }));
        },
      }],
      ({ server, tool }) => {
        define({ name: toolName(server, tool.name), remote: tool.remote, source, tool, exposure: "deferred" });
      },
    ),
  }));

  const searchArgs = (args: unknown): { query: string; namespace?: string } => {
    const obj = args as { query?: unknown; namespace?: unknown } | null | undefined;
    const q = String(obj?.query ?? "");
    const ns = typeof obj?.namespace === "string" && obj.namespace.length > 0 ? obj.namespace : undefined;
    return ns !== undefined ? { query: q, namespace: ns } : { query: q };
  };
  const searchDeferred = (args: unknown, signal: AbortSignal) => {
    const { query: q, namespace } = searchArgs(args);
    const targets = namespace !== undefined
      ? registries.filter(r => matchesNamespace(r.source, namespace))
      : registries;
    return Promise.all(targets.map(r => r.registry.search(q, signal))).then(lists => lists.flat());
  };

  disposables.push(host.registerTool({
    name: "tool_search", description: "Search deferred MCP tools by name or description.", exposure: "builtin",
    reachesTools: async (args, signal) => (await searchDeferred(args, signal)).map(d => d.name),
    execute: async (_id, args, signal) => {
      live();
      const found = await searchDeferred(args, signal);
      const text = found.map(d => `${d.name}${d.tool.description ? `: ${d.tool.description}` : ""}`).join("\n");
      return renderOutcome({ kind: "ok", value: text || "No matching tools.", meta: { requestId: 0, method: "tool_search", binding: "local", attempts: 0 } } as Outcome<string>);
    },
  }));

  // Direct/codemode tools are registered once their client is ready.
  disposables.push({ dispose: () => abort.abort() });
  for (const source of sources) {
    void (async () => {
      await source.client.ready(abort.signal);
      for (const tool of await source.client.list(abort.signal)) {
        const { alias, exposure } = resolveToolConfig(source, tool);
        if (exposure === "hidden" || exposure === "deferred") continue;
        define({ name: toolName(source.server, alias), remote: tool.name, source, tool, exposure });
      }
    })().catch(() => {});
  }
  return { dispose: () => disposables.splice(0).forEach(d => d.dispose()) };
}
