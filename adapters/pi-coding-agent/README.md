# Pi Coding Agent adapter
Status: typed entrypoint implemented; live fork trial pending.

## Entrypoint
`installCodingAgentAdapter` in `adapter.ts` is the typed entrypoint. It
wires the host ports (`host.ts` `installHost`), branch persistence,
config, credentials, tools and results modules, and returns a disposer.

## CI commands (fake host, no Pi, no live config)
- `npm run build`
- `npx vitest run adapters/pi-coding-agent` (add
  `--reporter=json --outputFile="$SCRATCH/r.json"` for a JSON report
  written to scratch, never into the repo)
- `npm run check:deps` (no Pi imports in `packages/`)

These run against fake host ports and a scratch config/store only. They
prove adapter contracts; they do not prove behavior inside real Pi.

## Live fork trial (pending, separately approved)
Not run. Everything below describes the manual trial against the pinned
fork. No entrypoint script launches it.

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
