import type { Outcome } from "@mcp-client/core";
import { runNestedTool, type HostToolPipeline, type NestedToolCall } from "./pipeline.ts";
import { createDeferredToolRegistry, type SearchableTool } from "./registry.ts";
import { renderOutcome } from "./results.ts";
import { toolName } from "./tool-name.ts";

export type Exposure = "direct" | "codemode" | "deferred";
export type Disposable = { dispose(): void };

export interface RemoteTool extends SearchableTool { readonly inputSchema?: unknown }
export interface ToolClient {
  ready(signal?: AbortSignal): Promise<void>;
  list(signal?: AbortSignal): Promise<readonly RemoteTool[]>;
  call(tool: string, args: unknown, signal: AbortSignal): Promise<Outcome<unknown>>;
}
export interface ToolSourceDescriptor {
  readonly server: string;
  readonly client: ToolClient;
  readonly exposure?: Exposure;
  /** Per-tool overrides keyed by remote tool name. */
  readonly tools?: Readonly<Record<string, { alias?: string; exposure?: Exposure }>>;
}

export type ToolResult = Awaited<ReturnType<typeof renderOutcome>>;
export interface HostToolDefinition {
  readonly name: string;
  readonly description?: string;
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

export function installCodingTools(host: CodingToolsHost, sources: readonly ToolSourceDescriptor[]): Disposable {
  const disposables: Disposable[] = [];
  const cfg = (s: ToolSourceDescriptor, t: RemoteTool) => {
    const o = s.tools?.[t.name];
    return { alias: o?.alias ?? t.name, exposure: o?.exposure ?? s.exposure ?? "direct" };
  };

  const define = (e: Entry) => {
    disposables.push(host.registerTool({
      name: e.name, description: e.tool.description, exposure: e.exposure,
      execute: async (_id, args, signal) => renderOutcome(await e.source.client.call(e.remote, args, signal)),
    }));
    if (e.exposure === "codemode") {
      disposables.push(host.sandbox.bind(e.name, async (args, ctx) => {
        const call = { parentToolCallId: ctx.parentToolCallId, name: e.name, arguments: args };
        return (await runNestedTool(host.pipeline, call, ctx.signal)).details.outcome; // raw, not model text
      }));
    }
  };

  const entryFor = (source: ToolSourceDescriptor, tool: RemoteTool): Entry => {
    const { alias, exposure } = cfg(source, tool);
    return { name: toolName(source.server, alias), remote: tool.name, source, tool, exposure };
  };

  const registry = createDeferredToolRegistry<RemoteTool & { remote: string }>(
    sources.map(source => ({
      server: source.server,
      ready: signal => source.client.ready(signal),
      async listDeferredTools(signal) {
        const tools = await source.client.list(signal);
        return tools.filter(t => cfg(source, t).exposure === "deferred")
          .map(t => ({ ...t, name: cfg(source, t).alias, remote: t.name }));
      },
    })),
    ({ server, tool }) => {
      const source = sources.find(s => s.server === server)!;
      define({ name: toolName(server, tool.name), remote: tool.remote, source, tool, exposure: "deferred" });
    },
  );

  const query = (args: unknown) => String((args as { query?: unknown } | null)?.query ?? "");
  disposables.push(host.registerTool({
    name: "tool_search", description: "Search deferred MCP tools by name or description.", exposure: "builtin",
    reachesTools: async (args, signal) => (await registry.search(query(args), signal)).map(d => d.name),
    execute: async (_id, args, signal) => {
      const found = await registry.search(query(args), signal);
      const text = found.map(d => `${d.name}${d.tool.description ? `: ${d.tool.description}` : ""}`).join("\n");
      return renderOutcome({ kind: "ok", value: text || "No matching tools.", meta: { requestId: 0, method: "tool_search", binding: "local", attempts: 0 } } as Outcome<string>);
    },
  }));

  // Direct/codemode tools are registered once their client is ready.
  const abort = new AbortController();
  disposables.push({ dispose: () => abort.abort() });
  for (const source of sources) {
    void (async () => {
      await source.client.ready(abort.signal);
      for (const tool of await source.client.list(abort.signal)) {
        const e = entryFor(source, tool);
        if (e.exposure !== "deferred" && !abort.signal.aborted) define(e);
      }
    })().catch(() => {});
  }
  return { dispose: () => disposables.splice(0).forEach(d => d.dispose()) };
}
