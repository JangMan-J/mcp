# Cutover and rollback plan

Wave 3 slice S3.0 record, per IMPLEMENTATION_PLAN.md §15.4–15.5. This is a
plan document with one executed part. On 2026-11-21 the side-by-side trial and
the rollback drill ran in a disposable scratch directory at the pinned Pi
revision (record below).

Pre-condition 1 (gate report for SHA X) is met: `npm run gate` at 0a6460559d8278f8cf3a4ad6447d598a67cfec57 exited 0, release eligible, 12/12 gate items, official 32/32 (see docs/conformance/GATE-STATUS.md).

The cutover, a rollback in the active config, and the
observation window have not been executed. Nothing changes the Pi fork source,
the active Pi config, or `pi-mcp-ext` (§15.5 item 6). Each remaining step
becomes executable only when its pre-conditions are met and the director
authorizes it. The pinned adapter target is recorded in
`docs/decisions/pi-target.md`.

## D7: standalone `pi mcp` stays on the old stack

Fact (§15.4): `pi mcp ...` is dispatched before extension loading
(`coding-agent/src/main.ts:659-663` calls `runMcpCommand` before arg parsing),
so a Pi extension cannot replace it. It runs the built-in implementation backed
by `@earendil-works/pi-mcp`.

Options considered:

- **(A)** Leave `pi mcp` on the old implementation. Two MCP stacks coexist;
  documented.
- **(B)** Re-point `pi mcp` to the new library via a fork change. Violates "no
  changes to the fork before the gate and an explicit cutover plan" unless
  separately approved.
- **(C)** Ship a separate bin from the new library
  (`adapters/pi-coding-agent/bin/mcp-cli`) used by users instead.

Decision (D7, answered; row `CUT-PI-MCP-1`): **A for the first adapter
release**, with C as an optional, explicitly named tool; B only as a later,
separate cutover with its own plan and approval. Rationale: PLAN.md says treat
standalone `pi mcp` as a separate cutover only if an extension cannot replace
it; it cannot, so the decision is distinct from the extension adapter and does
not block it. Consequence (risk R15): two MCP stacks coexist in Pi during and
after cutover; they are kept separate by the `-builtin:mcp` mechanism below and
by namespaced session state, and rollback is a single settings edit.

## Pre-conditions (§15.5 item 1)

Before any config is touched:

1. Gate report exists for commit SHA X (§14); Wave 3 pins that SHA.
2. Adapter acceptance run is recorded against the pinned fork revision in
   `docs/decisions/pi-target.md`.
3. Backup of the active Pi config and extension dirs (copy, with checksums)
   written outside the repo.

## Side-by-side trial (§15.5 item 2)

- Install the adapter into a **scratch** Pi agent directory, never the active
  config.
- Running both stacks' tool names in parallel is not allowed (name clash
  `mcp__*`). The trial therefore disables the built-in with `-builtin:mcp` in
  the **scratch settings only**; the active config keeps its built-in stack
  untouched.
- Isolated credentials: the adapter uses its own credential store file. The
  old stack's `mcp-auth.json` is not read, modified, or copied, so sign-ins in
  the active config are unaffected by anything the trial does.
- Exercise the §15.2 acceptance list in the scratch config against the
  synthetic server: tool registration, `/mcp`, exposure modes, deferred
  search, branch/fork/resume, abort mid-call, `uncertain-write` rendering, URL
  elicitation consent.

## Side-by-side trial and rollback drill record (scratch, 2026-11-21)

This section records what ran. It is a scratch-only record: no cutover in the
active config, no rollback in the active config, and no observation window
happened. At the time of the scratch trial, pre-condition 1 was still open;
the later release gate met it (see [Gate status](conformance/GATE-STATUS.md)).

Setup:

- Pi revision: pinned `7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec` (pinned:
  true). Pi ran from a `git clone --shared` scratch copy at the pin with
  `node_modules` linked offline, because `~/pi` is at a later commit and the
  pinned install build is no longer installed.
- Pi was driven in-process through its SDK with the faux model provider,
  `PI_CODING_AGENT_DIR=<scratch>/agent`, `HOME=<scratch>`, all under
  `$TMPDIR`. `~/.pi/agent` and `~/pi` were never modified.
- Tooling (committed in `scripts/pi-trial`): `server.mjs` (synthetic stdio MCP
  server), `smoke.mjs`, `pi-scratch.mjs`, `extension.ts` (adapter entry with
  scripted consent), `boot-check.mjs` (adapter on with `-builtin:mcp`, then the
  rollback drill), `trial-a.mjs` (items 1-4), `trial-b.mjs` (items 5-8). Each
  exits 0 only if all of its items pass.

Boot check and rollback drill (scratch settings only):

