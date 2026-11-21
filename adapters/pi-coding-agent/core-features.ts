import type { Outcome } from "@mcp-client/core";
import type { ListenFilter, Subscription, SubscriptionManager } from "@mcp-client/mrtr-cache";
import { isObj, localMeta, type Ops } from "@mcp-client/ops";
import type { HostToolDefinition } from "./tools.js";
import { renderOutcome } from "./results.js";

interface CommandContext {
  notify(message: string, kind?: "info" | "warning" | "error"): void;
  signal?: AbortSignal;
}
export interface CoreFeaturesHost {
  registerTool(def: HostToolDefinition): unknown;
  registerCommand(name: "mcp-prompt", cmd: {
    description: string;
    handler(args: string, ctx: CommandContext): Promise<void>;
  }): unknown;
  wake(server: string, reason: string): unknown;
  refreshTools(): unknown;
}

interface Runtime {
  readonly ops: Ops;
  readonly capabilities: Record<string, unknown> | undefined;
  readonly transportClosed: AbortSignal;
  readonly stateful: { readonly subscriptions?: SubscriptionManager | undefined };
}
interface Descriptor {
  readonly name: string;
  readonly aliases?: readonly string[];
}
interface Connected {
  descriptor: Descriptor;
  rt: Runtime;
  signal: AbortSignal;
  filter: ListenFilter;
  uris: readonly string[];
  stream: Subscription | undefined;
  pending: Subscription | undefined;
  queue: Promise<unknown>;
  close(): void;
}

const string = { type: "string" } as const;
const argumentsSchema = { type: "object", additionalProperties: string } as const;
const outputSchema = { type: "object", additionalProperties: true } as const;
const promptActions = ["list", "get", "complete"] as const;
const resourceActions = ["list", "templates", "read", "directory", "subscribe", "unsubscribe", "subscriptions"] as const;

function parameters(actions: readonly string[], props: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: ["action"], properties: {
    action: { type: "string", enum: actions }, server: string, cursor: string, ...props,
  } };
}

function field(input: Record<string, unknown>, name: string, allowEmpty = false): string {
  const value = input[name];
  if (typeof value !== "string" || (!allowEmpty && !value)) throw new Error(`Expected ${name} to be ${allowEmpty ? "a" : "a non-empty"} string`);
  return value;
}

function promptArgs(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return;
  if (!isObj(value) || Object.values(value).some(v => typeof v !== "string")) throw new Error("Expected arguments to be an object of strings");
  return value as Record<string, string>;
}

function supports(rt: Runtime, capability: string, flag?: string): boolean {
  const cap = rt.capabilities?.[capability];
  return isObj(cap) && (flag === undefined || cap[flag] === true);
}

async function success(method: string, structuredContent: Record<string, unknown>) {
  return { ...await renderOutcome({ kind: "ok", value: structuredContent, meta: localMeta(method) }), structuredContent };
}

function present<T>(out: Outcome<T>, project: (value: T) => Record<string, unknown>) {
  return out.kind === "ok" ? success(out.meta.method, project(out.value)) : renderOutcome(out);
}

