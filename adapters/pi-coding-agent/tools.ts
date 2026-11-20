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
    disposables.push(host.registerTool({
      name: e.name, exposure: e.exposure,
      ...(e.tool.description !== undefined ? { description: e.tool.description } : {}),
      execute: async (_id, args, signal) => {
        live();
        return renderOutcome(await e.source.client.call(e.remote, args, signal), { server: e.source.server });
      },
    }));
    // Every tool is callable from codemode, whatever its model-facing exposure.
    disposables.push(host.sandbox.bind(e.name, async (args, ctx) => {
      live();
      const call = { parentToolCallId: ctx.parentToolCallId, name: e.name, arguments: args };
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, abort.signal]) : abort.signal;
      const result = await runNestedTool(host.pipeline, call, signal);
      live();
      return rawResult(e.name, result.details.outcome);
    }));
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
      const source = sources.find(s => s.server === server);
      if (!source) return;
      define({ name: toolName(server, tool.name), remote: tool.remote, source, tool, exposure: "deferred" });
    },
  );

  const query = (args: unknown) => String((args as { query?: unknown } | null)?.query ?? "");
  disposables.push(host.registerTool({
    name: "tool_search", description: "Search deferred MCP tools by name or description.", exposure: "builtin",
    reachesTools: async (args, signal) => (await registry.search(query(args), signal)).map(d => d.name),
    execute: async (_id, args, signal) => {
      live();
      const found = await registry.search(query(args), signal);
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
        const e = entryFor(source, tool);
        if (e.exposure !== "deferred") define(e);
      }
    })().catch(() => {});
  }
  return { dispose: () => disposables.splice(0).forEach(d => d.dispose()) };
}