| Check | Result |
|---|---|
| Adapter run with scratch settings `{extensions: [extension.ts, '-builtin:mcp']}`: `/mcp` comes from the adapter and `builtin:mcp` is not loaded | pass |
| Rollback drill: one edit of scratch `settings.json` removing both entries; the new session has `builtin:mcp` back and the adapter gone | pass |
| No `mcp-auth.json` was created | pass |

§15.2 acceptance items at the pin (all pass):

| # | Item | Observed |
|---|---|---|
| 1 | Tool registration | `mcp__trial__echo`, `mcp__trial__needs_consent`, `mcp__trial__secret_lookup`, `mcp__trial__slow` registered; echo returns `echo: hi` |
| 2 | `/mcp` | list, status, disable, enable work |
| 3 | Exposure modes | per-tool `hidden` and server `deferred` honored |
| 4 | Deferred search | `tool_search` finds `secret_lookup`; a call then returns `found: k` |
| 5 | Branch/fork/resume | history isolated; no tokens or credentials in session files |
| 6 | Abort mid-call | turn ended in about 7 ms; server saw `notifications/cancelled`; no late entries |
| 7 | `uncertain-write` rendering | exact text: "Uncertain write: the operation may or may not have run; do not retry blindly. Check its effects first." |
| 8 | URL elicitation consent | consent port saw the full URL; accept, decline, cancel give `consent accepted`, `consent declined`, `consent cancelled` |

Active-config guard: the sha256 of every file under `~/.pi/agent` was taken
before and after each run. All non-session files were unchanged (`settings.json`,
`mcp.json`, `auth.json`, `mcp-auth.json`, and `extensions/` were named
explicitly). Only `~/.pi/agent/sessions/**` changed, written by concurrent
supervising Pi processes and not by the trial; no scratch path appears in any
active file.

Adapter bugs the trial found and fixed before the passing runs, each with a
regression test:

- `tool_search` and the resource tools were registered with exposure
  `builtin`, which Pi does not support; now `direct`.
- Per-tool `hidden` overrides were dropped; now honored.
- Deferred tools matched by `tool_search` were registered but not activated;
  now added to Pi's active tools.
- The live runtime bypassed `StatefulClient`, so URL elicitation reached the
  model as `mrtr-interim`; operations now go through `StatefulClient` with an
  `ElicitationPort` built from the consent port. `BrowserPort` is a no-op; the
  user opens the URL from the consent prompt.

Not done: cutover in the active config, rollback in the active config, and the
observation window.

## Cutover (§15.5 item 3)

1. Enable the adapter in the active config with `-builtin:mcp` (mechanism:
   extension setting override at `coding-agent/src/core/package-manager.ts:1075`;
   CLI equivalent `--no-mcp` at `coding-agent/src/main.ts:852`).
2. Migrate **one server first**, then the rest, verifying tool registration and
   `/mcp` status after each.
3. Keep the old `mcp.json` untouched. The adapter reads the same shape
   read-only (see schema-compatibility table below).

## Schema compatibility (pinned source: `packages/mcp/src/config.ts` and `packages/coding-agent/src/core/mcp-servers.ts` @ `7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec`)

Pinned from the Pi fork revision recorded in `docs/decisions/pi-target.md`. The validator is `validateMcpServerConfig` (`packages/mcp/src/config.ts`: name `^[A-Za-z0-9_-]+$`, top-level `mcpServers` map). Unknown fields are kept unchecked for the caller; only the fields below are validated. This table does not invent features the parser does not validate.

