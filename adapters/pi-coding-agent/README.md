# Pi Coding Agent adapter (planned)
Status: not built. No entrypoint, package, script, or runnable run exists
yet in this directory; this records how a future manual scratch test must
be set up once one is provided and separately approved.
## Scratch test prerequisites
- Pinned fork only: installed build `next-7d80b45f62f8` (`pi --version`
  prints `1.5.2`, `@earendil-works/pi-coding-agent` `1.5.2`), checkout
  `7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec` on branch `next`; see
  `docs/decisions/pi-target.md`. Do not retarget silently if HEAD moved.
- Node `>=22.19.0`; spec-gate report for the commit under test recorded.
- A synthetic MCP server as the only test server; no real server,
  credential, or production data.
- Q21 verification done against the pinned checkout (extension API names,
  `replaces builtin:mcp` declaration) before any test is attempted.
## Clean config isolation
- Create fresh `SCRATCH=$(mktemp -d)`; launch Pi with
  `PI_CODING_AGENT_DIR="$SCRATCH/agent"` (plus
  `PI_CODING_AGENT_SESSION_DIR="$SCRATCH/sessions"` if sessions are used).
- Never set `PI_CODING_AGENT_DIR` to the active `~/.pi/agent`, never copy
  in its `settings.json`, `mcp.json`, `auth.json`, or `mcp-auth.json`, and
  never run the scratch test without that variable set.
- Start from empty scratch settings; add only the test server and any
  `-builtin:mcp` override in the scratch settings alone.
- Verify `PI_CODING_AGENT_DIR` resolves inside `$SCRATCH`; confirm active
  config checksums/mtimes unchanged afterwards; delete `$SCRATCH` after.
## Manual scenarios (exact list, in order)
1. Tool registration against the synthetic server.
2. `/mcp` server list/status, enable/disable, and sign-in prompts.
3. Exposure modes (per-server and per-tool).
4. Deferred search (`tool_search` / `reachesTools` waits for readiness).
5. Branch/fork/resume with only data persisted (no tokens in entries).
6. Abort mid-call; late results are dropped.
7. `uncertain-write` rendering (model told it may or may not have run).
8. URL elicitation consent (accept, reject, and cancel).
9. Removal: disable the adapter; Pi falls back with no residue.
