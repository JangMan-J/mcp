# Pi adapter target pin (D3)

Wave 3 slice S3.0 record. This file fixes the exact Pi fork revision the Coding
Agent adapter and the durable adapter are built and accepted against. It is a
decision record, not a build: nothing here changes Pi, the active config, or
any package. Sources: `docs/conformance/PINS.md` ("Pi metadata") and
`docs/conformance/DECISIONS.md` (D3, Q21, Q28), salvaged at commit
`1d30a252739e3c1be36ed394043b7456621a7bc3`. Observations were taken
2026-11-19T06:47:10Z from the install manifest and `git -C ~/pi` only; the MCP
package, its changes, and adapters were not opened.

## Selected pin

| Kind | Id | Notes |
|---|---|---|
| Installed build | directory `next-7d80b45f62f8` | `pi --version` prints `1.5.2`; package `@earendil-works/pi-coding-agent` version `1.5.2`; `engines.node` `>=22.19.0` |
| Checkout HEAD | `7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec` on branch `next` | subject `Merge branch 'fork/tooling' into next`, 2026-11-19 01:47:24 +0000. Same build id as the install |

Decision (D3, answered): the adapter target is the checkout HEAD above. It
matches the installed build recorded in PINS.md, so acceptance runs against the
pinned revision exercise the same code the user runs.

Local `node --version` at observation time was `v26.13.1`. That is the machine,
not a library baseline; D2's floor is Node >= 22.

## Rejected candidate

| Kind | Id | Why rejected |
|---|---|---|
| PLAN.md checkout | `e903c27bbd864a81f40941ae1d93b42585b20c6d` (2026-11-18 19:57:21 +0000) | Divergent line, not an ancestor of HEAD: `e903c27bb..HEAD` is 105 commits, `HEAD..e903c27bb` is 94. Observed, not selected. Q28 is closed by not selecting it |

## Q21 verification (answered)

Read against the pinned commit `7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec` in
`~/pi/packages` with `git -C ~/pi show <pin>:<path>` (the working checkout HEAD
had moved to `ca5859412c966fcf52a48b0772801d0092a9d486` at read time; the pin
was not retargeted). Paths below are relative to `~/pi/packages`.

- **`ToolDefinition`** (`coding-agent/src/core/extensions/types.ts`):
  - `exposure?: ToolExposure`, one of `"direct" | "model-only" | "codemode" |
    "deferred" | "hidden"` (line 638).
  - synchronous `reachesTools?: (input: Record<string, unknown>) => "all" |
    readonly string[]` (line 650). The adapter's `pi.on("tool_call")` handler
    uses it to await pending server connections before the reached tools run.
  - `outputSchema?: TSchema` (line 633) with `structuredContent`: codemode
    scripts get the raw `CallToolResult` with `_meta` stripped, while `content`
    carries bounded model text and images.
  - `namespace?: ToolNamespace` (line 641), `annotations?: ToolAnnotations`
    (line 653).
  - `pi.registerToolRenderer(resolver: ToolRendererResolver)` (line 1781).
- **Replacing `builtin:mcp`** (`coding-agent/src/extensions/index.ts:9-14`,
  `coding-agent/src/core/resource-loader.ts:146-175`): the built-in `mcp`
  entry has `replaceable: true`. `omitReplacedExtensions` drops `builtin:mcp`
  whenever a loaded extension registers `/mcp` (`pi.registerCommand("mcp",
  ...)`), `tool_search`, or `codemode`. No separate "replaces" declaration
  exists. `-builtin:mcp` in scratch or active settings disables it explicitly,
  as described in `docs/cutover.md`.
- **Dynamic server registration**: `pi.registerMcpServer` /
  `pi.unregisterMcpServer` (`types.ts:1951`, `1954`) emit `mcp_servers_change`
  (`types.ts:1673`). An `mcp.json` entry wins over a same-named
  extension-registered entry. `before_agent_start` fills
  `event.systemPromptOptions.sections["mcp_servers"]`.
- **Standalone `pi mcp`**: dispatched in `coding-agent/src/main.ts:659-663`
  (`runMcpCommand`) before extensions load, so an extension cannot replace it.
  D7 Option A keeps `pi mcp` on the old stack. Option C is
  `adapters/pi-coding-agent/bin/mcp-cli.ts`.
- **Durable `ToolTask` / `Extension` hooks** (`durable/src/harness/types.ts`):
  - `Extension<ToolRegistration>` declares `name`, `namespace`, `tools`,
    `sections`, `hooks`, `wraps`, `tasks`.
  - `ToolRegistration` declares `replay?: "safe" | "unsafe"` (default
    `"unsafe"`; MCP `tools/call` stays `"unsafe"` unless the tool is
    explicitly read-only), `callers?: readonly ("model" | "tools")[]`
    (`["tools"]` for codemode-only tools), `deferred?: true`,
    `structuredOutputSchema`, `execute(args, api, context)`, and an idempotent
    `cancel?(args, api, context)` for parked calls.
  - Nested `api.executeTool` uses positional keys `1, 2, ...` by default and
    needs an explicit key (not numeric, no slash) after `wake`.

Requirement rows `PICA-1, -2, -5, -6, -7, -9, -10` are no longer blocked on this
read. No live fork trial has been run.

## Re-verify

```
git -C ~/pi rev-parse HEAD                      # expect 7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec
git -C ~/pi log -1 --format='%ci %s' HEAD
git -C ~/pi merge-base --is-ancestor e903c27bbd864a81f40941ae1d93b42585b20c6d HEAD; echo $?
git -C ~/pi rev-list --count e903c27bbd864a81f40941ae1d93b42585b20c6d..HEAD   # 105 at pin time
git -C ~/pi rev-list --count HEAD..e903c27bbd864a81f40941ae1d93b42585b20c6d   # 94 at pin time
pi --version                                    # expect 1.5.2 from next-7d80b45f62f8
```

If HEAD has moved when Wave 3 starts, the pin is still
`7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec`: check out that revision for
acceptance, or re-run the pin pass and record a new decision row. Do not
retarget silently.
