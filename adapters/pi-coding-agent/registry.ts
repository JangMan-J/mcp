import { toolName } from "./tool-name.ts";

export interface SearchableTool {
  readonly name: string;
  readonly description?: string;
}

/** The session supplies enabled servers and lists only their deferred tools. */
export interface DeferredToolSource<T extends SearchableTool> {
  readonly server: string;
  ready(signal?: AbortSignal): Promise<void>;
  listDeferredTools(signal?: AbortSignal): Promise<readonly T[]>;
}

export interface ToolDeclaration<T extends SearchableTool> {
  readonly name: string;
  readonly server: string;
  readonly tool: T;
}

/** Session-scoped registry; the host calls search from tool_search. */
export function createDeferredToolRegistry<T extends SearchableTool>(
  sources: readonly DeferredToolSource<T>[],
  declare: (tool: ToolDeclaration<T>) => void,
) {
  const declared = new Map<string, ToolDeclaration<T>>();

  return {
    async search(query: string, signal?: AbortSignal): Promise<readonly ToolDeclaration<T>[]> {
      signal?.throwIfAborted();
      const term = query.trim().toLowerCase();
      if (!term) return [];

      const catalogs = await Promise.all(sources.map(async source => {
        await source.ready(signal);
        signal?.throwIfAborted();
        return { server: source.server, tools: await source.listDeferredTools(signal) };
      }));
      signal?.throwIfAborted();

      const matches = new Map<string, ToolDeclaration<T>>();
      for (const { server, tools } of catalogs) {
        for (const tool of tools) {
          if (!tool.name.toLowerCase().includes(term) && !tool.description?.toLowerCase().includes(term)) continue;
          const name = toolName(server, tool.name);
          let declaration = declared.get(name);
          if (!declaration) {
            signal?.throwIfAborted();
            declaration = { name, server, tool };
            declare(declaration);
            declared.set(name, declaration);
          }
          matches.set(name, declaration);
        }
      }
      return [...matches.values()];
    },
  };
}