export function createCoreFeatures(host: CoreFeaturesHost) {
  const servers = new Map<string, Connected>();

  async function listen(server: Connected, uris: readonly string[], signal: AbortSignal) {
    signal.throwIfAborted();
    const { subscriptions } = server.rt.stateful;
    const old = server.stream;
    if (!subscriptions) return;
    if (!uris.length && !Object.values(server.filter).some(Boolean)) {
      server.stream = undefined;
      server.uris = [];
      old?.close();
      return;
    }
    const next = subscriptions.listen({ ...server.filter, ...(uris.length ? { resourceUris: uris } : {}) });
    server.pending = next;
    const abort = () => next.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const { granted } = await next.acknowledged;
      signal.throwIfAborted();
      const grantedUris = granted.resourceSubscriptions ?? [];
      if (uris.some(uri => !grantedUris.includes(uri))) throw new Error("MCP server did not grant the requested resource subscriptions");
      server.stream = next;
      server.uris = uris;
      old?.close();
      void consume(server, next).catch(() => {});
    } catch (err) {
      next.close();
      throw err;
    } finally {
      signal.removeEventListener("abort", abort);
      if (server.pending === next) server.pending = undefined;
    }
  }

  async function consume(server: Connected, stream: Subscription) {
    try {
      for await (const { method, params } of stream.events) {
        if (server.signal.aborted || server.stream !== stream) break;
        try {
          if (method === "notifications/tools/list_changed") await host.refreshTools();
          else if (method === "notifications/resources/updated" && typeof params.uri === "string") {
            await host.wake(server.descriptor.name, `Resource updated: ${params.uri}`);
          } else if (method === "notifications/resources/list_changed") await host.wake(server.descriptor.name, "Resource list changed");
          else if (method === "notifications/prompts/list_changed") await host.wake(server.descriptor.name, "Prompt list changed");
        } catch { /* A host callback failure must not stop listening. */ }
      }
    } finally {
      if (server.stream === stream) {
        server.stream = undefined;
        server.uris = [];
      }
    }
  }

  function connect(rt: Runtime, descriptor: Descriptor, signal: AbortSignal) {
    const lifecycle = AbortSignal.any([signal, rt.transportClosed]);
    if (lifecycle.aborted) return;
    servers.get(descriptor.name)?.close();
    const lifetime = new AbortController();
    const server: Connected = {
      rt, descriptor, signal: lifetime.signal, uris: [], stream: undefined, pending: undefined,
      filter: {
        tools: supports(rt, "tools", "listChanged"), prompts: supports(rt, "prompts", "listChanged"),
        resources: supports(rt, "resources", "listChanged"),
      },
      queue: Promise.resolve(),
      close() {
        if (servers.get(descriptor.name) === server) servers.delete(descriptor.name);
        lifecycle.removeEventListener("abort", server.close);
        lifetime.abort(lifecycle.reason);
        server.pending?.close();
        server.stream?.close();
      },
    };
    servers.set(descriptor.name, server);
    lifecycle.addEventListener("abort", server.close, { once: true });
    // Background interest is best-effort: a listen failure must not block other Ops.
    server.queue = listen(server, [], server.signal).catch(() => {});
  }

  function targets(alias: string | undefined, capability: string, single: boolean): Connected[] {
    const exact = alias === undefined ? undefined : servers.get(alias);
    const matches = exact ? [exact] : [...servers.values()].filter(s => alias === undefined || s.descriptor.aliases?.includes(alias));
    if (alias !== undefined && matches.length !== 1) throw new Error(`${matches.length ? "Ambiguous" : "Unknown"} MCP server: ${alias}`);
    const eligible = matches.filter(s => supports(s.rt, capability));
    if (alias !== undefined && !eligible.length) throw new Error(`MCP server ${alias} does not advertise ${capability}`);
    if (single && eligible.length !== 1) throw new Error(`Specify a server advertising ${capability}`);
    return eligible;
  }

  async function execute(kind: "prompts" | "resources", input: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!isObj(input)) throw new Error("Expected a tool input object");
    const action = field(input, "action");
    const alias = input.server === undefined ? undefined : field(input, "server");
    const cursor = input.cursor === undefined ? undefined : field(input, "cursor", true);
    const method = `${kind}/${action}`;
    const isList = action === "list" || (kind === "resources" && action === "templates");
    if (cursor !== undefined && (!isList || alias === undefined)) throw new Error("A cursor requires a list action and server");
    if (isList || (kind === "resources" && action === "directory")) {
      const key = kind === "prompts" ? "prompts" : action === "templates" ? "resourceTemplates" : "resources";
      const selected = targets(alias, kind, false);
      const results = await Promise.all(selected.map(async server => {
        const { ops } = server.rt;
        const opts = { signal: AbortSignal.any([signal, server.signal]), ...(cursor === undefined ? {} : { cursor }) };
        const name = server.descriptor.name;
        if (action === "directory") {
          const [resources, resourceTemplates] = await Promise.all([ops.resources.list(opts), ops.resources.listTemplates(opts)]);
          return { server: name,
            ...(resources.kind === "ok" ? { resources: resources.value.items.map(i => i.raw), nextResourceCursor: resources.value.nextCursor } : { resourcesError: resources.kind }),
            ...(resourceTemplates.kind === "ok" ? { resourceTemplates: resourceTemplates.value.items.map(i => i.raw), nextTemplateCursor: resourceTemplates.value.nextCursor } : { templatesError: resourceTemplates.kind }),
          };
        }
        const out = kind === "prompts" ? await ops.prompts.list(opts)
          : await (action === "templates" ? ops.resources.listTemplates(opts) : ops.resources.list(opts));
        if (out.kind !== "ok") return { server: name, error: out };
        const items = "items" in out.value ? out.value.items.map(i => i.raw) : out.value.prompts;
        return { server: name, [key]: items, ...(out.value.nextCursor === undefined ? {} : { nextCursor: out.value.nextCursor }) };
      }));
      signal.throwIfAborted();
      if (alias !== undefined && results[0]) {
        const result = results[0];
        return "error" in result && result.error ? renderOutcome<unknown>(result.error) : success(method, result);
      }
      return success(method, { servers: results });
    }
    if (kind === "resources" && action === "subscriptions") {
      return success(method, { subscriptions: targets(alias, kind, false).map(s => ({ server: s.descriptor.name, uris: s.uris, state: s.stream?.state ?? "ended" })) });
    }
    const server = targets(alias, kind, true)[0]!;
    const { ops } = server.rt;
    const name = server.descriptor.name;
    const active = AbortSignal.any([signal, server.signal]);
    const opts = { signal: active };
    if (kind === "prompts" && action === "get") {
      return present(await ops.prompts.get(field(input, "name"), promptArgs(input.arguments), opts), v => ({ server: name, description: v.description, messages: v.messages.map(message => message.raw) }));
    }
    if (kind === "prompts" && action === "complete") {
      if (!supports(server.rt, "completions")) throw new Error(`MCP server ${name} does not advertise completions`);
      const args = promptArgs(input.arguments);
      return present(await ops.completion.complete({
        ref: { type: "ref/prompt", name: field(input, "name") },
        argument: { name: field(input, "argument"), value: field(input, "value", true) },
        ...(args ? { context: { arguments: args } } : {}),
      }, opts), v => ({ server: name, ...v }));
    }
    if (kind === "resources" && action === "read") {
      const uri = field(input, "uri");
      return present(await ops.resources.read(uri, opts), v => ({ server: name, uri, contents: v.raw.contents }));
    }
    if (kind === "resources" && (action === "subscribe" || action === "unsubscribe")) {
      if (!supports(server.rt, "resources", "subscribe") || !server.rt.stateful.subscriptions) {
        throw new Error(`MCP resource subscriptions unavailable on ${name}`);
      }
      const uri = field(input, "uri");
      const update = server.queue.then(async () => {
        active.throwIfAborted();
        const uris = new Set(server.uris);
        const had = uris.has(uri);
        if (action === "subscribe") uris.add(uri);
        else uris.delete(uri);
        if (had !== uris.has(uri)) await listen(server, [...uris], active);
        return success(method, { server: name, uris: server.uris });
      });
      server.queue = update.catch(() => {});
      return update;
    }
    throw new Error(`Unknown MCP ${kind} action: ${action}`);
  }

  host.registerTool({ name: "mcp_prompts", description: "List, fetch, or complete arguments for MCP prompts.", exposure: "direct",
    parameters: parameters(promptActions, { name: string, arguments: argumentsSchema, argument: string, value: string }), outputSchema,
    execute: (_id, input, signal) => execute("prompts", input, signal),
  });
  host.registerTool({ name: "mcp_resources", description: "List MCP resources or templates, browse a directory, read by URI, or manage resource subscriptions.", exposure: "direct",
    parameters: parameters(resourceActions, { uri: string }), outputSchema,
    execute: (_id, input, signal) => execute("resources", input, signal),
  });
  host.registerCommand("mcp-prompt", {
    description: "List MCP prompts or fetch one: /mcp-prompt [server name [JSON arguments]]",
    async handler(args, ctx) {
      try {
        const match = /^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim());
        const input = match ? { action: "get", server: match[1], name: match[2], ...(match[3] ? { arguments: JSON.parse(match[3]) } : {}) }
          : { action: "list", server: args.trim() || undefined };
        const result = await execute("prompts", input, ctx.signal ?? new AbortController().signal);
        if (!ctx.signal?.aborted) ctx.notify(result.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n"), result.isError ? "error" : "info");
      } catch (err) {
        if (!ctx.signal?.aborted) ctx.notify(err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
  return { connect };
}