| Field | Adapter reads | Legacy handling | Parser rule |
|---|---|---|---|
| `command` | yes | stdio transport | required when `url` absent; `type` absent or `stdio` |
| `args` | yes | stdio | optional `string[]` |
| `env` | yes; `${NAME}` opt-in via `resolveServerVariables` | stdio | optional `Record<string,string>`; Pi resolves `${NAME}` / `!cmd` |
| `cwd` | yes; resolved opt-in via `resolveServerVariables` | stdio | optional `string`; Pi resolves relative to session cwd |
| `url` | yes | http | required when `command` absent; `type` absent or `http`/`streamable-http`; must be `http:` or `https:` |
| `headers` | yes; `${NAME}` opt-in via `resolveServerVariables` | http | optional `Record<string,string>`; Pi resolves `${NAME}` / `!cmd` |
| `type` | validated | legacy `sse` rejected | `sse` → invalid: "legacy SSE transport is not supported; use the streamable HTTP URL"; `streamable-http` accepted as `http` |
| `enabled` | yes | both | optional `boolean`; default `true` |
| `description` | yes | both | optional `string` |
| `timeout` | yes | both | optional positive `number` seconds; progress resets it (Pi) |
| `oauth.clientId` | yes, validated | http | optional `string` |
| `oauth.clientSecret` | yes, validated | http | optional `string`; Pi resolves `${NAME}` / `!cmd` |
| `oauth.callbackPort` | yes, validated | http | optional integer `1..65535` |
| `oauth.callbackUrl` | yes, validated | http | optional loopback `http:` on `localhost`, `127.0.0.1`, `[::1]` without query/fragment; must agree with `callbackPort` |
| `oauth.scope` | yes, validated | http | optional `string` |
| `oauth.clientName` | yes, validated | http | optional non-empty `string` |
| `oauth.clientRegistration` | yes, validated | http | optional `"auto"`/`"dcr"`/`"cimd"`; `cimd` requires loopback `/callback` and a metadata-document callback |
| `oauth.authServerMetadataUrl` | yes, validated | http | optional `https:` or loopback `http:` URL |
| `exposure` | yes | both | optional `"codemode"`/`"deferred"`/`"direct"`/`"hidden"`; alias `codemode-deferred` → `codemode` |
| `toolExposure` | yes; `*` matched by `getToolExposure` | both | optional `Record<string, exposure>`; pattern `*` allowed |
| `auth.provider` | yes, validated (global only) | http only | optional `{provider: string}`; requires `https:` or loopback; not allowed in project `mcp.json` |
| unknown fields | dropped (except `aliases`) | not preserved | validator keeps unknown fields unchecked; Pi checks `exposure`/`toolExposure`/`auth` after |
| override entry (no `command`/`url`/`type`) | yes, via `loadLayeredMcpConfig` | project overlay | `isMcpServerOverride` → overrides `enabled` etc. of a trusted entry |

### Gaps between this table and `adapters/pi-coding-agent/config.ts`

"Parser rule" describes the pinned Pi parser. The adapter's `readLegacyConfig` is a pure, read-only reader of the `mcpServers` map (names `^[A-Za-z0-9_-]+$`; per server `command`, `args`, `env`, `cwd`, `url`, `headers`, `type`, `enabled`, `description`, `timeout`, `aliases`, `exposure`, `toolExposure`, `oauth`, `auth`). What it now validates and what the surrounding helpers add:

- **`oauth.*` is validated:** `clientId`, `clientSecret`, `callbackPort` (`1..65535`), `callbackUrl` (loopback, agrees with `callbackPort`), `scope`, `clientName` (non-empty), `clientRegistration` (including the `cimd` rules), and `authServerMetadataUrl`.
- **`auth.provider` is validated** on HTTP servers only: the URL must be `https:` or loopback `http:`, and it is accepted from global `mcp.json` only. It is rejected in project scope.
- **Layering and overrides:** `loadLayeredMcpConfig` merges global and project config and applies project override entries (no `command`/`url`/`type`) that set `enabled`, `exposure`, or `toolExposure` on a trusted entry. Source `project` with `trusted` false still returns `[]` from `readLegacyConfig` before inspecting input.
- **Wildcard matching:** `getToolExposure` resolves per-tool exposure, including `*` patterns in `toolExposure`.
- **Variables are opt-in:** `resolveServerVariables` expands `${NAME}` and resolves `cwd` when a caller asks for it. `readLegacyConfig` itself stays literal and never executes `!cmd` shell commands; `!cmd` values are not run by any adapter helper. Progress-resets-timeout is Pi runtime behavior and is not implemented here.
- **Unknown fields are dropped**, not preserved; only `aliases` (string[]) is kept beyond the table rows.
- **Narrower or different checks:** `type` outside `stdio`/`http`/`streamable-http` is rejected, and `command` together with `url` is rejected.
- **Not handled by the config reader:** settings such as `-builtin:mcp`; those stay in Pi's settings files.

Option C is implemented separately: `adapters/pi-coding-agent/bin/mcp-cli.ts` is an optional standalone CLI on the new library. It does not change `pi mcp`, which stays on the old stack per D7.

## Rollback drill (rehearsed in scratch on 2026-11-21; not run in the active config)

The drill to rehearse in the scratch config before cutover is approved
(it passed in scratch; see the record above):

1. Remove the adapter entry and `-builtin:mcp` from settings — a single edit.
2. Start Pi; confirm the built-in MCP stack comes back with the same tool
   names as before the trial.
3. Confirm sign-ins survive: `mcp-auth.json` was never touched, so the old
   stack's tokens are intact.
4. Confirm no residue: session entries written by the adapter are namespaced
   and ignored by the old stack (§15.2 acceptance (c): adapter disabled -> Pi
   falls back to its built-in without residue).

Pass condition: after the single settings edit, a session on the old stack is
indistinguishable from one that never had the adapter, except for ignored
namespaced session entries.

## Observation window and abort criteria (§15.5 item 5)

After cutover, watch the first sessions on the new stack. Roll back immediately
on any of:

- any `uncertain-write` rendering bug (the model must be told explicitly that
  a call may or may not have run),
- any credential material in logs,
- unbounded memory growth.

Rollback is the single settings edit above; there is no data migration to undo.
