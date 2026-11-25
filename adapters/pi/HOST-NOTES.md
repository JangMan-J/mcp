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

## Cellar equivalents (graph: home-jangmanj-Projects-cellar, 2026-11-25)

Mapped against `src/daemon/pi-extensions.ts` (indexed, no recorded coverage
issue). Most of this adapter's pi-coding-agent surface has a direct durable
equivalent:

| Adapter touchpoint | Cellar equivalent |
|---|---|
| `pi.registerTool` | `PiExtensionApi.registerTool` / `PiTool` (same execute shape) |
| `pi.registerCommand` | `pi-extensions.registerCommand` (UI doc commands) |
| `exposure` | `PiTool.exposure` (string) |
| `annotations` | `PiTool.annotations` |
| `namespace` | **No equivalent** — `PiTool` has no namespace field; codemode grouping must be rethought or added. |
| `getActiveTools` / `setActiveTools` / `getAllTools` | `pi-extensions.getActiveTools` / `setActiveTools` / `getAllTools` |
| `before_agent_start` | `pi-extensions.beforeAgentStart` (systemPrompt override supported) |
| `systemPromptOptions.sections` | **No equivalent** — `systemPromptOptions: {}` is passed empty; use `systemPrompt` override instead of an `mcp_servers` section. |
| `tool_call` | `pi-extensions.beforeTool` (mutable input, block, gate prompts) |
| `session_start` / `session_shutdown` | `pi-extensions.start` / `close` |
| `mcp_servers_change` | **No event found** — `registerMcpServer` / `unregisterMcpServer` / `getMcpServers` exist, but no change event; re-read on demand. |
| `ctx.ui.notify/confirm/input/select` | `pi-extensions.notify` / `confirm` / `input` / `select` |
| `ctx.cwd` / `hasUI` / `isProjectTrusted` | `ExtensionContext.cwd` / `hasUI` / `isProjectTrusted` |
| `pi.getSettings()` | `pi-extensions.getSettings` (merged settings; no `autoEnableCodemode` reference found) |
| `pi.registerMcpServer` | `PiExtensionApi.registerMcpServer` |

Net: a durable adapter can reuse nearly all of `bridge.ts` unchanged. The
adapter-specific deltas are (1) no `namespace`, (2) system-prompt override
instead of sections, (3) no `mcp_servers_change` event, and (4) no
`autoEnableCodemode` setting lookup. `mcp-host.ts` / `mcp-events.ts` were not
present in this moderate index generation; earlier full-index evidence had
`startMcpHost` called by `src.cli.mcp` and `src.daemon.main.globalMcp` / `mcp`.
