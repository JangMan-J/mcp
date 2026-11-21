# Pi Coding Agent adapter
Status: typed entrypoint implemented; scratch trial at the pinned fork passed
(2026-11-21); active-config cutover not done.

## Entrypoints
- `createPiMcpExtension` (`pi-extension.ts`): the Pi extension factory. It
  registers `/mcp`, so Pi's `omitReplacedExtensions` drops `builtin:mcp`
  when it loads (see `docs/decisions/pi-target.md`, Q21).
- `installCodingAgentAdapter` (`adapter.ts`): the typed entrypoint. It
  wires the host ports (`host.ts` `installHost`), branch persistence,
  config, credentials, tools and results modules, and returns a disposer.
- `loadLayeredMcpConfig` / `resolveServerVariables` (`config.ts`): global
  plus project `mcp.json` layering with override entries, and opt-in
  `${NAME}` / `cwd` expansion. `readLegacyConfig` stays pure and literal and
  never runs `!cmd`.
- `bin/mcp-cli.ts`: optional standalone CLI (D7 Option C). It does not
  change `pi mcp`, which stays on the old stack.

## Build and load in Pi
- `npm run build` (all workspaces) or `npm run build:pi-extension` (this
  adapter only; emits `adapters/pi-coding-agent/dist/index.js`, the
  `pi.extensions` entry in `package.json`).
- One-off load without installing: `pi -e adapters/pi-coding-agent/dist/index.js`
  (`/mcp` registration replaces `builtin:mcp`; see `docs/decisions/pi-target.md`).
- Package install: `pi install ./adapters/pi-coding-agent`. Only do this with
  `PI_CODING_AGENT_DIR` pointing at a scratch dir; do not install into the
  active `~/.pi/agent` until the cutover in `docs/cutover.md`.
- Scratch sessions: set `PI_CODING_AGENT_SESSION_DIR="$SCRATCH/sessions"`
  so branch entries never land in active sessions.
- Live runner prerequisites: the pinned fork build, Node `>=22.19.0`, a
  built `dist/`, a scratch `PI_CODING_AGENT_DIR`, and a synthetic MCP server
  (see "Scratch test prerequisites" below).

## Config, auth, commands
- Global config: `$PI_CODING_AGENT_DIR/mcp.json` (default `~/.pi/agent/mcp.json`).
- Project config: `<cwd>/.pi/mcp.json`, read only when Pi's
  `ctx.isProjectTrusted()` returns `true`; if that method is missing or
  throws, project config is skipped (fail closed).
- Auth: provider bearer tokens come from Pi's model registry
  (`getApiKeyForProvider`); a missing key fails the request. OAuth sign-in and
  URL elicitation prompt through Pi's UI consent.
- Branch state (cursor, approval, taskId, requestState only; no tokens) is
  written with `pi.appendEntry` under `pi.coding-agent.branch.v2` and restored
  from `ctx.sessionManager.getBranch()` (active branch only).
- Commands: `/mcp [list|status [server]|enable <server>|disable <server>|sign-in <server>|reconnect <server>|card <server>]`.
- Limitations: `pi mcp` (CLI) stays on the old stack; use `bin/mcp-cli.ts`.
  Branch saving needs a host with `appendEntry`; without a session manager,
  restore yields no state.

## CI commands (fake host, no Pi, no live config)
- `npm run build`
- `npx vitest run adapters/pi-coding-agent` (add
  `--reporter=json --outputFile="$SCRATCH/r.json"` for a JSON report
  written to scratch, never into the repo)
- `npm run check:deps` (no Pi imports in `packages/`)

These run against fake host ports and a scratch config/store only. They
prove adapter contracts; they do not prove behavior inside real Pi.

## Live fork trial (scratch run done; active-config cutover not done)
The scratch trial and rollback drill ran on 2026-11-21 at the pinned fork;
results are in `docs/cutover.md` ("Side-by-side trial and rollback drill
record"). Commands (each exits 0 only if all items pass; they use a scratch
dir and never touch `~/.pi/agent`):
- `node scripts/pi-trial/boot-check.mjs` (adapter on with `-builtin:mcp`,
  then the rollback drill)
- `node scripts/pi-trial/trial-a.mjs` (items 1-4)
- `node scripts/pi-trial/trial-b.mjs` (items 5-8)
- `node scripts/pi-trial/smoke.mjs` (synthetic server smoke check)

The cutover in the active config has not been done, nor has an active-config
rollback or the observation window. The manual list below is the scenario
reference.

## Scratch test prerequisites
- Pinned fork only: installed build `next-7d80b45f62f8` (`pi --version`
  prints `1.5.2`, `@earendil-works/pi-coding-agent` `1.5.2`), checkout
  `7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec` on branch `next`; see
  `docs/decisions/pi-target.md`. Do not retarget silently if HEAD moved.
- Node `>=22.19.0`; spec-gate report for the commit under test recorded.
- A synthetic MCP server as the only test server; no real server,
  credential, or production data.
- Q21 verification is recorded in `docs/decisions/pi-target.md`
  (extension API names, `builtin:mcp` replacement via `/mcp`,
  `tool_search`, or `codemode`). Re-check it if the pin moves.
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
