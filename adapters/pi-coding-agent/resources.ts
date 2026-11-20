import type { ResourcesApi } from "@mcp-client/ops";
import { renderOutcome } from "./results.ts";

type RunReady = <T>(server: string, run: (ops: ResourcesApi, signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>;
type Args = { server?: string; cursor?: string; uri?: string };
const string = { type: "string" } as const;

async function success(method: string, structuredContent: Record<string, unknown>) {
  const rendered = await renderOutcome({ kind: "ok", value: JSON.stringify(structuredContent),
    meta: { method, binding: "local", requestId: 0, attempts: 0 } });
  return { ...rendered, structuredContent };
}

/** Build one descriptor per native name, independent of server count. Resolve targets at call time:
 * an explicit alias must identify one server; no alias selects every resource server. */
export function createResourceTools(resolveTargets: (alias?: string) => readonly string[], runReady: RunReady) {
  function target(alias: string): string {
    const servers = resolveTargets(alias);
    if (servers.length !== 1) throw new Error(`${servers.length ? "Ambiguous" : "Unknown"} MCP resource server: ${alias}`);
    return servers[0]!;
  }
  function list(name: string, key: "resources" | "resourceTemplates", page: "list" | "listTemplates", all: "listAll" | "listAllTemplates") {
    return {
      name, label: name, description: `List MCP ${key} from one server or all resource servers.`,
      parameters: { type: "object", properties: { server: string, cursor: string }, additionalProperties: false } as const,
      async execute(_id: string, { server, cursor }: Args, signal?: AbortSignal) {
        signal?.throwIfAborted();
        if (server !== undefined) {
          const canonical = target(server);
          const out = await runReady(canonical, (ops, active) => ops[page]({ signal: active, ...(cursor !== undefined && { cursor }) }), signal);
          signal?.throwIfAborted();
          if (out.kind !== "ok") return { ...await renderOutcome(out), structuredContent: undefined };
          return success(name, { server: canonical, [key]: out.value.items.map(({ raw }) => ({ ...raw, server: canonical })),
            ...(out.value.nextCursor !== undefined && { nextCursor: out.value.nextCursor }) });
        }
        if (cursor !== undefined) throw new Error("A cursor requires an MCP resource server");
        const servers = [...new Set(resolveTargets())];
        const outcomes = await Promise.all(servers.map(server => runReady(server, (ops, active) => ops[all]({ signal: active }), signal)));
        signal?.throwIfAborted();
        const items = outcomes.flatMap((out, i) => out.kind === "ok" ? out.value.items.map(({ raw }) => ({ ...raw, server: servers[i] })) : []);
        const errors = outcomes.flatMap((out, i) => out.kind === "ok" ? [] : [{ server: servers[i], error: out.kind }]);
        return success(name, { [key]: items, ...(errors.length && { errors }) });
      },
    };
  }
  const name = "read_mcp_resource";
  return [list("list_mcp_resources", "resources", "list", "listAll"),
    list("list_mcp_resource_templates", "resourceTemplates", "listTemplates", "listAllTemplates"), {
      name, label: name, description: "Read an MCP resource by server and URI.",
      parameters: { type: "object", properties: { server: string, uri: string }, required: ["server", "uri"], additionalProperties: false } as const,
      async execute(_id: string, { server, uri }: Args, signal?: AbortSignal) {
        signal?.throwIfAborted();
        if (!server || !uri) throw new Error("An MCP resource read requires a server and URI");
        const canonical = target(server);
        const out = await runReady(canonical, (ops, active) => ops.read(uri, { signal: active }), signal);
        signal?.throwIfAborted();
        return out.kind === "ok" ? success(name, { server: canonical, uri, contents: out.value.raw["contents"] })
          : { ...await renderOutcome(out), structuredContent: undefined };
      },
    }] as const;
}
