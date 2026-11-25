# Host touchpoints: pi-coding-agent vs other Pi modules

This adapter is written against a structural `ExtensionAPI` (`pi-api.ts`), not
imported Pi packages (the repo's `check-forbidden` rule forbids them). The
following touchpoints are **pi-coding-agent-specific** and cannot be moved to
`pi-ai`, `pi-codemode`, or `pi-durable` without a host adapter:

| Touchpoint | Where | Why it is host-specific |
|---|---|---|
| `pi.registerTool` / `pi.registerCommand` | `bridge.ts`, `index.ts` | Tool/command ownership and `/mcp` replacement semantics belong to pi-coding-agent's extension runner. |
| `exposure`, `namespace`, `annotations` | `bridge.ts` | These are pi-coding-agent's codemode/tool_search exposure model, not MCP concepts. |
| `pi.getActiveTools` / `setActiveTools` / `getAllTools` | `bridge.ts` (`ensureReachTools`) | Activating `codemode` / `tool_search` is a pi-coding-agent tool-loadout operation. |
| `before_agent_start` + `systemPromptOptions.sections` | `index.ts` | pi-coding-agent's system-prompt section model (`mcp_servers`). |
| `tool_call` waits for late registration | `index.ts` | pi-coding-agent's tool pipeline and `reachesTools` behavior. |
| `session_start` / `session_shutdown` / `mcp_servers_change` | `index.ts` | pi-coding-agent session lifecycle and `pi.registerMcpServer` registry. |
| `ctx.ui.notify/confirm/input/select` | `index.ts`, `oauth.ts`, `elicitation.ts` | pi-coding-agent TUI prompts. |
| `pi.getSettings().autoEnableCodemode` | `bridge.ts` | pi-coding-agent settings shape. |

Portable as-is:

- `PiContent` text/image blocks are structurally identical to `pi-ai`'s
  `TextContent` / `ImageContent`.
- `config.ts` (mcp.json discovery/merge/interpolation) is host-neutral except
  for the `PI_CODING_AGENT_DIR` convention, which other hosts may mirror.
- `bridge.ts`'s connection, OAuth, MRTR, resource, and result-conversion logic
  only needs the small `ExtensionAPI` surface above; a durable host can wrap it
  with its own `defineExtension`/`defineTool` adapter.

`pi-durable` (cellar) uses `defineExtension`/`defineTool` with a different
`execute(args, api, context)` signature and its own event delivery, so there is
no drop-in move into durable; it needs the thin wrapper described above.
Cellar also provides its own command registerer, so the `/mcp` command surface
(`index.ts`) is portable there directly; the remaining durable-specific work is
tool execution signatures, UI prompts, and session/event delivery.
