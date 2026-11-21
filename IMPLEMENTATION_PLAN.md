# IMPLEMENTATION_PLAN: client/host-side MCP library (TypeScript)

Governing brief: `PLAN.md` (unmodified; its constraints override this file). Wiki root `W` = `~/vaults/JangsWiki/Wiki/mcp`; spec root `S` = `W/specification/2026-07-28`. Paths written `S/...` or `W/...` are the anchors for normative claims. `SH` abbreviates `S/basic/transports/streamable-http.md`. Status of this document: **planning only**; it authorizes no code, scaffolding, deployment, publication, remote repository creation, or change to Pi.

Contents: 1 Purpose/constraints | 2 Source pins | 3 Requirement inventory | 4 Architecture | 5 Wire & lifecycle | 6 stdio | 7 Streamable HTTP | 8 Operations | 9 MRTR/elicitation/subscriptions/caching | 10 Authorization & consent | 11 Telemetry/errors/limits | 12 Optional extensions | 13 Fixtures & synthetic server | 14 Spec gate | 15 Pi adapters | 16 Waves & slices | 17 Risks, questions, decisions.

## 1. Purpose and constraints

This plan expands `PLAN.md` into executable work. It is planning only: no code, scaffolding, tests or `docs/conformance/*` files are produced by this card.

### 1.1 Non-negotiables (restated from PLAN.md)

| # | Constraint | Consequence for the plan |
|---|---|---|
| N1 | New library built from official specifications; **not** an SDK fork, **not** a fork of `pi-mcp-ext` or Pi. | No file is copied or ported from any MCP implementation. Writers cite `S/...` or `W/...` anchors for every behavior. |
| N2 | `pi-mcp-ext` (`~/Projects/pi-mcp-ext`) and `~/pi/packages/mcp` are **not wire references**. | They are read only in section 15, only for host integration surfaces (tool registration, permissions, session lifecycle), with file:line cites. Tests never derive expected bytes from them. |
| N3 | Official conformance runners may exercise the implementation as black boxes only. | `packages/conformance` shells out to the runner; no runner source is imported or read for design. |
| N4 | General-purpose JSON Schema, crypto, HTTP, UI libraries are allowed if justified and pinned. | Dependency policy in 4.7; each dependency gets a row in `docs/deps.md` (written in Wave 1) with justification, pin, and removal test. |
| N5 | The protocol library imports **no Pi package**. | Enforced by a dependency-cruiser/lint rule and a gate scenario that runs in a process whose module resolution has no Pi packages (deny-list in `packages/conformance/deny-pi.json`) (14.2). Pi code lives only under `adapters/`. |
| N6 | Primary profile **MCP 2026-07-28**, tag `5f5440bb26a62e2cf3440b92da5a667efa03b267`. | Every applicable client requirement has a row in section 3 with a disposition. |
| N7 | Lookback anchored **2026-11-19**; earliest eligible compatibility revision **2026-05-19**. `2025-11-25` predates it. | No `initialize`/`notifications/initialized` fallback, no `Mcp-Session-Id` handling, no GET/DELETE session endpoints, no `Last-Event-ID`/SSE event-id resume, no HTTP+SSE (2024-11-05) transport. A legacy peer yields an actionable `unsupported-version` diagnostic (5.5). No intermediate revision between 2026-05-19 and 2026-07-28 is known to exist in the wiki: UNRESOLVED (see 17, Q1) - verify against the upstream tag list before declaring the lookback set is `{2026-07-28}` only. |
| N8 | Deprecated/excluded: Roots, Sampling (incl. `includeContext`), MCP Logging (`logging/setLevel`, `notifications/message`, `io.modelcontextprotocol/logLevel`), HTTP+SSE. Dynamic Client Registration is **deprecated; opt-in only (host enables), default off**. | Listed explicitly in 3.3 with the exact deprecation registry (`S/deprecated.md`, `S/changelog.md#Deprecated`). Roots, Sampling, Logging, and HTTP+SSE are not implemented, advertised, or stubbed. DCR reads `registration_endpoint` without POSTing by default; explicit host opt-in enables it for back-compat. |
| N9 | Preserve separately: active transport progress (`notifications/progress`), stdio stderr diagnostics, OpenTelemetry. | Three distinct interfaces in 4.5; no code path funnels one into another. |
| N10 | Optionals (Tasks, Skills, Client Credentials, Enterprise-Managed Authorization, Apps, Server Cards) and SEP-3415 Events are independent, opt-in packages advertised only when working. | Section 12; each has a removal test. |
| N11 | **Events** stays draft-labeled and off by default; may be enabled only by explicit request. Not core conformance evidence. | `packages/ext-events` ships `defaultEnabled: false`; gate excludes it from core claims (14.4). |
| N12 | No deployment, remote repository creation, or publication, in Wave 0 (and this plan adds none to any wave). | Packages are `"private": true`; no CI publishing workflows are planned. Publication is a separate director decision (17). |
| N13 | Wiki and dated tag disagree -> resolve before encoding a test. | Reconciliation procedure in 2.4. |
| N14 | An ambiguous interrupted write must never become an unreported duplicate side effect. | Outcome `uncertain-write` (4.4), per-binding recovery (6.5, 7.8), fixtures in section 13. |
| N15 | Keep per-request state/cancellation separate from transport lifetime. | `RequestContext` vs `Transport` (4.3, 4.6). |
| N16 | No UI shell, background agent wake, or user workflow policy in core. | Host interfaces (`ConsentPort`, `BrowserPort`, `IdentityPort`, `StoragePort`, `ListenerPort`) are narrow and optional (4.5). |

### 1.2 Role and profile

- Role: **client/host-side only**. Server-only requirements are recorded as `excluded (server role)` rows where a client may observe them, and otherwise not enumerated. The synthetic server (section 13) is a test fixture, never shipped (no `bin`, no export from published entry points).
- Profile: `2026-07-28` Modern. `Modern <-> Legacy` is the "Fails" cell in `S/basic/versioning.md#Compatibility Matrix`; our client is Modern-only, so we implement the Modern/Modern row and produce a diagnostic for Modern/Legacy.
- Language/runtime: TypeScript (strict, ESM), Node >= 22 LTS (UNRESOLVED: confirm the minimum Node the Pi fork runs on, 15.1). `fetch`/`ReadableStream`/`AbortSignal` are the platform baseline; no Node-only API in `packages/core`.

## 2. Source pins

Every authoritative source is pinned independently. A pin is a (kind, id, observed-at) triple and is re-verified at Wave 0 start (command column).

### 2.1 Pin table

| Pin | Value | Observed | How to re-verify | Used for |
|---|---|---|---|---|
| Spec revision | `2026-07-28` | - | - | Primary profile |
| Spec dated tag | `5f5440bb26a62e2cf3440b92da5a667efa03b267` | PLAN.md | `git ls-remote https://github.com/modelcontextprotocol/modelcontextprotocol refs/tags/2026-07-28*` must print that SHA (UNRESOLVED if the tag is annotated: compare the peeled `^{}` SHA too) | Authoritative text for all `S/` rows |
| Wiki mirror (docs) | `docs@de3550c9fea3` (`modelcontextprotocol/modelcontextprotocol@de3550c9`) | `W/index.md` frontmatter, `fetched: 2026-11-16T17:54:05Z` | `head -12 W/index.md` | Reading copy of the spec; **not** authoritative over the tag |
| Wiki mirror (SEP-3415) | `sep-3415@4165cc2e580a` (`@4165cc2e`) | same frontmatter; `W/seps/3415-events-extension.md` | `grep -m1 '^commit:' W/seps/3415-events-extension.md` | Events text as of Nov. 16 |
| SEP-3415 upstream PR head | `60b15c16f2e7265ea34ac51099dc5be62f734692` | checked Nov. 19 (PLAN.md) | `git ls-remote <repo> refs/pull/3415/head` | Events authoritative text; wiki mirror is **behind** it |
| Extension page revisions | All extension pages in the wiki (`W/extensions/{overview,client-matrix}.md`, `tasks/overview`, `skills/overview`, `apps/{overview,build}`, `auth/{overview,oauth-client-credentials,enterprise-managed-authorization}`) carry `docs@de3550c9fea3`; SEPs 2243, 2106, 2164, 2549, 414, 2127, 3392 also `@de3550c9`; SEP-3415 alone is `@4165cc2e`. | frontmatter scan on 2026-11-19 | `for f in W/extensions/**.md W/seps/*.md; do grep -m1 '^commit:' $f; done` | Each extension subsection in 12 records its own pin |
| Extension upstream repos | Several official extensions live in separate repos (Apps, Skills, auth extensions). Their upstream revisions are not recorded in the wiki. UNRESOLVED: Wave 0 Extensions lane records the upstream repo + commit for each, or states "wiki page only". | - | - | 12 |
| Pi fork installed build | `next-7d80b45f62f8` (`pi --version` printed `1.5.2`; the build id is as stated in PLAN.md and is UNRESOLVED from the CLI output alone) | planning | `pi --version`; inspect the install manifest | Adapter target, section 15 |
| Pi fork checkout | PLAN.md says `e903c27bb`. Observed 2026-11-19: `~/pi` branch `next` HEAD is `7d80b45f6` (2026-11-19, "Merge branch 'fork/tooling' into next"). `e903c27bbd864a81f40941ae1d93b42585b20c6d` exists in the repo but **is not an ancestor of HEAD** (105 commits in `e903c27bb..HEAD`, 94 in `HEAD..e903c27bb`). | observed | `git -C ~/pi rev-parse HEAD; git -C ~/pi merge-base --is-ancestor e903c27bb HEAD` | The installed build matches HEAD `7d80b45f6`; `e903c27bb` is a divergent line. Director must say which one adapters pin (17, Q3). |

### 2.2 Observed discrepancies already known

1. `W/seps/3415-events-extension.md` table lists **Status: Accepted**, while PLAN.md requires Events to be treated as draft-labeled and off by default. Resolution: PLAN.md governs (N11); the Wave 0 Extensions lane records the label found in the upstream PR head `60b15c16...` and states that the plan's off-by-default rule holds regardless.
2. The Nov. 16 wiki mirror of SEP-3415 (`4165cc2e580a`) trails PR head `60b15c16...`. Any Events requirement row is marked `unresolved-pending-pin` until its anchor is re-read at `60b15c16...` (2.4 step 3).
3. The `~/pi` checkout drift described above.

### 2.3 Pin hygiene rules

- Every requirement row (section 3) and every fixture header carries `pin:` (`tag`, `wiki`, `sep-pr-head`, or `ext-page`) naming which source it was derived from.
- A fixture's `source` field stores the anchor `page#heading`, never a line number, because wiki line numbers drift.
- `docs/conformance/PINS.md` (Wave 0, owned by the director, not a lane) is the only file listing pin values; lanes link to it.

### 2.4 Wiki-vs-dated-tag reconciliation procedure

Run before encoding any test whose requirement came from the wiki:

1. **Locate** the clause at the tag: fetch the page at `5f5440bb26a62e2cf3440b92da5a667efa03b267` (git `show <tag>:docs/specification/2026-07-28/<page>.mdx`; exact path in repo: UNRESOLVED, find it with `git ls-tree -r <tag> --name-only | grep <page>`). The wiki's own `W/manifest.json` gives the page list.
2. **Diff** normalized text: strip frontmatter, MDX components, link-rewrites (`../../` vs absolute URLs), and heading anchors; compare only sentences containing `MUST|SHOULD|MAY|MUST NOT|SHOULD NOT` plus tables and code samples.
3. **Classify**: `same` (record `pin: tag`), `wording-only` (record the tag wording), `semantic` (record both, mark row `unresolved` and open a director question), `wiki-only` (not in the tag: the row is excluded; wiki text is a derived artefact), `tag-only` (add row).
4. For SEPs and extensions pinned to a PR head rather than the tag, apply the same procedure against the PR head SHA, and record the "behind by N commits" distance.
5. **Schema check**: `S/schema.md` is a mirror of the dated schema; the authoritative field set is `schema/2026-07-28/schema.json` at the tag (path: UNRESOLVED). Generate TypeScript types from the tag's `schema.json` (4.7), not from the wiki prose. A prose/schema disagreement is a `semantic` difference.
6. Log each outcome as one line in `docs/conformance/RECONCILIATION.md` (director-owned): `page | clause | class | action`.
7. A fixture is allowed to land only if its row's reconciliation status is `same` or `wording-only`, or the director has recorded a decision.

## 3. Requirement inventory

Every normative client-relevant statement gets one row. Rows are seeded here (sections 5-12 add them as they are written), re-derived against the dated tag by the Wave 0 lanes (16.1), and become `docs/conformance/*.md` tables. The row is the unit of the release claim (14.4).

### 3.1 ID scheme
| Prefix | Meaning | Written in | Owner lane |
|---|---|---|---|
| `WIRE-` | envelopes, ids, `_meta`, result/error handling, cancel, timeouts | 5 | wire |
| `LIFE-` | lifecycle (removed handshake, statelessness) | 5, 8.9 | wire |
| `VER-` | version negotiation, discover, legacy diagnostics | 5 | wire |
| `STDIO-`, `HTTP-` | transport bindings | 6, 7 | wire |
| `PROG-` | progress | 5 | wire |
| `OPS-TOOLS-`, `OPS-RES-`, `OPS-PROMPT-`, `OPS-COMP-`, `OPS-SCHEMA-`, `OPS-GATE-` | operations | 8 | operations |
| `PAGE-` | pagination | 8 | operations |
| `DISC-` | `server/discover` result | 5 | operations |
| `MRTR-`, `ELIC-`, `SUB-`, `CACHE-` | multi round-trip, elicitation, subscriptions, caching | 9 | operations |
| `AUTH-`, `CONSENT-` | authorization, host consent | 10 | authorization |
| `SEC-` | cross-cutting security (icons, logging hygiene, args display) | 8.9, 10 | operations / authorization |
| `TEL-`, `ERR-`, `LIM-`, `EDGE-`, `API-` | telemetry, error taxonomy, limits, edge cases, public API shape | 11 | wire |
| `EXT-<name>-` | extension rows (`tasks`, `skills`, `cc`, `ema`, `apps`, `card`, `events`, `EXP`; shared `EXT-REG/CAP/REV/RES/STREAM/REMOVE/PIN-`) | 12 | extensions / authorization |
| `DEP-` | deprecated or removed features (negative rows) | 3.3 | operations |
| `ARCH-`, `FIX-`, `GATE-`, `PICA-`, `PICD-`, `CUT-` | architecture, fixtures, gate, adapters, cutover | 4, 13-15 | director |
Range notation `X-1..4` means several consecutive rows with the same pattern; Wave 0 lanes expand each into individual rows (one observable check per row).

### 3.2 Columns and vocabulary
`ID | anchor | role | strength | condition | default | disposition | acceptance check`
- **anchor**: `page#heading` relative to `S/` (`W/` for wiki outside the dated spec); never line numbers (2.3).
- **role**: `C` client, `S` server, `B` both, `host` host/adapter.
- **strength**: RFC 2119 term quoted from the anchor, or `derived` (implied by an anchor plus PLAN.md, e.g. safety consequences), or `n/a` (negative rows).
- **disposition**: `required` (implement; claim), `active-optional` (a MAY/SHOULD or opt-in feature we implement; claim if it passes), `conditional` (applies only when the condition holds, e.g. host renders icons), `deprecated` (present in spec, not implemented; negative check), `excluded` (removed or outside the lookback/PLAN.md; negative check), `unresolved` (cannot be decided from pinned sources; named question, non-claim), `out-of-scope` (server-role statements). Rows seen without a disposition in a lane file fail `check:coverage`.
- **default**: behavior when the host configures nothing.

### 3.3 Explicit deprecated / excluded / removed list
Confirmed from `S/deprecated.md` and `S/changelog.md#Deprecated`/`#Major changes` (text read at the Nov. 16 mirror; **re-confirm against the dated tag** per PLAN.md, row `DEP-CONFIRM-1`).

| Feature | State at 2026-07-28 | Source | Disposition in this project | Negative check |
|---|---|---|---|---|
| Roots (`roots/list`, `notifications/roots/list_changed`) | Deprecated (SEP-2577); `notifications/roots/list_changed` removed | `S/deprecated.md`; changelog major 5 | **excluded**: no capability, no handling; `roots/list` input request => `unsupported-input-request` | `DEP-ROOTS-1`, `MRTR-C-8` |
| Sampling (`sampling/createMessage`) incl. `includeContext: "thisServer"/"allServers"` | Deprecated (SEP-2577; SEP-2596 for includeContext) | same | **excluded** | `DEP-SAMPLING-1`, `MRTR-C-8` |
| MCP Logging (`logging/setLevel` removed; `notifications/message`; `_meta` `logLevel`) | Deprecated (SEP-2577); `logging/setLevel` removed | same; changelog major 5 | **excluded**: never send `logLevel`; stray notifications dropped | `WIRE-LOG-1` |
| Dynamic Client Registration (RFC 7591) | Deprecated (PR #2858): remains for back-compat | `S/deprecated.md`; changelog Deprecated 4 | **deprecated; opt-in only (host enables), default off**: pre-registered, then CIMD, then DCR when enabled, then client-info prompt; `registration_endpoint` read but never POSTed by default | `AUTH-DCR-1` |
| HTTP+SSE transport (2024-11-05) | Deprecated since 2025-03-26; SEP-2596 | `S/deprecated.md`; `SH#HTTP+SSE Transport` | **excluded** | `HTTP-SSEOLD-1` |
| `initialize` / `notifications/initialized` handshake | Removed (SEP-2575) | changelog major 2 | **excluded** (also outside lookback, N7) | `VER-NOFALLBACK-1`, `LIFE-1` |
| `Mcp-Session-Id`, GET stream, DELETE | Removed (SEP-2567, SEP-2575) | changelog major 1, 4; `SH#Earlier Streamable HTTP Revisions` | **excluded** | `HTTP-NOGET-1`, `HTTP-NOSESS-1` |
| SSE resumability (`Last-Event-ID`, event ids) | Removed | changelog major 9 | **excluded** | `HTTP-NORESUME-1` |
| `resources/subscribe` / `unsubscribe` | Replaced by `subscriptions/listen` | changelog major 4 | **excluded** | `SUB-OLD-1` |
| `ping` | Removed | changelog major 5 | **excluded** | `LIFE-2` |
| `tasks/*` in core (`tasks/result`, `tasks/list`) | Moved to extension; blocking/list removed | changelog major 6 | **excluded from core**; extension only | `EXT-RES-1` |
| Server-initiated requests (`roots/list`, `sampling/createMessage`, `elicitation/create`) | Replaced by MRTR | changelog major 7 | **excluded** (violation if received) | `WIRE-DIR-2` |
| `notifications/elicitation/complete`, `elicitationId`, error `-32042` | Removed | changelog minor 11; `S/basic/index.md#Error Codes` | **excluded** | `ELIC-REM-1`, `EDGE-34` |
| Resource-not-found `-32002` | Replaced by `-32602`; clients SHOULD still accept `-32002` | changelog minor 6; `S/server/resources.md#Error Handling` | **accepted on receive only** | `OPS-RES-ERR-1` |
| `application_type` requirement for DCR (SEP-837) | applies to DCR users only | changelog minor 8 | **conditional**: send `application_type` native/web when DCR is enabled | `AUTH-DCR-2` |
| Missing `resultType` from earlier servers | clients MUST treat as `complete` | `S/basic/index.md#ResultType` | **required** (cheap, spec-mandated; not a legacy fallback) | `WIRE-RT-2` |
| Initialization-based legacy peers (2025-11-25 and earlier) | outside six-month lookback (earliest eligible 2026-05-19) | PLAN.md | **excluded**; diagnostic only | `VER-DIAG-1` |
| Experimental items without pin: interceptors, variants, tool-annotations | Experimental | 12.8 | **excluded (no pin)** | `EXT-EXP-*` |
| Events (SEP-3415) | draft; off by default | PLAN.md | **active-optional only on explicit request** | `EXT-events-*` |

### 3.4 Inventory (rows)
Rows from sections 4-15 follow in section order. Server-role statements (`HTTP-SRV-*`, `AUTH-SRV-*`, server `MUST` items marked in notes) are kept explicit as `out-of-scope`. The count and dispositions are summarised in 3.5.

| ID | Anchor | Role | Strength | Condition | Default | Disposition | Acceptance check |
|---|---|---|---|---|---|---|---|
| ARCH-REQ-1..3 | S/architecture/index.md#Clients; S/basic/index.md#Statelessness; PLAN.md Core | C | derived | request state vs transport | isolation | required | fixtures `arch/cancel-isolated`, `arch/transport-restart-no-inherit` |
| ARCH-LIFE-1 | PLAN.md Core | C | derived | close | settle all with certainty | required | fixture `arch/close-settles-all` |
| ARCH-STATE-1 | S/basic/index.md#Statelessness | C | derived | caches/subscriptions | not in transport | required | fixture `arch/cache-survives-transport-restart-flagged` |
| ARCH-SF-1 | derived | C | - | single-flight | no cross-auth | required | covered by CACHE-SF-1 |
| ARCH-DEP-1 | PLAN.md (no Pi in protocol lib) | - | derived | imports | dependency rules | required | `npm run check:deps` |
| ARCH-DEP-2 | PLAN.md first paragraph | - | derived | lockfile | no SDK/pi-mcp | required | `npm run check:forbidden` |
| ARCH-DEP-3 | PLAN.md first paragraph | - | derived | deps justified | row per dep | required | `npm run check:deps-doc` |
| WIRE-ID-1 | S/basic/index.md#Requests | C | MUST | request id is string/int, non-null, unique per sender | n/a | required | unit: id generator never yields null/dup over 1e5 ids; fixture `wire/id-unique` |
| WIRE-DIR-1 | S/basic/patterns/index.md | C | MUST NOT | client sends only requests + notifications | - | required | type-level: `Transport.send` rejects response envelopes; unit |
| WIRE-DIR-2 | S/basic/patterns/index.md | S | MUST NOT | server-initiated request received | - | required (client reaction) | fixture `wire/server-request-ignored`: no reply written, diagnostic emitted |
| WIRE-META-1 | S/basic/index.md#General fields | C | MUST | every request | protocolVersion=2026-07-28 | required | fixture asserts key on 100% of outbound requests (property test over all ops) |
| WIRE-META-2 | same | C | MUST | every request | computed capabilities | required | fixture: capabilities reflect registered+working extensions only |
| WIRE-META-3 | same | C | SHOULD | unless configured off | clientInfo sent | required | fixture with/without config |
| WIRE-META-4 | same | C | MUST | caller meta merge | reserved keys not overridable | required | unit |
| WIRE-META-5 | S/basic/index.md#_meta | C | MUST | registering `_meta` keys | validate syntax | required | unit table of valid/invalid keys |
| WIRE-LOG-1 | S/basic/index.md (logLevel row), S/server/utilities/logging.md | C | n/a | logging deprecated | never send logLevel; drop notifications/message | excluded (deprecated) | fixture: no logLevel on any request; stray `notifications/message` dropped+counted |
| WIRE-RT-2 | S/basic/index.md#ResultType | C | MUST | result lacks resultType | treat as complete | required | fixture `wire/resulttype-absent` |
| WIRE-RT-3 | same | C | MUST | unknown resultType | invalid | required | fixture `wire/resulttype-unknown` -> `protocol-violation` |
| WIRE-ERR-2 | S/basic/index.md#Error Responses | C | MAY | error with unreadable id | diagnostic only | required | fixture |
| WIRE-ERR-3 | S/basic/index.md#Error Codes | C | MUST NOT | unknown code in -32020..-32099 | typed unknown-reserved | required | unit |
| WIRE-CANCEL-1 | S/basic/patterns/cancellation.md#Behavior Requirements | C | MUST | cancel only own in-flight requests | - | required | unit: cancel after settle sends nothing |
| WIRE-CANCEL-3 | same | C | SHOULD | response after cancel | ignore | required | fixture `wire/late-response-after-cancel` |
| WIRE-CANCEL-4 | same | S->C | MUST | server cancelled only for listen streams | accept only listen ids | required | fixture: cancelled for non-listen id ignored |
| WIRE-CANCEL-5 | same + PLAN.md N14 | C | derived | cancelled/timed-out write | `uncertain-write` if no response observed | required | fixture `wire/cancel-write-uncertain` |
| WIRE-TO-1 | S/basic/patterns/cancellation.md#Timeouts | C | SHOULD | every request | 60 s, per-request override | required | fake-clock unit |
| WIRE-TO-2 | same | C | SHOULD | progress resets | off; hard max always | active-optional | fake-clock unit |
| WIRE-STATE-1 | S/basic/index.md#Statelessness | B | SHOULD NOT | rely on connection | - | required | fixture: restart process mid-session, semantics unchanged |
| WIRE-STATE-2 | same | C | MUST | handles by explicit id | - | required | review + fixture with requestState/taskId |
| VER-1 | S/basic/versioning.md | C | MUST | each request | send version | required | covered by WIRE-META-1 |
| VER-2 | S/basic/versioning.md#Protocol Version Negotiation | C | SHOULD | -32022 with supported list | retry with mutual version | required | fixture `ver/unsupported-retry-ok` (synthetic server lists 2026-07-28 + 2099-01-01) |
| VER-3 | same | C | SHOULD | no mutual version | surface error | required | fixture `ver/unsupported-no-mutual` |
| VER-4 | derived | C | - | loop guard | one retry | required | fixture: server keeps returning -32022 -> fails after 1 retry |
| VER-5 | S/server/discover.md#When to Call | C | MAY | pre-flight | on(stdio)/off(HTTP) | active-optional | fixture `ver/discover-ok` |
| VER-6 | S/server/discover.md (note) | C | SHOULD NOT | serverInfo | display only | required | review: no branch on serverInfo (grep rule in lint) |
| VER-7 | S/basic/index.md (clientCapabilities) | C | derived | -32021 | typed outcome | required | fixture `ver/missing-capability` |
| VER-NOFALLBACK-1 | PLAN.md N7; S/basic/versioning.md | C | - | legacy peer | no initialize | excluded (lookback) | fixture: legacy server sees zero `initialize` bytes; diagnostic emitted |
| VER-DIAG-1 | PLAN.md N7 | C | - | legacy/other | actionable diagnostic | required | fixture asserts diagnostic fields |
| VER-CACHE-1 | S/basic/versioning.md#Backward Compat | C | SHOULD | era cache | in memory only | required | unit |
| PROG-1 | S/basic/patterns/progress.md | C | MUST | progressToken | unique across active requests | required | unit |
| PROG-2 | same | C | MUST | progress increases | drop violators | required | fixture `prog/non-monotonic` |
| PROG-3 | same | C | MUST | token must be active | drop others | required | fixture |
| PROG-4 | same | C | MUST | stop after completion | drop late | required | fixture |
| DISC-1 | S/server/discover.md#Response | S | MUST | server implements | client parses DiscoverResult | required | fixture `ver/discover-ok` |
| STDIO-FRAME-1 | S/basic/transports/stdio.md | B | MUST | outbound | no embedded newline | required | unit: any JSON value serializes to one line |
| STDIO-FRAME-2 | same | C | MUST | inbound | newline-delimited, UTF-8 split safe | required | fixture `stdio/frame-split-multibyte` |
| STDIO-STDOUT-1 | same | S | MUST NOT | server stdout noise | skip+budget | required (client reaction) | fixture `stdio/noise-line` |
| STDIO-STDIN-1 | same | C | MUST NOT | client writes only valid MCP messages | - | required | fixture: server records raw stdin; all lines parse as JSON-RPC |
| STDIO-STDERR-1 | same | C | MAY/SHOULD NOT | stderr | capture, not an error | required | fixture `stdio/stderr-not-error` |
| STDIO-ROUTE-1 | same | C | MUST | progress | route by token | required | fixture |
| STDIO-ROUTE-2 | same | C | MUST | subscription notifications | route by subscriptionId | required | fixture `sub/two-listeners-demux` |
| STDIO-CONC-1 | same | C | derived | simultaneous requests | out-of-order responses | required | fixture `stdio/concurrent-out-of-order` |
| STDIO-CANCEL-1 | S/basic/transports/stdio.md#Cancellation | C | MUST | cancel | send notifications/cancelled | required | fixture `stdio/cancel-inflight` |
| STDIO-SHUT-1 | same#Shutdown | C | SHOULD | close | stdin close -> wait -> term -> kill | required | fixture `stdio/shutdown-escalation` |
| STDIO-CRASH-1 | same#Unexpected Termination | C | SHOULD | exit | restart (default on-demand), in-flight lost, listen re-established | required | fixtures `stdio/crash-*` |
| STDIO-RECOVER-1 | PLAN.md N14 + stdio.md | C | derived | write ambiguous | uncertain-write, no auto retry | required | fixture `stdio/crash-write-uncertain` |
| STDIO-DISC-1 | same#Backward Compatibility | C | SHOULD(RECOMMENDED) | first use | probe server/discover | required | fixture `stdio/legacy-peer-diagnostic` |
| STDIO-LAUNCH-1 | derived (security) | C | - | spawn | shell:false | required | unit |
| STDIO-LIMIT-1 | derived (11.3) | C | - | line size | 16 MiB cap | required | fixture `stdio/oversize-line` |
| STDIO-AUTH-1 | S/basic/index.md#Auth | C | SHOULD NOT | stdio | no OAuth; env creds | required | review + unit: auth module not loadable from stdio transport |
| HTTP-NOGET-1 | S/basic/transports/streamable-http.md#Earlier Streamable HTTP Revisions; changelog major 4 | C | n/a | - | never GET | excluded | fixture `http/no-get-no-delete-no-session`: server logs only POST |
| HTTP-NOSESS-1 | same; changelog major 1 | C | n/a | - | ignore/never echo Mcp-Session-Id | excluded | fixture `http/session-id-header-ignored` |
| HTTP-NORESUME-1 | SH#Receiving Messages ("Resumable SSE streams via Last-Event-ID are not supported") | C | n/a | - | no Last-Event-ID | excluded | fixture `http/sse-id-retry-ignored` |
| HTTP-REQ-1 | SH#Sending Messages | C | MUST | POST | JSON body | required | fixture header assertion |
| HTTP-REQ-2 | same | C | MUST | body single message | - | required | unit |
| HTTP-REQ-3 | same | C | MUST | Accept lists both | - | required | fixture `http/accept-both` |
| HTTP-HDR-1 | SH#Protocol Version Header | C | MUST | every POST | MCP-Protocol-Version | required | fixture; mismatch with body is impossible by construction |
| HTTP-HDR-2 | SH#Standard Request Headers | C | MUST | every request | Mcp-Method | required | fixture |
| HTTP-HDR-3 | same | C | MUST | tools/call, resources/read, prompts/get | Mcp-Name | required | fixture incl. base64 name |
| HTTP-CASE-1 | SH#Case Sensitivity; SEP-2243 | B | MUST | header name compare | case-insensitive | required | unit with mixed case |
| HTTP-ENC-1 | SH#Value Encoding | C | MUST | non-ASCII/ws/sentinel-lookalike | base64 sentinel | required | vector tests (5 spec vectors) |
| HTTP-ENC-3 | same | C | MUST | Mcp-Name | same rule | required | fixture |
| HTTP-PARAM-1 | SH#Schema Extension | C | MUST | HTTP tools/list | validate x-mcp-header | required | fixture table of valid/invalid schemas |
| HTTP-PARAM-2 | same | C | MUST/SHOULD | invalid | exclude tool, warn | required | fixture `http/x-mcp-header-invalid-tool-excluded` |
| HTTP-PARAM-3 | SH#Schema Extension | C | MAY | stdio | ignore | active-optional | fixture |
| HTTP-PARAM-4 | SH#Client Behavior | C | MUST | tools/call | mirror; omit if absent/null | required | fixture `http/x-mcp-header-valid` |
| HTTP-PARAM-5 | SEP-2243 implementation note | C | MUST/SHOULD | schema never obtained | no Mcp-Param | required | fixture |
| HTTP-PARAM-6 | SH#Client Behavior | C | SHOULD | HeaderMismatch | tools/list then retry | required | fixture `http/header-mismatch-refresh-retry-once` |
| HTTP-NOTIF-1 | SH#Sending Messages | C | derived | notification POST | expect 202 | required | fixture |
| HTTP-RESP-1 | SH#Sending Messages item 6 | C | MUST | request | support JSON response | required | fixture `http/json-response` |
| HTTP-RESP-2 | same | C | MUST | request | support SSE response | required | fixture |
| HTTP-RESP-3 | derived | C | - | 202 for request | violation | required | fixture |
| HTTP-RESP-4 | derived | C | - | unexpected content-type | violation | required | fixture |
| HTTP-ERR-1..6 | SH#Protocol Version Header, #Server Validation, #Backward Compatibility | C | MUST/SHOULD | per status | see 7.4 | required | fixtures `http/400-modern-error-vs-legacy` etc |
| HTTP-ERR-7 | derived (SEP-2243 "413/431 clients must handle") | C | MUST handle | oversize header | typed failure | required | fixture |
| HTTP-ERR-8 | derived + N14 | C | - | 5xx/429 | uncertain-write for writes | required | fixture `http/5xx-write-uncertain` |
| HTTP-REDIR-1 | derived (SEC) | C | - | redirects | manual, same-origin | required | fixture |
| HTTP-SSE-1 | SH#Receiving Messages (comment note) | C | MUST | comment lines | ignore | required | fixture `http/sse-comment-keepalive` |
| HTTP-SSE-2..8 | SH#Receiving Messages | C | MUST/SHOULD | SSE handling | see 7.5 | required | fixtures |
| HTTP-CANCEL-1 | SH#Cancellation | C | MUST (server side) | abort | close stream, no notification | required | fixture `http/abort-closes-stream`: server sees disconnect, receives no notifications/cancelled |
| HTTP-RETRY-1 | changelog major 9; SH | C | MUST | broken stream | new request, new id | required | fixture `http/stream-break-read-reissue-new-id` |
| HTTP-AMBIG-1..5 | PLAN.md N14 | C | derived | write ambiguity | uncertain-write, no silent retry | required | fixture `http/stream-break-write-uncertain` |
| HTTP-LIMIT-1 | derived (11.3) | C | - | bounds | defaults in 11.3 | required | fixtures |
| HTTP-SRV-* | SH#Security & Endpoint, #Server Validation | S | MUST | server rules | - | out-of-scope (server role) | none; synthetic server mirrors for tests |
| HTTP-SSEOLD-1 | S/deprecated.md (HTTP+SSE) | C | n/a | 2024-11-05 transport | not implemented | excluded (deprecated) | fixture: legacy-endpoint diagnostic |
| OPS-GATE-1 | S/server/{tools,prompts,resources}.md#Capabilities | C | derived (MUST for servers to declare) | capability absent | no call | required | fixture `ops/capability-absent-no-wire-call` |
| PAGE-1 | S/server/utilities/pagination.md | C | SHOULD | nextCursor present | follow until absent | required | fixture multi-page |
| PAGE-2 | same#Implementation Guidelines | C | MUST | empty-string cursor | valid, continue | required | fixture `ops/tools-list-paginated-empty-cursor` |
| PAGE-3 | same | C | MUST | cursor opacity | never parse/modify | required | review + fuzz: cursor bytes echoed verbatim |
| PAGE-4 | same | C | MUST NOT | page size | no assumption | required | fixture pages of size 1,2,0 |
| PAGE-5 | derived (11.3) | C | - | cursor loops | guard | required | fixture `ops/tools-list-cursor-loop` |
| PAGE-6 | same#Error Handling | C | SHOULD(server) | invalid cursor | -32602 surfaced | required | fixture |
| OPS-TOOLS-1 | S/server/tools.md#Listing Tools | C | MUST(server) | tools/list | cacheable paginated | required | fixture |
| OPS-TOOLS-2 | S/server/tools.md#Capabilities | C | SHOULD(server) | order | preserve received order | required | fixture order stability |
| OPS-TOOLS-3 | same | S | MUST NOT | per-connection variance | cache keyed by credential, not connection | required | covered by CACHE-KEY-1 |
| OPS-TOOLS-5 | S/server/tools.md#Tool | C | MUST(server) | inputSchema not object | exclude+warn | required | fixture `ops/tools-null-inputSchema-excluded` |
| OPS-TOOLS-6 | S/server/tools.md#Tool (warning) | C | MUST | annotations | untrusted by default | required | unit: annotations never alter retry policy |
| OPS-TOOLS-7 | S/server/tools.md#Calling Tools | C | - | tools/call | params shape | required | fixture |
| OPS-TOOLS-8 | S/server/tools.md#Error Handling | C | SHOULD | isError | tool-isError outcome | required | fixture `ops/tools-call-isError` |
| OPS-TOOLS-9 | same | C | - | protocol error | jsonrpc-error | required | fixture |
| OPS-TOOLS-10 | S/server/tools.md#Structured Content; SEP-2106 | C | - | any JSON | accept all | required | fixture `ops/tools-call-ok-structured-array` |
| OPS-TOOLS-11 | S/server/tools.md#Output Schema | C | SHOULD | outputSchema | validate | required | fixture `ops/tools-output-schema-violation` |
| OPS-TOOLS-12 | S/server/tools.md#Security Considerations | C | SHOULD | pre-send | validate inputs | active-optional (default on) | fixture |
| OPS-TOOLS-13 | S/server/tools.md#Tool Result | C | - | content types | pass-through incl unknown | required | fixture `ops/content-unknown-type-preserved` |
| OPS-TOOLS-14 | S/server/tools.md (content) | C | MUST(server) | base64/mime | validate | required | fixture `ops/content-invalid-base64` |
| OPS-TOOLS-15 | PLAN.md (raw vs bounded) | C | derived | result size | raw returned | required | unit |
| OPS-TOOLS-17 | S/server/tools.md#Security Considerations | C | SHOULD | confirm/audit | hook points | conditional (host policy) | unit: veto hook prevents wire send |
| OPS-PROMPT-1 | S/server/prompts.md | C | MUST(server) | prompts/list | paginated cacheable | required | fixture |
| OPS-PROMPT-2 | same | C | - | prompts/get | messages | required | fixture |
| OPS-PROMPT-4 | same#Image/Audio Content | C | MUST(server) | base64+mime | validate | required | fixture |
| OPS-PROMPT-5 | same#Error Handling | C | SHOULD(server) | errors | map -32602/-32603 | required | fixture |
| OPS-RES-1 | S/server/resources.md | C | - | resources/list | paginated cacheable | required | fixture |
| OPS-RES-2 | same#Resource Templates | C | - | templates | list+expand | required | fixture `ops/resources-templates-list` |
| OPS-RES-3 | same#Reading Resources | C | - | read | text xor blob | required | fixture |
| OPS-RES-4 | same#Error Handling | C | MUST NOT(server) | empty contents | not inferred as not-found | required | fixture `ops/resources-read-empty-contents` |
| OPS-RES-ERR-1 | same#Error Handling; SEP-2164 | C | SHOULD | -32602 / -32002 | resource-not-found kind | required | fixtures `...not-found-32602`, `...-legacy-32002` |
| OPS-RES-ERR-2 | same | C | SHOULD(server) | -32603 | internal | required | fixture |
| OPS-RES-5 | same#Common URI Schemes | C | derived | https:// | client never auto-fetches | required | unit: no network in `ops` package except via transport |
| OPS-RES-6 | same#Custom URI Schemes | C | MUST(server) | RFC3986 | validate | required | unit |
| OPS-RES-7 | same#Annotations | C | - | annotations | range check | required | unit |
| OPS-COMP-1 | S/server/utilities/completion.md | C | MUST(server) | completions capability | gate | required | fixture |
| OPS-COMP-2 | same#CompleteResult | C | derived (max 100) | >100 values | truncate+flag | required | fixture `ops/completion-values-over-100` |
| OPS-COMP-3 | same#Implementation Considerations | C | SHOULD | rapid requests | latestWins helper | active-optional | fake-clock unit |
| OPS-COMP-4 | same#Error Handling | C | SHOULD(server) | -32601/-32602 | mapping | required | fixture |
| OPS-SCHEMA-1 | S/basic/index.md#Implementation Requirements | B | MUST | no $schema | 2020-12 | required | fixture with 2020-12 keywords (prefixItems, unevaluatedProperties) |
| OPS-SCHEMA-2 | same | B | MUST | other dialect | graceful error | required | fixture `ops/schema-draft07-unsupported` |
| OPS-SCHEMA-3 | same#Schema Validation | B | MUST | schema validity | compile check | required | fixture |
| OPS-SCHEMA-4 | S/basic/index.md#$ref Resolution; SEP-2106 | B | MUST NOT | network $ref | never deref | required | fixture `ops/schema-ref-network-rejected` (synthetic server counts outbound fetches = 0) |
| OPS-SCHEMA-5 | same | B | MAY | opt-in fetch | disabled; allowlist+SSRF guard | active-optional | fixture with allowlist + loopback block |
| OPS-SCHEMA-6 | S/basic/index.md#Composition-Keyword Resource Use | B | SHOULD | bounds | depth/subschemas/bytes | required | fixture `ops/schema-bomb-bounded` |
| OPS-SCHEMA-7 | SEP-2106 | C | - | structuredContent | any JSON | required | type test |
| DEP-ROOTS-1 | S/deprecated.md; S/client/roots.md | C | - | Roots | not implemented/advertised | excluded (deprecated) | fixture: capabilities never include roots |
| DEP-SAMPLING-1 | S/deprecated.md; S/client/sampling.md | C | - | Sampling/includeContext | not implemented | excluded (deprecated) | fixture: InputRequest of type sampling -> `unsupported-input-request` (9.2) |
| SEC-ICON-1 | S/basic/index.md#icons | C | MUST | icon URI scheme | https/data only | required (if icons fetched) | fixture `sec/icon-unsafe-scheme` |
| SEC-ICON-2 | same | C | MUST | redirects/origin | same-origin, no cross-origin redirect | required (if fetched) | fixture `sec/icon-cross-origin-redirect` |
| SEC-ICON-3 | same | C | MUST | credentials | none sent | required (if fetched) | fixture: spy sees no Authorization/cookies |
| SEC-ICON-4 | same | C | MAY | size limits | caps | active-optional | fixture `sec/icon-oversize` |
| SEC-ICON-5 | same | C | MUST/SHOULD | MIME | magic bytes, png/jpeg required, svg off | conditional (host renders icons) | fixture `sec/icon-mime-mismatch` |
| LIFE-1 | S/basic/versioning.md; changelog major 2 | C | n/a | handshake | no initialize / initialized | excluded (removed) | fixture `ver/no-initialize` |
| LIFE-2 | changelog major 5 | C | n/a | ping | not sent; server ping = violation | excluded (removed) | covered by EDGE-35 |
| LIFE-3 | S/basic/index.md#Statelessness | C | SHOULD NOT | task/thread as state key | explicit handles only | required | review + WIRE-STATE-2 |
| SEC-LOG-1 | derived (AGENTS secrets rule) | C | - | diagnostics | no tokens/secrets/requestState content | required | covered by AUTH-LOG-1 fixture |
| SEC-ARGS-1 | S/server/tools.md#Security Considerations | C | SHOULD | show inputs to user | hook exposes raw args | conditional (host) | OPS-TOOLS-17 |
| MRTR-SCOPE-1 | S/basic/patterns/mrtr.md#Supported Requests | S | MUST NOT | InputRequired on other methods | only tools/call, prompts/get, resources/read | required (client reaction) | fixture `mrtr/unsupported-method-rejected` |
| MRTR-SCOPE-2 | same | C | derived | violation | protocol-violation | required | fixture |
| MRTR-C-1 | same#Server Requirements 6 | S | MUST | neither field | violation | required | fixture `mrtr/neither-field-violation` |
| MRTR-C-2 | same#Client Requirements 1 | C | MUST | inputRequests present | construct inputs before retry | required | fixture `mrtr/elicit-form-accept-retry-new-id` |
| MRTR-C-3 | same | C | MAY | no inputRequests | immediate retry | required | fixture `mrtr/state-only-no-input-requests` |
| MRTR-C-4 | same#Client Requirements 2 | C | MUST/MUST NOT | requestState | echo exact, never inspect | required | fixture `mrtr/request-state-opaque-echo` (binary-ish string with whitespace, unicode, ="=" chars) |
| MRTR-C-5 | same | C | MUST NOT | no requestState | do not send one | required | fixture `mrtr/no-state-no-echo` |
| MRTR-C-6 | same#Client Requirements 3 | C | MUST | retry | new JSON-RPC id | required | fixture asserts ids differ and params otherwise identical |
| MRTR-C-7 | same#Client Requirements 4 | C | MUST NOT | parallel requests | state isolated | required | fixture `mrtr/parallel-calls-isolated-state` |
| MRTR-C-8 | S/basic/patterns/mrtr.md; S/deprecated.md | C | derived | sampling/roots/undeclared inputRequest | fail, no fabrication | required | fixture `mrtr/sampling-input-request-fails` |
| MRTR-LOOP-1 | derived (11.3) | C | - | loops | maxRounds 8 | required | fixture `mrtr/max-rounds` |
| MRTR-LOOP-2 | derived | C | - | deadline | overall deadline | required | fake-clock unit |
| MRTR-MODE-1 | PLAN.md (durable) | C | derived | manual mode | interim outcome with data | required | unit |
| MRTR-CANCEL-1 | derived | C | - | abort in consent | no retry, cancelled(phase:input) | required | fixture `mrtr/cancel-during-consent` |
| ELIC-CAP-1 | S/client/elicitation.md#Capabilities | C | MUST | declare per request | only with working ports | required | fixture `elic/capability-only-when-port` |
| ELIC-CAP-2 | same | C | MUST | at least one mode | - | required | unit |
| ELIC-MODE-1 | S/client/elicitation.md#Elicitation Requests | C | MUST | mode absent | treat as form | required | fixture |
| ELIC-FORM-1 | same#Requested Schema | C | - | form schema | flat primitives, enums, defaults | required | fixtures per type |
| ELIC-FORM-2 | same | C | derived | schema outside subset | protocol-violation | unresolved (decline vs fail) | fixture `elic/form-schema-outside-subset` after decision |
| ELIC-UI-1 | same#User Interaction Model | C | MUST | UI duties | port receives serverLabel/review/decline/cancel | conditional (host UI) | reference-port test + contract doc |
| ELIC-RESP-1 | same#Response Actions | C | - | accept/decline/cancel | three-action model | required | fixture |
| ELIC-RESP-2 | same#Form Mode Security | C | SHOULD | validate content | against requestedSchema | required | fixture `elic/form-response-validated` |
| ELIC-URL-1 | same#URL Mode | C | MUST | url valid | https only (dev http loopback opt-in) | required | fixture `elic/url-bad-scheme` |
| ELIC-URL-2 | same#Safe URL Handling | C | MUST NOT | prefetch | none | required | fixture `elic/url-no-prefetch` (network spy: zero requests) |
| ELIC-URL-3 | same | C | MUST NOT | open without consent | consent first | required | fixture |
| ELIC-URL-4 | same | C | MUST | show full URL | in consent request | required | fixture `elic/url-full-url-shown` |
| ELIC-URL-5 | same | C | MUST | secure open | BrowserPort system browser, no inspection | conditional (host browser) | contract doc + port test |
| ELIC-URL-6 | same | C | SHOULD | highlight domain, punycode warning | in consent request | required | unit |
| ELIC-URL-8 | same#URL Mode Flow | C | SHOULD | manual retry/cancel control | manual mode API | active-optional | unit |
| ELIC-REM-1 | changelog minor 11 | C | n/a | elicitation/complete, elicitationId | not implemented | excluded (removed) | fixture: notification dropped |
| ELIC-SEC-1 | same#Form Mode Security | C | derived | sensitive field names | warn | active-optional | unit |
| ELIC-AUTH-1 | same#URL Mode Elicitation for OAuth Flows | C | MUST NOT (server) | token handling | no token to URL, no authorization conflation | required | fixture: no Authorization header on any elicitation-related fetch |
| SUB-REQ-1 | S/basic/patterns/subscriptions.md | C | - | open | notifications filter | required | fixture |
| SUB-ACK-1 | same#Acknowledgment | S | MUST | first message | ack | required | fixture `sub/ack-first` |
| SUB-ACK-2..3 | derived | C | - | timeout/early notification | fail / drop | required | fixtures |
| SUB-ACK-4 | same | C | SHOULD | filter subset | handle gracefully | required | fixture `sub/ack-subset` |
| SUB-ROUTE-1 | same#Receiving Notifications | C | MUST (stdio) | subscriptionId | demux | required | fixture `sub/two-listeners-demux` |
| SUB-FILTER-1 | same#Opening a Stream | S | MUST NOT | unrequested types | drop | required | fixture `sub/unrequested-type-dropped` |
| SUB-MULTI-1 | same#Multiple Concurrent Subscriptions | C | MAY | multiple | supported | required | fixture |
| SUB-END-1..4 | same#Cancellation | B | MUST/SHOULD | end | graceful/cancelled/transport/client | required | fixtures `sub/graceful-close` etc |
| SUB-REST-1 | same#Graceful Closure | C | MUST | stdio reconnect | re-send listen | required | fixture `sub/stdio-restart-resend` |
| SUB-REST-2 | same | C | MAY | HTTP abrupt | reconnect with backoff+jitter | active-optional | fixture `sub/http-abrupt-reconnect-invalidates-cache` |
| SUB-REST-3 | derived (no resume) | C | - | gap | invalidate + resync-needed | required | same fixture |
| SUB-LIST-1 | S/server/tools.md#List Changed | C | - | list_changed | invalidates cache | required | fixture `cache/notification-invalidates` |
| SUB-RES-1 | S/server/resources.md#Subscriptions | C | - | resource updates | resourceSubscriptions | required | fixture |
| SUB-GATE-1 | derived | C | - | capability gating | only advertised types when known | required | fixture |
| SUB-OLD-1 | changelog major 4 | C | n/a | resources/subscribe, HTTP GET stream | not implemented | excluded (removed) | covered by HTTP-NOGET-1 |
| CACHE-SCOPE-1 | S/server/utilities/caching.md#Cacheable Results | C | MUST(server) | complete results of 6 ops | cacheable | required | fixture |
| CACHE-KEY-1 | same#Cache Key | C | MUST NOT | different method/params | no sharing | required | fixture `cache/cursor-in-key` |
| CACHE-MRTR-1 | same#Cache Key | C | MUST NOT | MRTR retries | not cached | required | fixture `mrtr/retry-not-cached` |
| CACHE-NEG-1 | same#Cacheable Results | C | - | input_required | no hints, not cached | required | fixture `cache/input-required-not-cached` |
| CACHE-TTL-1..4 | same#Time-to-Live; SEP-2549 | C | SHOULD | ttlMs semantics | absent/negative->0, positive fresh | required | fixture `cache/ttl-fresh-stale`, `cache/ttl-absent-negative` |
| CACHE-SCOPE-2 | same#Cache Scope Field | C | MUST | private | never across auth contexts | required | fixture `cache/private-not-shared-across-auth` |
| CACHE-SCOPE-3 | same | C | MAY | public | partition by default; share opt-in | active-optional | fixture `cache/public-default-partitioned` |
| CACHE-AUTH-1 | same; SEP-2549 | C | MUST | auth context | id definition | unresolved (token vs grant) | decision D5 then fixture |
| CACHE-PAGE-1..3 | same#Interaction with Pagination | C | SHOULD | pages | per-page entries; cursor invalid purge; scope uniformity | required | fixture `cache/invalid-cursor-purge` |
| CACHE-INV-1 | same#Interaction with Notifications | C | - | notification | invalidate | required | fixture |
| CACHE-POLL-1 | same#Freshness Calculation | C | MUST (if polling) | autoRefresh | jitter+backoff | active-optional | fake-clock unit |
| CACHE-STALE-1 | same | C | MAY | errors on refetch | stale-if-error opt-in | active-optional | fixture |
| CACHE-SEC-1 | same#Security Considerations | C | derived | 401/403 | purge private | required | fixture |
| CACHE-DISC-1 | S/server/discover.md; caching.md | C | - | discover cache | same rules | required | fixture |
| AUTH-CHAL-1 | S/basic/authorization/authorization-server-discovery.md#Protected Resource Metadata Discovery Requirements | C | MUST | 401 | parse WWW-Authenticate | required (HTTP only) | fixture `auth/401-prm-header` incl multi-challenge/quoting |
| AUTH-PRM-1 | same | C | MUST | PRM location | header URL else well-known (subpath, root) | required | fixture `auth/prm-wellknown-subpath-then-root` |
| AUTH-PRM-2 | same#Authorization Server Location | S | MUST | PRM has authorization_servers | client rejects otherwise | required | fixture |
| AUTH-PRM-3 | RFC 9728 s3.3 (derived) | C | derived | resource match | reject mismatch | required (derived; verify vs tag) | fixture |
| AUTH-AS-1 | S/basic/authorization/authorization-server-discovery.md | C | MUST | multiple AS | per-AS state | required | fixture |
| AUTH-ASM-1 | same#Authorization Server Metadata Discovery | C | MUST | AS metadata | try endpoints in priority order | required | fixture `auth/as-metadata-order-path-issuer` |
| AUTH-ASM-2 | same | C | MUST | issuer validate | exact match | required | fixture `auth/as-issuer-mismatch` |
| AUTH-COMM-1 | S/basic/authorization/security-considerations.md#Communication Security | C | MUST | AS endpoints/redirects | https or localhost | required | fixture |
| AUTH-REG-1 | S/basic/authorization/client-registration.md#Pre-registration | C | SHOULD | static credentials | supported | required | fixture `auth/pre-registered-flow` |
| AUTH-REG-2 | same#Client ID Metadata Documents | C | SHOULD | AS advertises CIMD | client_id URL | required | fixture `auth/cimd-flow` |
| AUTH-REG-3 | same#Implementation Requirements | C | MUST | CIMD shape | https+path, doc match | required | unit + fixture |
| AUTH-REG-4 | same (priority 4) | C | derived | none available | prompt or fail | required | fixture |
| AUTH-DCR-1 | S/deprecated.md; client-registration.md#Dynamic Client Registration | C | MAY (deprecated) | host enables `dynamicRegistration` | never POSTed by default; opt-in POSTs once per issuer after pre-registration and CIMD and before client-info prompt | conditional | fixture `auth/dcr-never-called`; unit [AUTH-DCR-1] |
| AUTH-BIND-1 | same#Authorization Server Binding; changelog minor 9 | C | MUST | credentials | keyed by issuer; no reuse | required | fixture `auth/as-change-reregisters` |
| AUTH-BIND-2 | same | C | SHOULD | AS changed | surface notice | required | fixture |
| AUTH-FLOW-1 | S/basic/authorization/index.md#Authorization Flow Steps | C | - | auth request | params | required | fixture |
| AUTH-PKCE-1 | S/basic/authorization/security-considerations.md#Authorization Code Protection | C | MUST | verify PKCE support | refuse if absent | required | fixture `auth/pkce-absent-refused` |
| AUTH-PKCE-2 | same | C | MUST | S256 | use | required | unit |
| AUTH-REDIR-1 | same#Open Redirection | C | MUST | redirect URIs | registered, localhost/https | required | fixture |
| AUTH-REDIR-2 | same#Localhost Redirect URI Risks | C | derived | display hostname | consent shows host | required | consent fixture |
| AUTH-REDIR-3 | derived | C | - | server-supplied redirect | ignore | required | fixture |
| AUTH-RES-1 | S/basic/authorization/index.md#Resource Parameter Implementation | C | MUST | authz+token requests | resource canonical URI | required | fixture `auth/resource-param-authz-and-token` |
| AUTH-RES-2 | same#Canonical Server URI | C | SHOULD | canonicalization | vectors | required | unit vectors |
| AUTH-ISS-1..4 | same#Authorization Response Validation; changelog minor 7 | C | MUST | callback | record issuer, table compare, no normalization, no act on errors on mismatch | required | fixture `auth/iss-table` |
| AUTH-STATE-1 | S/basic/authorization/security-considerations.md#Open Redirection | C | SHOULD | state | random, verified, single-use | required | fixture `auth/state-mismatch` |
| AUTH-TOKEN-1 | same index.md | C | - | token request | verifier, resource | required | fixture |
| AUTH-SCOPE-1 | same#Scope Selection Strategy | C | SHOULD | scope choice | challenge > scopes_supported > omit | required | fixture |
| AUTH-SCOPE-2 | same#Refresh Tokens | C | MAY | offline_access | opt-in | active-optional | fixture |
| AUTH-USE-1 | same#Token Requirements | C | MUST | every HTTP request | Authorization: Bearer | required | fixture |
| AUTH-USE-2 | same | C | MUST NOT | query string | never | required | fixture `auth/token-not-in-query` |
| AUTH-USE-3 | same#Token Handling | C | MUST NOT | other tokens/servers | bound to resource | required | fixture `auth/token-not-forwarded-cross-origin` |
| AUTH-REFRESH-1..3 | same#Refresh Tokens | C | MUST/SHOULD/MUST NOT | refresh | confidential, no assumption, fallback | required | fixture |
| AUTH-CONC-1 | derived | C | - | concurrent 401 | single flight | required | fixture `auth/refresh-single-flight` |
| AUTH-401-1..2 | same#Error Handling | C | - | 401 | challenge then retry once, new id | required | fixture `auth/401-retry-new-id` |
| AUTH-STEP-1..4 | same#Step-Up Authorization Flow | C | SHOULD/MAY | insufficient_scope | union scopes, limit | required | fixtures `auth/step-up-*` |
| AUTH-CONT-1 | PLAN.md (auth continuity) | C | derived | expiry mid-session | next request reauthorizes | required | gate scenario |
| AUTH-LOG-1 | derived (N secrets policy) | C | - | logging | no secrets in output | required | fixture `auth/secrets-not-logged` |
| AUTH-BEARER-1..4 | PLAN.md (configured bearer) | C | derived | configured token | per-origin, no discovery | required | fixture `auth/configured-bearer` |
| AUTH-SSRF-1..6 | W/docs/2026-07-28/tutorials/security/security_best_practices.md#SSRF | C | MUST consider / SHOULD | discovery fetches | guard | required | fixtures `auth/ssrf-*` |
| AUTH-AUD-1 | S/basic/authorization/security-considerations.md#Token Audience Binding | C | MUST | resource param, binding | - | required | covered by AUTH-RES-1/USE-3 |
| AUTH-MIX-1 | same#Mix-Up Attacks | C | derived | mix-up | endpoints from chosen AS only | required | fixture |
| AUTH-SEP-1 | S/client/elicitation.md#URL Mode Elicitation for OAuth Flows | C | derived | URL elicitation | not authorization | required | covered by ELIC-AUTH-1 |
| AUTH-SRV-* | S/basic/authorization/index.md; security-considerations.md | S | MUST | token validation, audience, PRM publication, scope hierarchies | - | out-of-scope (server role) | none |
| CONSENT-1..3 | S/client/elicitation.md; S/basic/authorization/index.md; PLAN.md | C | MUST/derived | host consent | ports, no auto-approve | required | fixtures `consent/*` |
| TEL-SEP-1 | PLAN.md N9 | C | derived | three channels | no cross-feed | required | unit with spy sinks |
| TEL-CTX-1 | S/basic/index.md#_meta (OpenTelemetry); W/seps/414-request-meta.md | C | MUST (format) | host supplies context | write traceparent/tracestate/baggage unprefixed | required | fixture `tel/traceparent-in-meta` |
| TEL-CTX-2 | same | C | MUST | formats | W3C validation | required | unit |
| TEL-CTX-3 | derived | C | - | no host context | send nothing | required | fixture |
| TEL-PRIV-1 | derived | C | - | span attributes | no content by default | required | fixture scanning spans |
| TEL-ADAPT-1 | derived | C | - | OTel adapter | optional package | active-optional | Wave 2 test |
| ERR-LOCAL-1 | S/basic/index.md#Error Codes (local errors) | C | SHOULD | local timeout etc | not JSON-RPC-shaped | required | unit |
| API-OUT-1 | derived | C | - | outcomes | typed union + unwrap | required | type tests |
| LIM-CONC-1 | derived | C | - | in-flight limit | queue | required | unit |
| LIM-SUB-1/2 | derived | C | - | listen limits | caps | required | unit |
| LIM-PROG-1 | S/basic/patterns/progress.md#Implementation Notes | C | SHOULD | rate limiting | coalesce | required | fake-clock unit |
| LIM-DIAG-1 | derived | C | - | diag ring | bounded | required | unit |
| EDGE-* | see 11.4 | C | various | catalogue | see table | required | one fixture each under `fixtures/edge/` |
| EXT-REG-1 | S/basic/versioning.md#Extension Negotiation; W/extensions/overview.md#SDK Implementation | C | derived (disabled by default at every stage) | registration | explicit only | required | unit: import registers nothing; fixture capabilities empty without `use()` |
| EXT-CAP-1 | S/basic/versioning.md; PLAN.md | C | MUST (no vacuous flags) | advertise | only when working | required | fixture per extension: capability absent when port/health missing |
| EXT-CAP-2 | W/seps/3415 (fallback) ; S/basic/versioning.md | C | MUST NOT (events) | server lacks ext | no ext calls | required | fixture |
| EXT-REV-1 | W/seps/3392-extension-lifecycle.md#Evolution | C | SHOULD NOT | unknown `revision` | do not enable | required | fixture |
| EXT-RES-1 | S/basic/index.md#ResultType | C | MUST | ext resultType | only with registered ext | required | fixture EDGE-10/39 |
| EXT-STREAM-1 | PLAN.md modules 3 | C | derived | stream primitives shared | - | required | architecture test: ext packages import only `core` public API |
| EXT-REMOVE-1 | PLAN.md modules 3 | C | derived | removal | core outcomes unchanged | required | CI job `remove:<ext>` |
| EXT-PIN-1 | PLAN.md Scope | C | derived | revisions | pinned | required | doc check in CI (PIN.md present with commit) |
| EXT-tasks-1..8 | W/extensions/tasks/overview.md | C | per page (MUST-level language not in wiki; UNRESOLVED) | Tasks | handle, poll, update, cancel, persist | unresolved-pending-pin (Beta); active-optional after pin | fixtures `ext/tasks/*` |
| EXT-skills-1..10 | W/extensions/skills/overview.md#Capabilities, #Integrity and Verification, #Implementation Requirements | C/host | MUST | Skills | gating, verification, no-prefetch, collisions, approval binding | active-optional (Beta) | fixtures `ext/skills/*` |
| EXT-skills-HOST | same#Security Considerations | host | MUST | approvals, allowed-tools, nested consent | SkillApprovalPort contract | conditional (host policy) | port contract test |
| EXT-cc-1..6 | W/extensions/auth/oauth-client-credentials.md | C | per page | client_credentials | JWT assertion / secret, resource, aud=issuer | active-optional (Stable) | fixtures `ext/cc/*` |
| EXT-ema-1..6 | W/extensions/auth/enterprise-managed-authorization.md | C | per page | EMA | token exchange -> ID-JAG -> jwt-bearer, no authz endpoint | active-optional (Stable) seam | fixtures `ext/ema/*` |
| EXT-apps-1..5 | W/extensions/apps/overview.md | C/host | per page | Apps | ui capability w/ renderer, resourceUri, csp passthrough | active-optional (Stable, protocol side only) | fixtures `ext/apps/*` |
| EXT-apps-BRIDGE | W/extensions/apps/overview.md | host | - | ui/* postMessage bridge | host-owned | deferred (spec not pinned) | none |
| EXT-card-1..5 | W/seps/2127-mcp-server-cards.md | C | MUST NOT (primitives trusted)/SHOULD | server cards | discovery, advisory, cache | active-optional (Beta) | fixtures `ext/card/*` |
| EXT-events-1..N | W/seps/3415-events-extension.md (mirror 4165cc2e580a; target PR head 60b15c16) | C | MUST/SHOULD (see 12.7) | Events | poll/push/webhook | draft; off by default; implement only on explicit request | fixtures `ext/events/*` |
| EXT-EVENTS-ERR-1 | same#Error Handling; Open Questions 5 | C | - | error codes in reserved range | not special-cased in core | unresolved | decision D4 |
| EXT-EVENTS-WEBHOOK-ISO | PLAN.md Scope | C | derived | webhook isolation | separate package/listener | required (if Events built) | removal test + no-inbound-listener assertion on local runtime |
| EXT-EXP-INTERCEPT | W/seps/3392-extension-lifecycle.md#Transition; W/community/working-groups/interceptors.md | - | - | interceptors | no pinned spec | excluded (no pin) | inventory entry only |
| EXT-EXP-VARIANTS | W/seps/3392-extension-lifecycle.md#Transition | - | - | variants | no source | unresolved | inventory entry only |
| EXT-EXP-TOOLANN | W/community/interest-groups/tool-annotations.md | - | - | tool-annotations | IG only | excluded (no pin) | inventory entry only |
| FIX-1 | PLAN.md Modules 1,4 | - | derived | fixture coverage | IDs resolve; implemented rows covered | required | `npm run check:coverage` |
| FIX-2 | wf-tdd (red proof) | - | derived | vacuous fixtures | mutants must fail | required | `conformance run --mutate` |
| FIX-3 | PLAN.md Modules 1 | - | derived | separation | no impl import | required | dependency-cruiser rule |
| FIX-4 | PLAN.md Scope | - | derived | synthetic server | not shipped | required | package.json audit (`private`, no `bin`, no exports) |
| FIX-5 | PLAN.md first paragraph/Module 4 | - | derived | official runner | black-box only | required | static grep: no imports from runner package |
| GATE-1 | PLAN.md Modules 4; Scope N5 | - | derived | gate run | fresh process, no Pi packages | required | `scripts/assert-no-pi.mjs` + loader hook |
| GATE-2 | PLAN.md Modules 4 | - | derived | release claim | disposition for every row | required | `check:coverage` (no blank disposition) |
| GATE-3 | PLAN.md Modules 4 | - | derived | release claim | every implemented row passes | required | `reports/coverage-matrix.md` all green |
| GATE-4 | PLAN.md Scope N7/N8 | - | derived | forbidden constructs | absent on the wire | required | `scripts/wire-scan.mjs` over all transcripts |
| GATE-5 | PLAN.md Modules 4 | - | derived | official runner | recorded | required | `official.ts` output |
| GATE-6 | PLAN.md Modules 4 | - | derived | unresolved rows | non-claims listed | required | report lint |
| GATE-7 | PLAN.md Modules 4 | - | derived | claim text | generated | required | report lint |
| PICA-1..12 | PLAN.md Modules 5 | host | derived | Coding Agent adapter responsibilities | see 15.2 | required (Wave 3, after gate) | contract tests + scratch-config run |
| PICA-13 | PLAN.md N5 | - | derived | no Pi in packages | re-check | required | `check:deps` |
| PICA-14 | PLAN.md Modules 5 | - | derived | pinned fork target | record revision | required | acceptance report contains revision |
| PICD-1..9 | PLAN.md Modules 5; ~/pi/packages/durable/README.md:336,368-387 | host | derived | Durable adapter | commit-before-wake, replay, interruption, handles, cursors, no exactly-once | required (Wave 3) | durable adapter test suite |
| CUT-PI-MCP-1 | PLAN.md Modules 5 | host | derived | standalone `pi mcp` | separate cutover decision D7 | unresolved (decision) | decision log |
| CUT-ROLLBACK-1 | PLAN.md Modules 5 | host | derived | migration rollback | single-edit rollback proven | required (Wave 3) | rollback drill in scratch dir |
| DEP-CONFIRM-1 | S/deprecated.md; S/changelog.md#Deprecated | - | derived | tag re-check | confirm exact deprecated list at tag | required (Wave 0 task) | RECONCILIATION entry for both pages |
| DEP-LOG-1 | S/server/utilities/logging.md; S/deprecated.md | C | n/a | MCP Logging | not implemented | excluded (deprecated) | covered by WIRE-LOG-1 |
| DEP-DCR-1 | S/deprecated.md | C | n/a | DCR | never called by default; host opt-in is back-compat only | deprecated | fixture `dep/dcr-not-called`; covered by AUTH-DCR-1 |
| DEP-HTTPSSE-1 | S/deprecated.md | C | n/a | HTTP+SSE | not implemented | excluded (deprecated) | covered by HTTP-SSEOLD-1 |
| DEP-INCLUDECTX-1 | S/deprecated.md | C | n/a | includeContext | not implemented (sampling excluded) | excluded (deprecated) | covered by DEP-SAMPLING-1 |

### 3.5 Summary of seeded rows

Seeded row lines (range rows such as `X-1..4` count once and expand in Wave 0): **315**.

| Disposition (as written) | Row lines |
|---|---|
| required | 260 |
| active-optional | 20 |
| excluded | 19 |
| conditional | 6 |
| unresolved | 5 |
| out-of-scope | 2 |
| unresolved-pending-pin | 1 |
| deferred | 1 |
| draft | 1 |

Disposition qualifiers in parentheses (e.g. `required (Wave 3, after gate)`) are preserved in the rows; Wave 0 lanes normalise them into the vocabulary of 3.2 and move qualifiers to the condition column.

## 4. Architecture

Anchors: `S/architecture/index.md` (host owns policy and consent; one client per server; "servers should not see the whole conversation nor other servers"), `S/basic/index.md` (messages, statelessness). Design vocabulary follows `wf-module-design`: few deep modules with narrow interfaces; seams are placed where the PLAN.md modules split (transport, auth, extension, host).

### 4.1 Concepts
- **Host** (the application, e.g. Pi) creates **one `McpClient` per server** (`S/architecture/index.md#Clients`: 1:1). A `McpClient` is *stateless w.r.t. protocol*: it holds configuration, a transport handle, caches, auth state, and active request/stream tables, but **no negotiated session**.
- **Transport lifetime** (spawned process / HTTP agent pool) is owned by a `Transport`; **request lifetime** (id, abort signal, progress, pending outcome, MRTR rounds) is owned by a `RequestContext`. A request outliving its transport's replacement is impossible by construction: when a transport dies, all of its `RequestContext`s settle (6.3, 7.6); a *new* transport never inherits them.
- **Streams**: every wire exchange is a request that yields (a) zero or more request-scoped notifications and (b) exactly one terminal response; `subscriptions/listen` and extension streams (`events/stream`) are long-lived requests of the same shape. One primitive serves core, Tasks, Events.

### 4.2 Repository layout (workspace; npm workspaces, `private: true`, ESM, TS project references)

```
packages/
  core/                  # protocol, no I/O, no Node-only APIs, no Pi, no extensions
    src/jsonrpc.ts       #   envelope types, codec, id generator, strict validators (WIRE-*)
    src/lifecycle.ts     #   McpClient, per-request _meta, version selection, discover (VER-*)
    src/request.ts       #   ClientRequest/stream implementation, request table, timeouts (WIRE-TO-*)
    src/outcome.ts       #   Outcome union + helpers + error classes (11.2)
    src/cancel.ts        #   AbortSignal plumbing, cancel semantics per binding
    src/progress.ts      #   progress token registry (PROG-*)
    src/extension.ts     #   Extension / ExtensionHost contracts (12.0)
    src/auth-types.ts    #   AuthProvider interface only
    src/ports.ts         #   Consent/Browser/Redirect/CredentialStore/Identity/Telemetry/Clock/Random/Fetch port types
    src/telemetry.ts     #   TelemetryPort + no-op
    src/schema/          #   generated types from the pinned schema.json (no hand edits)
  transport-stdio/       # Node: spawn, framing, shutdown (section 6)
  transport-http/        # fetch + SSE parser, headers, redirects (section 7)
  ops/                   # tools/prompts/resources/completion/pagination/schema validation (section 8)
  auth/                  # discovery, registration, code flow, refresh, step-up, bearer, safe-fetch (section 10)
    src/node-loopback.ts #   optional Node RedirectPort reference adapter
  mrtr-cache/            # MRTR, elicitation ports, subscriptions, cache (section 9)
  telemetry-otel/        # optional TelemetryPort over @opentelemetry/api (Wave 2)
  ext-tasks/  ext-skills/  ext-client-credentials/  ext-enterprise-auth/  ext-apps/  ext-server-cards/
  ext-events/  ext-events-webhook/        # section 12 (events: off by default)
  fixtures/              # scripted exchanges + synthetic server (data separate from runner) (section 13)
  conformance/           # runner, requirement->fixture map, official-runner black-box wrapper, gate scripts
adapters/                # Wave 3 only, after the spec gate; the only place Pi is imported
  pi-coding-agent/       # section 15.2
  pi-durable/            # section 15.3
docs/
  conformance/           # wire.md operations.md authorization.md extensions.md (Wave 0), PINS.md RECONCILIATION.md
  deps.md  decisions/    # dependency justifications; director decisions log
```

### 4.3 Dependency rules (machine-checked by `dependency-cruiser` in `packages/conformance`)
| From -> To | Allowed? | Why |
|---|---|---|
| any `packages/*` -> Pi packages (`@earendil-works/*`, any name in `deny-pi.json`) | **never** | N5 |
| `packages/*` -> `adapters/*` | never | adapters depend on packages, not reverse |
| `core` -> anything but `core/src/schema` and TS lib | only itself | no Node-only API in core (lint: `no-restricted-globals` for `process`, `Buffer`, `fs`) |
| `transport-*`, `ops`, `auth`, `mrtr-cache`, `telemetry-otel` -> `core` | yes (public entry `@scope/core` only) | |
| `ops`, `mrtr-cache`, `auth` -> `transport-*` | **never** | they see only the `Transport`/`ClientRequest` interface; transports are injected |
| `transport-http` -> `auth` | never (uses `AuthProvider` type from core) | seam |
| `ext-*` -> `core` public API (+ `ops` for resource reads if needed) | yes | EXT-STREAM-1 |
| `core` / `ops` / `transport-*` -> `ext-*` | never | removal test (EXT-REMOVE-1) |
| `ext-events-webhook` -> `ext-events` | yes; reverse never | isolation |
| `ext-*` <-> `ext-*` | never (e.g., tasks does not import skills) | independence |
| `fixtures` -> `core` types only; **no** `fixtures` -> implementation packages | runner in `conformance` imports implementation | fixtures are data + a tiny synthetic server, stored separately |
| `conformance` -> everything in `packages/*` | yes | |
Each package exposes one entry (`src/index.ts`) listed in `package.json#exports`; deep imports are blocked.

### 4.4 Core interface sketches (TypeScript)

```ts
// ---- transport seam: framing and I/O only; no protocol knowledge beyond "deliver messages"
export interface Transport {
  readonly binding: "stdio" | "streamable-http" | (string & {}); // custom bindings allowed by basic/transports/index.md
  /** Begin one JSON-RPC request. Messages for it (notifications, final response) arrive on the returned exchange. */
  start(msg: JsonRpcRequest, ctx: TransportCall): Exchange;
  /** Fire-and-forget notification (stdio cancel, extension notifications). HTTP: POST expecting 202. */
  notify(msg: JsonRpcNotification, ctx: TransportCall): Promise<void>;
  /** Ends the transport; settles every Exchange. Idempotent. */
  close(opts?: { graceMs?: number }): Promise<void>;
  readonly diagnostics: AsyncIterable<TransportDiagnostic>; // stderr lines, noise, violations (never protocol data)
}
export interface TransportCall {
  signal: AbortSignal;                // per-request; transport turns abort into the binding's cancellation (5.4)
  idempotent: boolean;                // read-only classification, input to recovery (6.5/7.7)
  headersHint?: { name?: string; params?: Record<string, string|number|boolean> }; // HTTP Mcp-Name / Mcp-Param source
  timeoutMs: number;
}
export interface Exchange {
  /** Request-scoped notifications (progress, listen events) in arrival order. Completes after `done`. */
  readonly notifications: AsyncIterable<JsonRpcNotification>;
  /** Exactly one terminal: a response, or a transport-level failure with delivery certainty. */
  readonly done: Promise<ExchangeEnd>;
}
export type ExchangeEnd =
  | { kind: "response"; message: JsonRpcResponse | JsonRpcErrorResponse }
  | { kind: "failure"; failure: TransportFailure; delivery: "not-sent" | "maybe-delivered" | "delivered-no-response" };

// ---- request/stream seam used by ops, mrtr-cache, extensions
export interface ClientRequest<T = unknown> extends PromiseLike<Outcome<T>> {
  readonly id: RequestId;                         // assigned at send; new id per retry
  readonly progress: AsyncIterable<ProgressEvent>;
  readonly notifications: AsyncIterable<JsonRpcNotification>;
  cancel(reason?: string): void;                  // = AbortController.abort(reason)
  readonly signal: AbortSignal;
}
export interface RequestOptions {
  signal?: AbortSignal; timeoutMs?: number; onProgress?: (p: ProgressEvent) => void;
  idempotent?: boolean; meta?: Record<string, unknown>; mrtr?: "auto" | "manual";
}
export interface StreamHandle extends AsyncIterable<JsonRpcNotification> { // long-lived requests
  readonly id: RequestId; readonly done: Promise<Outcome<unknown>>; close(): void;
}
```

```ts
// ---- normalized outcomes (11.2): distinct kinds, never overlapping
export type Outcome<T> =
  | { kind: "ok"; value: T; meta: OutcomeMeta }                                   // resultType complete
  | { kind: "jsonrpc-error"; code: number; message: string; data?: unknown;
      refined?: "resource-not-found" | "unsupported-version" | "missing-client-capability" | "header-mismatch" | "unknown-reserved"; meta: OutcomeMeta }
  | { kind: "transport-failure"; failure: TransportFailure; safeToRetry: boolean; meta: OutcomeMeta }
  | { kind: "tool-isError"; result: CallToolResult; meta: OutcomeMeta }          // application error (tools/call only)
  | { kind: "mrtr-interim"; inputRequests?: InputRequests; requestState?: string;
      resume(responses?: InputResponses): ClientRequest<T>; meta: OutcomeMeta }  // manual mode
  | { kind: "task-handle"; handle: unknown /* typed by ext-tasks */; meta: OutcomeMeta }
  | { kind: "uncertain-write"; uncertain: UncertainWrite; meta: OutcomeMeta }
  | { kind: "cancelled"; wasSent: boolean; phase: "queue" | "wire" | "input"; meta: OutcomeMeta }
  | { kind: "protocol-violation" | "capability-absent" | "invalid-arguments" | "invalid-schema"
          | "unsupported-version" | "auth-failure" | "auth-unavailable" | "limit-exceeded" | "local-error";
      detail: unknown; meta: OutcomeMeta };
export interface OutcomeMeta { requestId: RequestId; method: string; binding: string; attempts: number;
  cache?: "hit"|"miss"|"stale"|"bypass"; serverInfo?: Implementation /* display only */; trace?: MrtrRound[]; }
export interface UncertainWrite { requestId: RequestId; method: string; name?: string; argsDigest: string; sentAt: number;
  binding: string; evidence: "process-exit"|"eof-mid-line"|"cancelled"|"timeout"|"stream-broken"|"status-5xx"|"truncated-json"; }
```

```ts
// ---- client facade
export interface McpClientOptions {
  transport: Transport; server: ServerRef;               // ServerRef = host-assigned label + stable key (not serverInfo)
  clientInfo?: Implementation | false;
  auth?: AuthProvider; ports?: Partial<PortRegistry>;
  extensions?: Extension[];                              // explicit registration only
  defaults?: { timeoutMs?: number; mrtr?: "auto"|"manual"; cache?: CacheOptions; limits?: Partial<Limits>; discoverOnConnect?: boolean };
}
export class McpClient {
  constructor(o: McpClientOptions);
  discover(o?: RequestOptions): ClientRequest<DiscoverResult>;
  readonly tools: ToolsApi; readonly prompts: PromptsApi; readonly resources: ResourcesApi; readonly completion: CompletionApi;
  listen(filter: ListenFilter, o?: RequestOptions): Subscription;
  use(ext: Extension): Disposable;                      // explicit; capability advertised only while working
  close(): Promise<void>;
}
```

### 4.5 Ports (host-neutral; all optional; defined in `core/src/ports.ts`, detailed in 10.1 and 12)
`ConsentPort`, `BrowserPort`, `RedirectPort`, `CredentialStore`, `IdentityPort`, `FetchPort`, `TelemetryPort`, `CacheStore`, `Clock`, `Random`, `Logger` (diagnostics sink, separate from telemetry and from progress). Extension-specific ports (`TaskStore`, `SkillApprovalPort`, `AppRenderPort`, `ListenerPort`, `EventSink`) live in their packages. Absence of a port means the feature is **unavailable** (never auto-approved).

### 4.6 Per-request context vs transport lifetime (invariants; each has a fixture)
1. `RequestContext` owns `{id, AbortController, timeout timer, progressToken, mrtr state, attempt counters, auth retry count}`; destroyed at settlement. (`ARCH-REQ-1`)
2. A `Transport` never stores per-request signals past settlement; its tables are bounded by the in-flight limit. (`ARCH-REQ-2`)
3. Cancelling request A never affects request B or the transport (stdio: only a notification; HTTP: only A's stream). (`ARCH-REQ-3`)
4. Closing the transport settles all requests with the failure+certainty classification; closing a client closes its subscriptions and extensions' attachments in reverse registration order. (`ARCH-LIFE-1`)
5. Caches/subscription state live in `McpClient`, keyed by `ServerRef` + auth context, **not** in transports, so a transport restart does not silently clear or share them (invalidation is explicit, 9.3). (`ARCH-STATE-1`)
6. A single-flight map (cache, auth refresh) is keyed to avoid cross-auth coalescing. (`ARCH-SF-1`)

### 4.7 Dependency pinning policy
- **Policy** (PLAN.md): general-purpose libraries are allowed if justified and pinned; none may embody MCP protocol logic. Each gets a row in `docs/deps.md`: purpose, why not platform/hand-written, exact version (no ranges), integrity (lockfile hash), license, size, last-release date, removal test (module boundary behind an interface so it can be replaced), and security note. Lockfile committed; `npm ci` only; `npm audit` informational in gate.
- **Candidates**:
  - JSON Schema 2020-12 validation: **Ajv** (`ajv/dist/2020`), pinned exact; behind `SchemaValidator` interface (8.6). Alternative considered: `@cfworker/json-schema` (claimed smaller and free of runtime code generation; UNRESOLVED: verify both claims at Wave 1 before relying on them, relevant only if a host forbids dynamic code generation). Decision needed (D8): if a host forbids dynamic code generation, use the alternative; both must pass the same fixtures. Justification vs hand-writing: 2020-12 vocabulary (`$dynamicRef`, `unevaluated*`) is large and validator bugs are security-relevant.
  - Types from `schema.json`: `json-schema-to-typescript` (dev dependency only; generated files committed; regeneration reproducibility check in CI).
  - Crypto: platform `node:crypto` / WebCrypto only (SHA-256, HMAC, PKCE, random). `jose` pinned **only** in `ext-client-credentials` if WebCrypto signing proves insufficient (RS*/ES*/EdDSA coverage).
  - HTTP: platform `fetch`; **no** `undici` unless connection pinning for SSRF (10.7) requires a custom dispatcher (decision D6/Wave 1: Node `fetch` cannot pin IP; use `undici.Agent` with `connect` hook or `node:https` with `lookup`).
  - SSE: hand-written parser (tiny, spec-derived; fixture vectors), **no** library (EventSource libs hide `id`/`retry` handling that we must discard).
  - YAML 1.2 (Skills frontmatter): pinned `yaml` in `ext-skills` only.
  - IP classification: `node:net` `BlockList`; no dependency.
  - Test: `vitest` (dev), `fast-check` (dev, property tests), `dependency-cruiser` (dev).
  - OpenTelemetry: `@opentelemetry/api` only in `telemetry-otel`.
  - Explicitly **not** used: `@modelcontextprotocol/sdk` (any version), `pi-mcp-ext`, `@earendil-works/pi-mcp` (N1/N2). A repo-wide grep/lock check enforces absence in `package-lock.json`.
- **Tooling baseline** (UNRESOLVED version pins until Wave 1 runs `npm view`): TypeScript 5.x strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node >= 22.

### 4.8 Requirement rows for architecture
`ARCH-REQ-1..3`, `ARCH-LIFE-1`, `ARCH-STATE-1`, `ARCH-SF-1` (each verified by named fixtures under `fixtures/arch/`); `ARCH-DEP-1` (dependency-cruiser clean), `ARCH-DEP-2` (no forbidden packages in lockfile), `ARCH-DEP-3` (every dependency has a `docs/deps.md` row).

## 5. Wire and lifecycle

Anchors: `S/basic/index.md`, `S/basic/versioning.md`, `S/basic/patterns/{index,cancellation,progress}.md`, `S/server/discover.md`. Owner module: `packages/core` (transport-neutral).

### 5.1 Envelope rules (client send side)

- **Requests** carry string-or-integer `id`, never `null`, never reused by the same sender (`WIRE-ID-1`). The id generator is per client instance; default is a monotonically increasing integer; the generator is injectable so Durable adapters can use stable ids. After a broken stream the retry **must use a new id** (changelog major change 9; `HTTP-RETRY-1`).
- **Notifications** have no `id`; clients send only `notifications/cancelled` (and extension notifications when registered). Clients never send JSON-RPC responses (`S/basic/patterns/index.md`; `WIRE-DIR-1`).
- **Per-request `_meta`**, injected by `packages/core/src/request.ts` into every request's `params._meta` (`S/basic/index.md#General fields`):
  - `io.modelcontextprotocol/protocolVersion`: required, `"2026-07-28"` (`WIRE-META-1`).
  - `io.modelcontextprotocol/clientCapabilities`: required; computed **per request** from the set of operations the request may need and the registered extensions that are working (`WIRE-META-2`, `EXT-CAP-1`). Empty object `{}` is valid. We advertise `elicitation` (`form`, `url`) only when a `ConsentPort`/`BrowserPort` is wired (no vacuous flags); we never advertise `roots`, `sampling`.
  - `io.modelcontextprotocol/clientInfo`: SHOULD be sent on every request unless config disables it (`WIRE-META-3`).
  - `io.modelcontextprotocol/logLevel`: **never sent** (Logging deprecated, N8). Because servers MUST NOT emit `notifications/message` without it, any `notifications/message` that arrives is a protocol anomaly: dropped, counted, optionally surfaced as diagnostic (`WIRE-LOG-1`).
  - `progressToken`: set only when the caller supplies an `onProgress` callback; unique across active requests (`PROG-1`).
  - `traceparent`/`tracestate`/`baggage`: injected from the host's active OTel context if a `TelemetryPort` returns one (section 11).
  - Caller-supplied `_meta` keys are merged but may not override the three required `io.modelcontextprotocol/*` keys (`WIRE-META-4`; throw `ProgrammerError`).
- **Meta key syntax** for any key a library user supplies: optional prefix `label(.label)*/` with labels beginning with a letter and ending in letter/digit, name begins/ends alphanumeric (`S/basic/index.md#_meta`; `WIRE-META-5`). Validate on registration, not on send.

### 5.2 Envelope rules (receive side)

| Input | Handling | Outcome |
|---|---|---|
| Result with `resultType: "complete"` or **absent** | treat as complete (`WIRE-RT-2`) | `ok` |
| `resultType: "input_required"` | hand to MRTR layer (section 9) | `mrtr-interim` |
| `resultType` value from a registered extension (e.g. Tasks) | pass to that extension's `ResultTypeHandler` | `task-handle` or extension-specific |
| `resultType` unknown and not registered | **invalid** (`WIRE-RT-3`) | `protocol-violation` (jsonrpc-level), request fails; do not guess |
| Error response with integer `code`, `message` | map by code table in 11.1 | `jsonrpc-error` |
| Error response whose `id` is absent | cannot be correlated; log as diagnostic; fail nothing but trip the malformed counter (`WIRE-ERR-2`) | n/a |
| Response with unknown `id` | ignore + diagnostic (late response after cancel, `S/basic/patterns/cancellation.md`) | n/a |
| Server-initiated JSON-RPC **request** | protocol violation: servers MUST NOT initiate requests (`WIRE-DIR-2`). Do not reply (clients send no responses); emit diagnostic; for stdio count toward a violation budget (11.3) | n/a |
| `notifications/cancelled` from server | accepted **only** when `requestId` references one of our active `subscriptions/listen` requests (`WIRE-CANCEL-4`); anything else ignored + diagnostic | stream end for that listener |
| Results/errors for a request we cancelled | ignored (`WIRE-CANCEL-3`) | n/a |

Server error code policy (`S/basic/index.md#Error Codes`): codes `-32020..-32099` are MCP-defined only (`HeaderMismatch -32020`, `MissingRequiredClientCapability -32021`, `UnsupportedProtocolVersion -32022`); a code in that sub-range that is not defined is treated as `jsonrpc-error` of kind `unknown-reserved` (`WIRE-ERR-3`). `-32002` is accepted from older servers as resource-not-found (`OPS-RES-ERR-1`); `-32042` is never emitted by us and never specially handled.

### 5.3 Version selection and `server/discover`

- Default behavior, **inline-first**: the first request goes out with the preferred version `2026-07-28` (`VER-1`). `UnsupportedProtocolVersionError` (-32022) with `data.supported[]` and `data.requested`: if `supported` includes a version we implement (today: only `2026-07-28`), retry once with it; otherwise fail with `unsupported-version` diagnostic (`VER-2`, `VER-3`). At most **one** retry per request (loop guard, `VER-4`).
- `server/discover` (`S/server/discover.md`): `MAY` call before other requests (`VER-5`, active-optional, default **on for stdio, off for HTTP**; see 5.5). Response is `DiscoverResult {supportedVersions, capabilities, instructions?, _meta.serverInfo?, ttlMs, cacheScope}`; cached per 9.5 (`CACHE-DISC-1`). `serverInfo` is display/log only: **never** used for behavior or security (`VER-6`).
- **Capabilities known from discover** gate optional calls: we do not call `prompts/list` if discover says the server has no `prompts` capability (`OPS-GATE-1`). If no discover was done we call inline and treat -32601 (method not found) as `capability-absent` outcome, not a transport failure.
- `MissingRequiredClientCapabilityError` (-32021; HTTP 400): `data.requiredCapabilities` is surfaced to the host as a typed outcome `jsonrpc-error/missing-client-capability`; the library may retry **once** only if the host's registration can supply the missing capability and the registration is working; otherwise report (`VER-7`).

### 5.4 Cancellation (AbortSignal-driven; `S/basic/patterns/cancellation.md`)

| Binding | Client action on `abort()` | Local state after |
|---|---|---|
| stdio | send `notifications/cancelled {requestId, reason?}` (**MUST**) | request settles locally as `cancelled`; late response ignored |
| Streamable HTTP | close the request's SSE response (abort the `fetch`); **no** `notifications/cancelled` is sent (`HTTP-CANCEL-1`) | same |

- Only cancel requests that were issued by us and believed in flight (`WIRE-CANCEL-1`); a cancel after settlement is a no-op, never sent.
- The race "response arrives while cancelling" resolves to **whichever the local state machine observed first**, and the outcome is recorded (`cancelled` vs `ok`), because for writes the caller needs to know the result may have taken effect: a cancelled write whose response was not observed is `uncertain-write`, not `cancelled` (N14). See `WIRE-CANCEL-5`.
- `AbortSignal` is per request; transports never hold per-request signals beyond the request-scoped map entry (4.6).
- Timeouts: every request has a timeout (default 60 s, configurable per request, `WIRE-TO-1`). Progress notifications **may** reset the idle clock (default **off**; opt-in), but a hard maximum is always enforced (`WIRE-TO-2`). Timeout = abort with reason `timeout`, with the same binding behavior as cancel. A timed-out write is `uncertain-write`.
- Server teardown of `subscriptions/listen` arrives as `notifications/cancelled` referencing the listen request id; handled by the subscription manager (section 9).

### 5.5 Unsupported-version / legacy diagnostics

No `initialize` fallback. Detection:

- **stdio**: before the first non-discover request, send `server/discover` (RECOMMENDED by `S/basic/transports/stdio.md#Backward Compatibility` even for modern-only clients; `STDIO-DISC-1`). Outcomes: `DiscoverResult` -> modern, intersect `supportedVersions`; recognized modern error (`-32022`) -> modern, intersect; **any other error or timeout (default 10 s)** -> classify `legacy-or-unresponsive` and fail with an `unsupported-version` diagnostic that: names the launch command, says the peer did not answer `server/discover` as a 2026-07-28 server, states the client implements only 2026-07-28, shows the first 2 KiB of the offending error/stderr, and suggests upgrading the server. It **never** sends `initialize` (`VER-NOFALLBACK-1`).
- **HTTP**: on the first request, a 4xx without a recognized modern error body (see `S/basic/transports/streamable-http.md#Backward Compatibility`, 7.7) -> same diagnostic. A 404/405 on POST is also reported as `legacy-or-wrong-endpoint`.
- Diagnostic shape: `UnsupportedVersionDiagnostic { binding, endpointOrCommand, requested: "2026-07-28", supported?: string[], observed: "modern-error" | "other-error" | "timeout" | "http-status", evidence: string, advice: string }` (`VER-DIAG-1`). Cached per server config for the life of the client (the era is a property of the server, `S/basic/versioning.md`); the cache is in memory only, never persisted (`VER-CACHE-1`).

### 5.6 Progress

`PROG-*`: token string-or-integer, unique among active requests; progress values must **increase** per token (a non-increasing notification is dropped + counted, `PROG-2`); `total`/`message` optional; notifications for tokens not active are dropped (`PROG-3`); after settlement no more are delivered (`PROG-4`). Progress is delivered to `ClientRequest.progress` stream (4.3) and is **not** logging or telemetry.

### 5.7 Statelessness consequences (`S/basic/index.md#Statelessness`)

- No client behavior may depend on connection identity. A stdio process restart or a new HTTP connection must not change request semantics (`WIRE-STATE-1`).
- State that must persist across calls travels as explicit handles: Tasks `taskId`, MRTR `requestState` (opaque, echoed verbatim), server-minted tool arguments. The client never treats a "thread" or "conversation" as a state key (`WIRE-STATE-2`).

### 5.8 Wave 0 questions for this section
- Q: does `ttlMs`/`cacheScope` appear on every result or only listed ones? Schema decides: check `DiscoverResult` in the tag's `schema.json` (UNRESOLVED).
- Q: `-32601` handling for unknown methods inside a modern session, and whether `-32602` carries `data` shape we can parse (UNRESOLVED; schema search).

## 6. stdio transport

Anchors: `S/basic/transports/index.md`, `S/basic/transports/stdio.md`. Package: `packages/transport-stdio` (Node-only: `node:child_process`).

### 6.1 Framing and process I/O

| Concern | Decision | Row |
|---|---|---|
| Encoding | UTF-8; one JSON-RPC message per line, `\n` delimiter; outbound `JSON.stringify` output never contains raw newline (JSON escapes them) - assert anyway | `STDIO-FRAME-1` |
| Inbound split | incremental line splitter on bytes (handles multi-byte chars split across chunks via `TextDecoder` stream mode); tolerate `\r\n` by trimming a trailing `\r` | `STDIO-FRAME-2` |
| Non-JSON stdout line | **violation** ("server MUST NOT write anything to stdout that is not a valid MCP message"): skip the line, keep the connection, record `stdout-noise` diagnostic with first 256 bytes, count toward a budget (default 100 lines / 1 MiB) after which the transport fails with `transport-failure/protocol-noise` | `STDIO-STDOUT-1` |
| Oversized line | max line bytes (default 16 MiB, configurable); exceeding it fails the transport (not just the request) because framing is lost | `STDIO-LIMIT-1` |
| JSON array/batch line | JSON-RPC batch is not used by this revision (UNRESOLVED: confirm no batching language in `S/basic/index.md`; grep found none) -> treated as protocol violation | `STDIO-BATCH-1` |
| Outbound writes | serialized through a single write queue with backpressure (`drain`); a request is "sent" only after its write completes (matters for ambiguity, 6.5) | `STDIO-WRITE-1` |
| stdin never receives non-MCP bytes | client MUST NOT write anything else; test with a recording server | `STDIO-STDIN-1` |
| stderr | captured as a separate `Diagnostics` stream (bounded ring buffer, default 64 KiB + per-line 4 KiB cap), never parsed as protocol, never interpreted as failure (`SHOULD NOT assume stderr indicates error`); optionally forwarded to a host callback | `STDIO-STDERR-1` |
| Environment | explicit `env` allow-list merge; default inherits a minimal set (UNRESOLVED: host policy; core takes `env` verbatim and does not read `process.env` implicitly except `PATH` resolution by `spawn`) | `STDIO-ENV-1` |
| Launch | `spawn(command, args, {stdio:["pipe","pipe","pipe"], shell:false, cwd, windowsHide:true})`; `shell:false` always (no command-string injection) | `STDIO-LAUNCH-1` |

### 6.2 Request routing (no per-request streams)

One shared channel. Responses correlate by `id` through the request table in `packages/core` (`Map<RequestId, Pending>`). Notifications route by:
1. `notifications/progress` -> by `progressToken` -> pending request (`STDIO-ROUTE-1`).
2. Messages with `_meta["io.modelcontextprotocol/subscriptionId"]` -> subscription manager by id (`STDIO-ROUTE-2`; MUST per `stdio.md#Receiving Messages`).
3. Everything else -> `unroutable` diagnostic (not an error).

Simultaneous requests are first-class: N concurrent in-flight requests share one stdin writer; responses may arrive in any order (`STDIO-CONC-1`; spec-gate scenario 14.3.1).

### 6.3 Lifecycle

States: `idle -> spawning -> ready(probed|unprobed) -> closing -> closed | failed`.
- `spawning`: spawn errors (`ENOENT`, `EACCES`) -> `transport-failure/spawn` with the command and the errno. Probe (`server/discover`, 5.5) runs on first use, not at spawn, so that the library can lazily connect (`STDIO-LAZY-1`).
- No `initialize`, no `initialized`.
- **Shutdown** (`STDIO-SHUT-1`): close the child's stdin; wait `graceMs` (default 2000) for exit; then `SIGTERM`; wait `termMs` (default 2000); then `SIGKILL`. On Windows: `taskkill /T /F` equivalent via `child.kill()` after grace (UNRESOLVED: Job Objects need native code; ship `kill()` only and document). Never `SIGKILL` first.
- On shutdown, all pending requests settle with `transport-failure/closed`; writes become `uncertain-write` if already written (6.5).
- **Unexpected termination** (`STDIO-CRASH-1`): detected by `exit`/`close` events or stdout EOF. All in-flight requests settle (writes -> `uncertain-write`, reads -> `transport-failure/process-exit` with `safeToRetry: true`). All `subscriptions/listen` streams end with `ended: "transport"`. Restart is **lazy and caller-driven by default**; `restart: { policy: "on-demand" | "auto", maxRestarts, backoffMs }` is opt-in for `auto`. After a restart the era cache is cleared and the probe re-runs.
- Restart loop guard: `maxRestarts` default 3 per 60 s window, then `failed` (`STDIO-CRASH-2`).

### 6.4 Cancellation on stdio

`notifications/cancelled {requestId, reason}` written through the same queue with **priority** (jumps ahead of queued non-started writes; a request still waiting in the queue is simply removed and never written, in which case it settles as `cancelled` with `wasSent: false`, and the write is certainly not performed) (`STDIO-CANCEL-1`). Server must not send further messages for it; we ignore any that arrive.

### 6.5 Interrupted-write / ambiguous outcome recovery (stdio binding)

The binding gives **no** redelivery, no session, no idempotency key. "Because the protocol is stateless, in-flight requests are simply lost and the client can retry" (`stdio.md#Unexpected Termination`) is accurate for reads but unsafe for side-effecting calls.

| Request state at failure | Classification | Library behavior |
|---|---|---|
| never written (still queued) | `not-sent` | `transport-failure` with `safeToRetry: true`; may auto-retry after restart if policy allows |
| written, process died before any response byte | `uncertain` | for `tools/call` and any method not on the **read-only list** -> `uncertain-write` outcome; **no automatic retry**; caller decides |
| written, partial response line then EOF | `uncertain` | same as above; the truncated line is kept as evidence in the diagnostic |
| response observed | final | n/a |
| cancelled and no response | `uncertain` | `uncertain-write` for non-read-only methods |

Read-only (auto-retry-eligible) methods: `server/discover`, `tools/list`, `prompts/list`, `prompts/get`*, `resources/list`, `resources/templates/list`, `resources/read`, `completion/complete`, `subscriptions/listen` (re-established, not retried). *`prompts/get` is read-only by spec convention; UNRESOLVED: confirm no spec statement of idempotency; default stays in the list but is host-overridable. `tools/call` is **never** classed read-only by the library, even when a tool annotation says `readOnlyHint` (annotations are untrusted hints; `S/server/tools.md`). Host can pass `idempotent: true` per call to override (`STDIO-RECOVER-1`).

`UncertainWrite` carries `{ requestId, method, params digest (sha256 of canonical JSON), sentAt, binding: "stdio", evidence: "process-exit"|"eof-mid-line"|"cancelled"|"timeout" }` so a Durable adapter can persist it (15.3).

### 6.6 What is NOT implemented on stdio
- No `initialize`/`initialized`, no `ping`, no `logging/setLevel`, no `roots/list_changed`, no server-to-client requests, no `Content-Length` (LSP) framing, no sockets/TCP transport in v1 (permitted by `index.md#Custom Transports` but not in scope; the framing module is reusable for it later).
- No stdio auth (`basic/index.md#Auth`: stdio SHOULD NOT follow the authorization spec): credentials come from `env` only, supplied by the host.

### 6.7 Acceptance (fixtures; section 13 mapping)
`stdio/frame-split-multibyte`, `stdio/noise-line`, `stdio/oversize-line`, `stdio/concurrent-out-of-order`, `stdio/cancel-queued`, `stdio/cancel-inflight`, `stdio/stderr-not-error`, `stdio/shutdown-escalation` (server ignores stdin close -> SIGTERM -> SIGKILL asserted by synthetic server logging signals), `stdio/crash-read-retry`, `stdio/crash-write-uncertain`, `stdio/crash-listen-reestablish`, `stdio/legacy-peer-diagnostic`, `stdio/restart-loop-guard`.

## 7. Streamable HTTP transport

Anchors: `S/basic/transports/streamable-http.md` (SH), `W/seps/2243-http-standardization.md` (SEP-2243, header rationale, test table around its "Header name case variation" rows), `S/server/tools.md#x-mcp-header`. Package: `packages/transport-http` (platform `fetch` + `ReadableStream`; no Node-only API; `undici` not required).

### 7.1 Request construction

Every client message is a **new** `POST` to the single endpoint (`SH#Sending Messages`). No GET, no DELETE, no `Mcp-Session-Id`, no `Last-Event-ID` (`HTTP-NOGET-1`, `HTTP-NOSESS-1`, `HTTP-NORESUME-1`).

| Header | Value | Row | Notes |
|---|---|---|---|
| `Content-Type` | `application/json` | `HTTP-REQ-1` | body = exactly one JSON-RPC request or notification (`HTTP-REQ-2`) |
| `Accept` | `application/json, text/event-stream` | `HTTP-REQ-3` | MUST list both |
| `MCP-Protocol-Version` | `2026-07-28` | `HTTP-HDR-1` | MUST equal body `_meta` `protocolVersion` (assert at build time) |
| `Mcp-Method` | body `method` | `HTTP-HDR-2` | all requests |
| `Mcp-Name` | `params.name` (`tools/call`, `prompts/get`) or `params.uri` (`resources/read`) | `HTTP-HDR-3` | base64 sentinel when not safely ASCII (7.2) |
| `Mcp-Param-{Name}` | from `x-mcp-header` | `HTTP-PARAM-*` | 7.3 |
| `Authorization: Bearer ...` | from the auth layer | `AUTH-*` | never logged; stripped on cross-origin redirect |

Header names compared case-insensitively on receive (`HTTP-CASE-1`). Notifications (none defined for core on HTTP): header requirements are **undefined** by the revision (`SH#Sending Messages` note); extension notifications, if any, send the same `MCP-Protocol-Version` + `Mcp-Method` and are flagged UNRESOLVED for review per extension. On `notifications` expect `202 Accepted` with no body; any other 2xx is tolerated and logged; 4xx/5xx yields `transport-failure/notification-rejected` (`HTTP-NOTIF-1`).

### 7.2 Value encoding (`SH#Value Encoding`)
- Types: string as-is; integer decimal; boolean `"true"|"false"`.
- If the value is not entirely visible ASCII (0x21-0x7E), SP, HTAB, or has leading/trailing whitespace, or contains control chars, or is **plain ASCII that matches `^=\?base64\?.*\?=$`**, send `=?base64?{base64(UTF-8)}?=` (prefix/suffix lowercase) (`HTTP-ENC-1`). Table vectors from the spec (`"Hello, 世界"`, `" padded "`, `"line1\nline2"`, `"=?base64?literal?="`) are the fixed test vectors (`HTTP-ENC-2`).
- Same rule for `Mcp-Name` (`HTTP-ENC-3`). Header-injection guard: reject any header value containing CR/LF after encoding (unreachable by construction; assert).

### 7.3 Custom headers from tool parameters (`x-mcp-header`; client MUST support)
1. On `tools/list` (HTTP only), validate every tool's `inputSchema` annotations: non-empty; `1*tchar`; no control chars; case-insensitively unique across the schema; applies only to `string`/`integer`/`boolean` (not `number`); integers within +/-(2^53-1); property statically reachable through `properties` chain only (not via `items`, `oneOf/anyOf/allOf/not`, `if/then/else`, `$ref`) (`HTTP-PARAM-1`).
2. A tool violating any constraint is **excluded** from the `tools/list` result and a warning is logged naming the tool and the violated rule (`HTTP-PARAM-2`). On stdio the annotation MAY be ignored (`HTTP-PARAM-3`).
3. On `tools/call`: for each annotated property extract the value at its exact property path; **omit** the header when absent or `null`; otherwise encode (7.2) and add `Mcp-Param-{Name}` (`HTTP-PARAM-4`). Uses the **most recently obtained** `inputSchema`; if never listed, send no `Mcp-Param-*` (`HTTP-PARAM-5`).
4. On `400` + `HeaderMismatch` (-32020) for a `tools/call`: `tools/list` refresh, rebuild headers, **retry once** as a new request (new id), because the first reached the server's validation stage and was rejected before execution; a HeaderMismatch is definitive "not executed" (`HTTP-PARAM-6`). Retry is capped at one per call.
5. JSON Schema `$ref` handling interacts with (1): reachability analysis runs on the unresolved schema; the `$ref` rule above is textual (UNRESOLVED: confirm that `$defs`-based schemas with an annotation behind `$ref` must be rejected rather than dereferenced: SH says the chain MUST NOT pass through `$ref`; implement as reject).

### 7.4 Response handling

| Response | Handling | Row |
|---|---|---|
| `200` + `application/json` | parse single JSON-RPC response; id must equal request id | `HTTP-RESP-1` |
| `200` + `text/event-stream` | SSE state machine (7.5) | `HTTP-RESP-2` |
| `202` for a request | protocol violation for requests (only notifications get 202) -> `transport-failure/unexpected-202` (uncertain for writes) | `HTTP-RESP-3` |
| `400` + JSON-RPC error `-32022` | version negotiation (5.3) | `HTTP-ERR-1` |
| `400` + `-32021` | missing client capability (5.3) | `HTTP-ERR-2` |
| `400` + `-32020` | header mismatch (7.3 step 4; otherwise a client bug -> `ProgrammerError` surfaced with both values) | `HTTP-ERR-3` |
| `400` empty/other body | `legacy-or-malformed` diagnostic (5.5) | `HTTP-ERR-4` |
| `401` | auth layer (section 10); not a transport failure | `AUTH-HTTP-1` |
| `403` | if `WWW-Authenticate` has `insufficient_scope` -> step-up (section 10); if plain `403` (e.g. Origin rejection) -> `transport-failure/forbidden` | `AUTH-HTTP-2` |
| `404` + JSON-RPC `-32601` | method not found (modern server) | `HTTP-ERR-5` |
| `404`/`405` without modern JSON-RPC body | `legacy-or-wrong-endpoint` diagnostic | `HTTP-ERR-6` |
| `413`/`431` | `transport-failure/too-large` (definitive "not executed") | `HTTP-ERR-7` |
| `429`/`408`/`5xx` | `transport-failure/http-status`; for non-read-only methods `uncertain-write` (the server may have run the call) with `Retry-After` recorded; read-only retry by policy | `HTTP-ERR-8` |
| redirects (3xx) | `redirect: "manual"`; follow only same-origin `307/308` for POST (method+body preserved), max 3 hops; refuse cross-origin and https->http; never forward `Authorization` cross-origin | `HTTP-REDIR-1` |
| non-JSON/other content-type on 2xx | `protocol-violation` | `HTTP-RESP-4` |

### 7.5 SSE parsing (request-scoped streams)
- Parser per the WHATWG SSE grammar, written locally (no library): UTF-8 decode with BOM strip, line terminators `\r\n|\n|\r`, fields `event`, `data`, `id`, `retry`; comment lines (leading `:`) ignored and **never** treated as malformed (`HTTP-SSE-1`, SH keep-alive note). Multi-line `data:` joined with `\n`; dispatch on blank line.
- `event` types other than `message` (or absent) are ignored + diagnostic (`HTTP-SSE-2`). `id:` and `retry:` fields are **parsed and discarded**; never stored, never sent back (no resumption) (`HTTP-SSE-3`).
- Each dispatched data payload must be one JSON-RPC message: notification (route by token/subscription id) or the final response. A JSON-RPC **request** on the stream is a violation (`HTTP-SSE-4`; SH "MUST NOT send independent requests"). Notifications not related to the originating request (e.g., a progress token we did not issue) are dropped + counted (`HTTP-SSE-5`).
- The final response SHOULD terminate the stream; after it, further events are ignored and the body is cancelled (`HTTP-SSE-6`). A second response for the same id is a violation (`HTTP-SSE-7`).
- Request-scoped notifications flow only on the originating request's stream; `notifications/progress` is not expected on a listen stream (`HTTP-SSE-8`).
- Bounds: max event size (default 4 MiB), max total stream bytes per request (default 64 MiB; configurable), idle timeout between bytes for non-listen streams (default = request timeout), for listen streams the idle timeout defaults to **off** but the stream health watchdog fires if there is no bytes (comment or event) for `listenIdleMs` (default 120 s; UNRESOLVED: spec only "encourages" keep-alives, so a no-keepalive server must be configurable) (`HTTP-LIMIT-1`).
- `X-Accel-Buffering: no` is a server hint; the client ignores it. Proxy buffering is a deployment risk noted in 17.

### 7.6 Partial transport failure
| Failure point | Known facts | Outcome |
|---|---|---|
| DNS/TCP/TLS failure before any byte of the request body is written | server cannot have seen the request | `transport-failure/connect`, `safeToRetry: true` |
| Request body fully written, no response headers, connection reset/timeout | server may have received/processed | read-only: auto-retry allowed by policy (new id); otherwise `uncertain-write` |
| Response headers 200 SSE, stream breaks before a final response | **request in flight lost** (changelog major change 9); processing may have continued server-side | `transport-failure/stream-broken` + `uncertain-write` for non-read-only; **no auto-retry for writes**; reads re-issued as a **new request with a new id** (`HTTP-RETRY-1`) |
| SSE gets a final response but the TCP connection errors afterward | response is complete | `ok` (HTTP-SSE-6) |
| JSON body truncated (content-length mismatch / invalid JSON) | ambiguous | same as "stream breaks" |
| Server closes stream cleanly (EOF) without a response | server decided to end | `transport-failure/stream-ended-without-response` + uncertain-write rule |
| Late events after our abort | ignored | n/a |

### 7.7 Interrupted-write / ambiguous outcome recovery (HTTP binding)
Unlike stdio, HTTP **removed** resumption (`Last-Event-ID`), so there is no protocol way to ask "did my write happen?". Recovery semantics, exactly:
1. The library never silently re-issues a non-read-only request after any ambiguous failure (`HTTP-AMBIG-1`).
2. It returns `uncertain-write` with `{requestId, method, name, argsDigest, binding:"http", httpPhase: "no-headers"|"sse-mid-stream"|"status-5xx"|"truncated-json", attempt}` (`HTTP-AMBIG-2`).
3. Caller options: (a) accept uncertainty, (b) call a **domain-specific read** to reconcile (host-supplied; library offers only the hook `reconcile?: (u: UncertainWrite) => Promise<"applied"|"not-applied"|"unknown">`), (c) re-issue with `{acceptDuplicate: true}` (explicit opt-in; the retried request gets a new id and is linked via `retryOf` in telemetry) (`HTTP-AMBIG-3`).
4. If a Tasks handle was already received on the stream before it broke (extension), the task id is the reconciliation key: poll via `tasks/get` (section 12.1); that is the only protocol-level recovery in this revision (`HTTP-AMBIG-4`).
5. If MRTR `requestState` was held before the break, the interim result is final-in-hand: the retry carrying `inputResponses` is a **new request**, and an ambiguous break during **that** retry is again `uncertain-write` (`HTTP-AMBIG-5`).
6. Idempotency keys are **not** invented by the library (no spec basis). Hosts may place their own in arguments.

### 7.8 What is NOT implemented
HTTP+SSE 2024-11-05 endpoint pairing (`GET /sse`, `POST /messages`); `GET` standalone stream; `DELETE` session termination; `Mcp-Session-Id` (ignored in responses, never echoed); `Last-Event-ID`/SSE-id resume; JSON-RPC batching; WebSocket; legacy `initialize` over HTTP; fallback to 2025-03-26 behavior for header-less requests (the "MAY treat missing header as 2025-03-26" rule is server-side and excluded).

### 7.9 Server-side-only HTTP rules recorded as out of scope
`Origin` validation + 403 (server MUST), localhost binding, `X-Accel-Buffering`, intermediary rules, server validation of `Mcp-Param-*` (`HTTP-SRV-*` rows, disposition `out-of-scope (server role)`). The synthetic server (13) implements them only as test behavior.

### 7.10 Acceptance fixtures
`http/post-headers-required`, `http/accept-both`, `http/json-response`, `http/sse-response-progress-then-final`, `http/sse-comment-keepalive`, `http/sse-multiline-data`, `http/sse-id-retry-ignored`, `http/sse-request-on-stream-violation`, `http/abort-closes-stream`, `http/no-get-no-delete-no-session`, `http/session-id-header-ignored`, `http/stream-break-read-reissue-new-id`, `http/stream-break-write-uncertain`, `http/headers-base64-vectors`, `http/x-mcp-header-valid`, `http/x-mcp-header-invalid-tool-excluded`, `http/header-mismatch-refresh-retry-once`, `http/400-modern-error-vs-legacy`, `http/redirect-cross-origin-refused`, `http/5xx-write-uncertain`.

## 8. Operations

Anchors: `S/server/tools.md`, `S/server/prompts.md`, `S/server/resources.md`, `S/server/utilities/{completion,pagination}.md`, `S/basic/index.md#JSON Schema Usage`, `W/seps/2106-json-schema-2020-12.md` (SEP-2106), `W/seps/2164-resource-not-found-error.md` (SEP-2164). Package: `packages/ops` (depends on `core`; transport-neutral).

### 8.1 Common operation machinery
- Each operation is a typed function `client.tools.list(opts)` etc. that builds params, calls `ClientRequest` (4.3), and normalizes the result to `Outcome<T>`. All results are `CacheableResult` where applicable (section 9.5). All list/read operations accept `signal`, `timeoutMs`, `onProgress`.
- **Capability gating** (`OPS-GATE-1`): the server's `capabilities` (from `server/discover` or inferred) decide whether we call `tools/*`, `prompts/*`, `resources/*`, `completion/complete`. Absent capability -> typed `capability-absent` outcome without a wire call when discover data is known; when unknown the call is made and `-32601` maps to `capability-absent`.
- **Pagination helper** (`S/server/utilities/pagination.md`): `listAll()` follows `nextCursor` until it is absent (`PAGE-1`); an **empty-string cursor is valid and not end-of-results** (`PAGE-2`, MUST); cursors are opaque, never parsed, never persisted across server-config changes (`PAGE-3`); never assume page size (`PAGE-4`); loop guard: reject a repeated cursor and cap pages (default 1000) and total items (default 100 000) (`PAGE-5`); invalid cursor -> `-32602` surfaced as `jsonrpc-error`, helper restarts at most once from the first page if caller opted in (`PAGE-6`). Pagination applies to `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list` (`resources/read` is not paginated).

### 8.2 Tools
| Item | Behavior | Row |
|---|---|---|
| `tools/list` | paginated; result carries `ttlMs`, `cacheScope` (9.5); order preserved as received (server SHOULD be deterministic; we never re-sort so prompt-cache-friendly order survives) | `OPS-TOOLS-1`, `OPS-TOOLS-2` |
| Per-request variance | list MAY vary by authorization presented, MUST NOT vary by connection: **the cache key includes the credential identity (section 9.5)** | `OPS-TOOLS-3`, `CACHE-KEY-1` |
| Tool name | SHOULD be 1..128 chars `[A-Za-z0-9_.-]`; client does **not** reject non-conforming names (SHOULD-level on servers) but flags `nameWarnings`; names compared case-sensitively; cross-server disambiguation is a host concern (adapter) | `OPS-TOOLS-4` |
| `inputSchema` | MUST be a JSON Schema object (not null) -> tool with null/non-object schema is invalid and excluded with warning; default dialect 2020-12 | `OPS-TOOLS-5` |
| `x-mcp-header` | HTTP-only validation (7.3) | `HTTP-PARAM-*` |
| Annotations | **untrusted** unless server trusted: library exposes them under `tool.annotations` with `trust: "untrusted"` unless `ServerTrust` port says trusted; never used for retry/idempotency decisions (6.5) | `OPS-TOOLS-6` |
| `tools/call` | params `{name, arguments, _meta}`; result variants below | `OPS-TOOLS-7` |
| Result `isError: true` | normalized to `tool-isError` outcome, **not** a jsonrpc-error and **not** a transport failure; content passed through for model self-correction (SHOULD provide to LM) | `OPS-TOOLS-8` |
| JSON-RPC error | unknown tool / malformed -> `-32602`; surfaced as `jsonrpc-error` | `OPS-TOOLS-9` |
| `structuredContent` | any JSON value (SEP-2106) incl. array/primitive/null; client never assumes object | `OPS-TOOLS-10` |
| `outputSchema` validation | client SHOULD validate `structuredContent`; result carries `validation` sub-record; failure does not discard the result, `strictOutput: true` converts to `protocol-violation` | `OPS-TOOLS-11` |
| Input validation | optional pre-send validation of `arguments` against `inputSchema` (default **on**, `validateInput: false` to disable); failure is a local `invalid-arguments` error, never sent | `OPS-TOOLS-12` |
| Content blocks | `text`, `image` (base64 + mimeType), `audio`, `resource_link`, embedded `resource`; optional `annotations` (audience, priority, lastModified); unknown content `type` is preserved as `{type:"unknown", raw}` and flagged, not dropped silently | `OPS-TOOLS-13` |
| Base64/MIME validation | image/audio data validated as base64 with valid mimeType before handing to host; invalid -> `protocol-violation` for that block, others kept | `OPS-TOOLS-14` |
| Raw vs bounded | the library returns the **raw complete** result; truncation/summary for model context is the host's (15.2, codemode raw structured results vs bounded model output). Library exports `measure(result)` (bytes per block) only | `OPS-TOOLS-15` |
| Timeouts | per-call timeout (5.4); a timed-out write is `uncertain-write` | `OPS-TOOLS-16` |
| `list_changed` | only via `subscriptions/listen` (9.3); a stale list cache is invalidated on notification | `SUB-LIST-1` |
| Security (client SHOULD) | prompt for user confirmation on sensitive operations; show inputs before calling; validate results before passing to LLM; timeouts; audit log | host policy via `ConsentPort`/`AuditPort`; library offers the **hook points** only (`beforeCall(ctx)` can veto, `afterCall(ctx)` observes) (`OPS-TOOLS-17`) |
| `Input Required Tool Results` | `resultType:"input_required"` -> MRTR (section 9) | `MRTR-*` |

### 8.3 Prompts
`prompts/list` (paginated, cacheable, deterministic per credential), `prompts/get {name, arguments}` -> `{messages[], description?}` with content blocks identical to tools plus embedded resources (`OPS-PROMPT-1..3`). Embedded `image`/`audio` base64 + mimeType validated (`OPS-PROMPT-4`, MUST for servers: client validates before use). Errors: invalid prompt name / missing arguments `-32602`, internal `-32603` (`OPS-PROMPT-5`). `prompts/get` may return `input_required` (MRTR; UNRESOLVED: confirm which request types may return `InputRequiredResult`; check `S/basic/patterns/mrtr.md` and schema `InputRequiredResult` applicability list in section 9). `Mcp-Name` header uses `params.name` (`HTTP-HDR-3`). Prompt arguments completion via `completion/complete` (8.5).

### 8.4 Resources
| Item | Behavior | Row |
|---|---|---|
| `resources/list`, `resources/templates/list` | paginated, cacheable; templates are RFC 6570 URI templates - client expands templates itself with a small local RFC 6570 level-1..4 expander (no dependency; UNRESOLVED: justify or pin `uri-template` lib if expansion edge cases explode) | `OPS-RES-1`, `OPS-RES-2` |
| `resources/read {uri}` | result `contents[]` with `uri`, `mimeType?`, `text` xor `blob` (base64); cacheable (9.5); `Mcp-Name` = `params.uri` | `OPS-RES-3` |
| Empty `contents` | for a non-existent resource servers MUST NOT return empty; for **any** empty `contents` client reports `ok` with `empty: true` flag - it does not infer not-found (ambiguous by spec) | `OPS-RES-4` |
| Not found | `-32602` (SEP-2164) with `data.uri` SHOULD; client **also** accepts legacy `-32002` from older servers (SHOULD) -> both map to `resource-not-found` jsonrpc-error kind; client never emits `-32002` handling for other purposes | `OPS-RES-ERR-1` |
| Internal | `-32603` | `OPS-RES-ERR-2` |
| `file://`, `https://`, `git://`, custom schemes | client treats URI as opaque identifier; **never fetches** `https://` resources itself (server-fetch vs client-fetch rule: servers SHOULD use `https://` only when the client can fetch; our library does not fetch; the host decides) | `OPS-RES-5` |
| Custom scheme syntax | validate RFC 3986 on receipt; invalid URI -> flagged, not rejected | `OPS-RES-6` |
| Resource subscriptions | `subscriptions/listen` with `notifications.resourceSubscriptions` (section 9.3); `resources/subscribe`/`unsubscribe` **do not exist** in this revision | `SUB-RES-1` |
| Annotations | `audience`, `priority`, `lastModified` pass-through, validated ranges (priority 0..1) | `OPS-RES-7` |
| Security | binary data base64-validated; resource sizes bounded (11.3) | `OPS-RES-8` |

### 8.5 Completion
`completion/complete {ref: PromptReference | ResourceTemplateReference, argument:{name,value}, context?:{arguments}}` -> `{completion:{values[<=100], total?, hasMore?}}`; server must declare `completions` capability (`OPS-COMP-1`). Client: reject `values.length > 100` as `protocol-violation`-lite (truncate + flag) (`OPS-COMP-2`); debounce is host concern (SHOULD) - library provides no timers but coalescing helper `latestWins(key)` that aborts the previous in-flight completion (`OPS-COMP-3`); errors `-32601` -> capability-absent, `-32602` invalid (`OPS-COMP-4`). Completion is a **read** (auto-retry eligible).

### 8.6 JSON Schema handling (SEP-2106 + `S/basic/index.md`)
| Rule | Implementation | Row |
|---|---|---|
| 2020-12 default for schemas without `$schema`; MUST support | validator instance = Ajv 2020 (`ajv/dist/2020`) in `strict:false` for unknown annotations but with `x-mcp-header`, `x-*` registered as annotation keywords | `OPS-SCHEMA-1` |
| Other dialects | v1 documents support for **2020-12 only**; a schema with a different `$schema` yields `unsupported-dialect` for that tool: the tool stays listed with `validation:"unsupported-dialect"`, calls proceed only if `allowUnvalidated:true` (MUST handle gracefully with an error indicating the dialect) | `OPS-SCHEMA-2` |
| Schema must be valid for its dialect | compile on `tools/list`; compile failure -> tool flagged `invalid-schema` and excluded (warning) | `OPS-SCHEMA-3` |
| No automatic network `$ref` | Ajv `loadSchema` **not** configured; only same-document pointers and `$anchor`/`$dynamicRef` resolved; unresolved external `$ref` -> schema rejected (not permissive) | `OPS-SCHEMA-4` |
| Opt-in external `$ref` | `refResolver` port, default none; if provided it must enforce an allowlist, block loopback/link-local/private (SSRF, reuse 10.7 address guard), timeout, size limit, and logs URIs | `OPS-SCHEMA-5` (active-optional) |
| Composition bounds | pre-compile scan: max depth 64, max subschemas 10 000, max bytes 1 MiB; violation -> `invalid-schema`; per-validation time budget: UNRESOLVED (Ajv is synchronous; options: run validation in a worker thread with a deadline, or cap instance size; decision in Wave 1) | `OPS-SCHEMA-6` |
| `structuredContent` any JSON | no `typeof === "object"` assumption in types (`unknown`) | `OPS-SCHEMA-7` |
| Dependency | Ajv pin, justification and removal test in `docs/deps.md`; the dialect-agnostic wrapper `SchemaValidator` interface lets another validator replace it | N4 |

### 8.7 What is NOT implemented in operations
Roots (`roots/list`, `notifications/roots/list_changed`), Sampling (`sampling/createMessage`, `includeContext`), Logging (`logging/setLevel`, `notifications/message`, `logLevel` meta), `ping`, `resources/subscribe`, `resources/unsubscribe`, `tasks/*` in core (extension only), legacy `notifications/elicitation/complete`, `elicitationId`, error `-32042`.

### 8.8 Acceptance fixtures
`ops/tools-list-paginated-empty-cursor`, `ops/tools-list-cursor-loop`, `ops/tools-call-ok-structured-array`, `ops/tools-call-isError`, `ops/tools-call-jsonrpc-error-unknown-tool`, `ops/tools-output-schema-violation`, `ops/tools-null-inputSchema-excluded`, `ops/schema-ref-network-rejected`, `ops/schema-draft07-unsupported`, `ops/schema-bomb-bounded`, `ops/prompts-get-embedded-resource`, `ops/resources-read-not-found-32602`, `ops/resources-read-not-found-legacy-32002`, `ops/resources-read-empty-contents`, `ops/resources-templates-list`, `ops/completion-values-over-100`, `ops/capability-absent-no-wire-call`, `ops/content-unknown-type-preserved`, `ops/content-invalid-base64`.

### 8.9 Icons (metadata only; the library renders nothing)
`icons[]` on `Implementation`, `Tool`, `Prompt`, resources (`S/basic/index.md#icons`). Library exposes them as data plus `validateIcon(icon, serverOrigin)` and an **optional** `fetchIcon()` helper: URI must be `https:` or `data:` (reject `javascript:`, `file:`, `ftp:`, `ws:`, app schemes) (`SEC-ICON-1`, MUST); same-origin as the server and no redirect to a different origin or scheme (`SEC-ICON-2`); fetched **without** credentials, cookies or `Authorization` (`SEC-ICON-3`); size/dimension/frame caps (default 256 KiB, host may lower) (`SEC-ICON-4`); MIME type advisory, detect by magic bytes, strict allowlist `image/png`, `image/jpeg` (+ `image/jpg`) required, `image/webp` and `image/svg+xml` optional (SVG **off** by default, sanitization is the renderer's job) (`SEC-ICON-5`, MUST support png/jpeg only if the host renders icons). Rendering is host/UI work and out of core scope.

## 9. MRTR, elicitation, subscriptions, caching

Anchors: `S/basic/patterns/mrtr.md` (MRTR), `S/client/elicitation.md`, `S/basic/patterns/subscriptions.md`, `S/server/utilities/caching.md`, `W/seps/2549-TTL-for-list-results.md` (SEP-2549), changelog majors 4, 7, 8 and minors 5, 11. Package: `packages/mrtr-cache` (these four share per-server state: auth context id, notification invalidations, request retries, so they live together; sub-modules `mrtr.ts`, `elicitation.ts`, `subscriptions.ts`, `cache.ts` with disjoint files for parallel authors).

### 9.1 MRTR (state-only multi round-trip requests)
Applicable requests: `tools/call`, `prompts/get`, `resources/read` **only** (`MRTR-SCOPE-1`, table in `S/basic/patterns/mrtr.md#Supported Requests`; servers MUST NOT send it elsewhere). An `input_required` result on any other method (including `server/discover`, list methods, `subscriptions/listen`, `completion/complete`) is `protocol-violation` (`MRTR-SCOPE-2`). This also resolves the open item in 8.3 (`prompts/get` does support it).

Client state machine per logical call (`MrtrSession` in `mrtr.ts`):
1. Send original request (id n). Result `resultType:"input_required"` -> `InputRequiredResult { inputRequests?, requestState? }`. Server MUST include at least one of the two; neither present -> `protocol-violation` (`MRTR-C-1`).
2. If `inputRequests` present: **must** build every requested input before retry (`MRTR-C-2`). Each entry `{key: {method, params}}` dispatched by method: `elicitation/create` -> section 9.2; `sampling/createMessage`, `roots/list` -> `unsupported-input-request` (9.1.2). If `inputRequests` absent the client MAY retry immediately (`MRTR-C-3`), after the `retryDelay` policy (default 0; with a max-rounds guard).
3. If `requestState` present: echo it **byte-for-byte** in the retry; never parse/trim/normalize/log its contents (log only length + sha256 prefix) (`MRTR-C-4`). If absent, the retry must **not** carry one (`MRTR-C-5`).
4. Retry = **new JSON-RPC request** (id m != n) with original params unchanged + `inputResponses` (if any) + `requestState` (if any) (`MRTR-C-6`).
5. `inputRequests`/`requestState` affect only this logical call: never applied to parallel calls (`MRTR-C-7`); sessions are keyed by call object, not by server or tool name.
6. Repeat until `complete` (-> normal outcome) or a JSON-RPC error. Caps: `maxRounds` default 8 (`MRTR-LOOP-1`), overall deadline default = 5 min plus time spent in consent is **excluded** from the request timeout but included in the overall deadline (`MRTR-LOOP-2`), each wire request has its own request timeout (5.4).
7. Retries carrying `inputResponses`/`requestState` are **never cached** and their results never enter the cache (`CACHE-MRTR-1`).

Modes: `mrtr: "auto"` (default; the library drives rounds through ports and returns the final `Outcome`, with `trace: MrtrRound[]`) or `"manual"` (returns `mrtr-interim` outcome carrying a `resume(inputResponses)` closure so hosts like a durable adapter can persist `{requestState, inputRequests}` and resume later: **the closure is not persisted, the data is**; resume constructs a new request) (`MRTR-MODE-1`).

#### 9.1.1 Cancellation / uncertainty in MRTR
- Abort during consent: cancels the UI via the port's `signal`; no retry is sent; outcome `cancelled` with `phase:"input"`; **no** wire cancellation is needed because the initial request already terminated with the interim result (`MRTR-CANCEL-1`).
- Abort during a retry on the wire: same as any request (5.4).
- Ambiguous break during the **initial** request: `uncertain-write` as usual. During a **retry**: `uncertain-write` too, with `{round, requestState digest}` (`HTTP-AMBIG-5`, `STDIO-RECOVER-1`).

#### 9.1.2 Unsupported input request kinds
The server MUST NOT send `inputRequests` the client did not declare capability for. If one arrives anyway (`sampling/createMessage`, `roots/list`, unknown method, or an `elicitation/create` whose mode we did not declare), the call fails with `protocol-violation/unsupported-input-request{key, method}`; **nothing is fabricated** as an answer; no retry (`MRTR-C-8`). A diagnostic names the server and keys. Rationale: roots/sampling are deprecated and excluded (N8); declining silently would hide a server bug.

### 9.2 Elicitation (host-neutral ports)
Capability advertisement: `clientCapabilities.elicitation` = `{form:{}}` only if an `ElicitationPort.form` is registered, `{url:{}}` only if `ElicitationPort.url` + `BrowserPort` are registered; neither -> key omitted (`ELIC-CAP-1`; empty `{}` would mean form mode, so never send an empty object unless the form port exists). An advertised capability must support at least one mode (`ELIC-CAP-2`).

| Aspect | Client behavior | Row |
|---|---|---|
| Mode | `mode` absent => form (`ELIC-MODE-1`, MUST); `url` only when declared | `ELIC-MODE-1` |
| Form request | `message`, `requestedSchema` restricted to **flat object of primitives**: string (optional `format`, length/pattern constraints), number/integer (min/max), boolean, single-select enum (`enum` or `oneOf` with `const`/`title`), multi-select (`array` of enum/`anyOf`), `default`s pre-populated (SHOULD) | `ELIC-FORM-1` |
| Schema guard | a `requestedSchema` outside the subset (nested object, array of objects, `$ref`, composition) -> **not rendered**; fail the round with `protocol-violation/unsupported-elicitation-schema` (honest failure beats fabricated cancel); UNRESOLVED: confirm whether spec prefers a `decline`; Wave 0 operations lane decides | `ELIC-FORM-2` |
| Form UI duties (MUST) | show which server is asking (server identity from configuration, **not** `serverInfo`), allow review/modify before send, clear decline and cancel | `ELIC-UI-1` (satisfied by contract: port receives `{serverLabel, message, schema}`; conformance via the reference test port asserting these fields are passed) |
| Response | `{action:"accept", content}` \| `{action:"decline"}` \| `{action:"cancel"}`; `content` only for form accept; library **validates `content` against `requestedSchema`** (SHOULD) before sending; invalid -> port is re-prompted once, else `cancel` is sent with a diagnostic | `ELIC-RESP-1`, `ELIC-RESP-2` |
| URL request | `mode:"url"`, `message`, `url` (valid URL); library validates URL parse; scheme must be `https` (or `http` only to loopback when `allowInsecureDev`); other schemes (`javascript:`, `file:`, `data:` ...) rejected -> `decline` not sent; round fails `protocol-violation/unsafe-elicitation-url` | `ELIC-URL-1` |
| URL handling (MUST) | **no pre-fetch** of URL or metadata; **no open without explicit user consent**; show the **full URL** before consent; open it via `BrowserPort.open(url)` in a way that the client/LLM cannot inspect the page or user inputs (system browser, not embedded webview) ; SHOULD highlight domain, warn for punycode/ambiguous hosts, never render URL as clickable elsewhere | `ELIC-URL-2..6` |
| Port contract | `UrlConsentRequest {serverLabel, message, url, hostHighlight, punycodeWarning}` -> `"accept" \| "decline" \| "cancel"`; on accept the library calls `BrowserPort.open`; completion is **not** observable (response has no content) | `ELIC-URL-7` |
| After URL accept | client is not told the outcome; retry resumes (`requestState` carries server correlation); SHOULD give the user a manual retry/cancel control: exposed as `MrtrSession.awaitUserResume()` in manual mode | `ELIC-URL-8` |
| Removed items | `notifications/elicitation/complete` and `elicitationId` do not exist (changelog minor 11); if a server sends the notification it is dropped + diagnostic; error `-32042` never special-cased | `ELIC-REM-1` |
| Sensitive data | form mode must not request secrets (server MUST NOT): the library can't detect semantics, but flags requested field names matching `password\|token\|secret\|api[_-]?key\|card` as `suspect-sensitive-form-field` to the port (warning only) | `ELIC-SEC-1` |
| URL elicitation vs MCP auth | independent: URL-mode never changes the bearer token; the library never sends tokens to elicitation URLs and never treats URL accept as authorization (`AUTH-SEP-1`) | `ELIC-AUTH-1` |

### 9.3 Subscriptions (`subscriptions/listen`)
`packages/mrtr-cache/src/subscriptions.ts`. `client.listen({tools, prompts, resources, resourceUris[]})` returns `Subscription { id, state, acknowledged, events: AsyncIterable<ChangeEvent>, close() }`.
- Request: `{method:"subscriptions/listen", params:{notifications:{toolsListChanged?, promptsListChanged?, resourcesListChanged?, resourceSubscriptions?:string[]}}}` with the normal `_meta` (`SUB-REQ-1`). Only `true`/non-empty entries are set; omitted == not subscribed.
- First message for this subscription **must** be `notifications/subscriptions/acknowledged` carrying `_meta[subscriptionId]` = our request id; on stdio interleaving with other subscriptions' messages is allowed (`SUB-ACK-1`). Ack timeout default 10 s -> fail `transport-failure/no-ack` and close (`SUB-ACK-2`). A notification for this subscription before its ack is dropped + diagnostic (`SUB-ACK-3`).
- The acknowledged `notifications` is the **granted subset**; `acknowledged.unsupported = requested minus granted` is exposed to the caller, never treated as an error (`SUB-ACK-4`, SHOULD handle gracefully).
- Every delivered notification must carry `io.modelcontextprotocol/subscriptionId`; stdio demux by it (MUST); HTTP stream-scoped but we verify anyway; mismatch -> drop + diagnostic (`SUB-ROUTE-1`). Notification type not in the **granted** set -> drop + diagnostic (server MUST NOT send unrequested types) (`SUB-FILTER-1`).
- Concurrent subscriptions supported; demux map `id -> Subscription` (`SUB-MULTI-1`). Changing a filter = open new, await ack, close old (no gap) (`SUB-CHANGE-1`).
- End conditions: (a) server graceful: successful `result {resultType:"complete", _meta.subscriptionId}` for the listen request -> `state:"ended", reason:"server-graceful"`; (b) server `notifications/cancelled{requestId=listenId}` -> `reason:"server-cancelled"`; (c) transport close / HTTP stream break / process exit -> `reason:"transport"`; (d) client `close()` -> stdio sends `notifications/cancelled`, HTTP aborts stream (`SUB-END-1..4`).
- Re-establishment: **stdio MUST re-send** `subscriptions/listen` after reconnect (server keeps no state) (`SUB-REST-1`). HTTP MAY reconnect on abrupt end; default policy `reconnect:"on-abrupt"` with exponential backoff 1 s..60 s + full jitter, max attempts default unlimited-with-cap-per-minute; **graceful end never auto-reconnects** (`SUB-REST-2`). Each reconnect is a new request/id; events missed during the gap are unrecoverable (no resume), so after every re-establishment the cache layer **invalidates** every list/read entry whose invalidation this subscription would have signaled, and emits `resync-needed` event (`SUB-REST-3`, `CACHE-INV-3`).
- Notification -> cache invalidation: `tools/list_changed` -> all `tools/list` pages; `prompts/list_changed` -> all `prompts/list` pages (`prompts/get` is not cacheable); `resources/list_changed` -> `resources/list` and `resources/templates/list` (conservative; UNRESOLVED whether templates are meant); `resources/updated{uri}` -> `resources/read` entries for that exact uri (`CACHE-INV-1`, `SUB-INV-1`).
- Not applicable: request timeouts (a listen request has an idle watchdog instead: 7.5 `listenIdleMs`); `progress` (not delivered on listen streams).
- Server-side limits we respect: UNRESOLVED whether servers cap URIs per subscription; the library caps `resourceSubscriptions` at 1000 by default (configurable) to bound requests (11.3).
- Per-capability gating: only request types for which the server's capabilities advertise support (`tools.listChanged` etc.) when discover data is known; otherwise request and read the ack (`SUB-GATE-1`).
- Auth: 401 on opening -> auth layer; token expiry mid-stream does not interrupt an open HTTP stream (UNRESOLVED server behavior); on reconnect the fresh token is used (`SUB-AUTH-1`).

### 9.4 Cache metadata and bounded caching (`cache.ts`)
Cacheable: `server/discover`, `tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, only for `resultType:"complete"` results (`CACHE-SCOPE-1`).

| Rule | Implementation | Row |
|---|---|---|
| Key | `(serverRef, method, canonicalJson(params minus _meta), authContextId if scope private)`: **cursor** and **uri** are in `params`; different method/params never share an entry (MUST NOT) | `CACHE-KEY-1` |
| Never cached | `input_required`; retries with `inputResponses`/`requestState`; JSON-RPC errors; transport failures; `tool-isError` | `CACHE-NEG-1`, `CACHE-MRTR-1` |
| TTL | fresh while `now < t_received + ttlMs` using the **local monotonic clock** (not wall clock); `ttlMs` absent -> 0; negative -> 0 (SHOULD ignore); non-integer -> floor; above `maxTtlMs` (default 24 h) -> clamp | `CACHE-TTL-1..3` |
| `ttlMs: 0` | stale immediately; not stored (or stored for single-flight only) | `CACHE-TTL-4` |
| `cacheScope` | `"public"`: entry reusable regardless of auth context **only if** `cache.sharePublic` (default **false**, conformant because sharing is a MAY) so default behavior partitions every entry by `authContextId`; `"private"`: always partitioned, never reused across auth contexts, never written to a shared/persistent store unless the `CacheStore` declares per-principal isolation; absent scope -> treated as `"private"` | `CACHE-SCOPE-2`, `CACHE-SCOPE-3` |
| `authContextId` | opaque id from the auth layer: `hash(serverRef, issuer, client_id, grantId)`, **not** the raw token (token refresh within a grant keeps the id; a new grant, logout, issuer change, or scope-step-up change **changes** it - UNRESOLVED/Director D5: spec text says "a different access token requires a different cache"; if the director wants the strict reading the id becomes `hash(accessToken)` and refresh flushes private entries) | `CACHE-AUTH-1` |
| Pagination | each page is its own entry with its own TTL clock; cursor invalid error (-32602 on a cursor) -> **discard all cached pages for that list** and refetch from start; servers MUST keep scope uniform across pages: a page whose scope differs from the first page downgrades the whole list to private + diagnostic | `CACHE-PAGE-1..3` |
| Notifications | invalidation per 9.3; a notification arriving while an entry is fresh invalidates it | `CACHE-INV-1` |
| TTL is not a poll interval | no background refetch by default; if `autoRefresh` enabled: jitter + exponential backoff (MUST when polling) | `CACHE-POLL-1` |
| Early refetch | allowed when a call error suggests staleness (unknown tool, invalid params): `tools.call` failing with -32602 "unknown tool" triggers `invalidate(tools/list)` (MAY) | `CACHE-EARLY-1` |
| Stale-if-error | MAY; default **off**; when on, returned entry flagged `stale:true`, `staleReason` | `CACHE-STALE-1` |
| Single-flight | concurrent identical misses coalesce (derived, avoids stampede; must not coalesce across different `authContextId` or across different abort signals: each caller's abort detaches only itself) | `CACHE-SF-1` |
| Bounds | max 500 entries, 32 MiB serialized, LRU; per-entry max 4 MiB (resource blobs above are returned uncached) | `CACHE-LIMIT-1` |
| Storage | in-memory default; `CacheStore` port for persistence (Durable adapter) with the isolation rule above | `CACHE-STORE-1` |
| Observability | `Outcome.meta.cache: "hit"\|"miss"\|"stale"\|"bypass"`; emitted as telemetry attribute (11.2) | `CACHE-OBS-1` |
| Security | caching never substitutes for access control; a 401/403 for a request purges the private entries of that `authContextId` for that server | `CACHE-SEC-1` |
| `server/discover` | cached under the same rules; invalidated when a request fails with `-32022` or `-32021`, or after reconnect | `CACHE-DISC-1` |

### 9.5 Acceptance fixtures (names; mapping in 13.4)
`mrtr/elicit-form-accept-retry-new-id`, `mrtr/request-state-opaque-echo`, `mrtr/no-state-no-echo`, `mrtr/state-only-no-input-requests`, `mrtr/neither-field-violation`, `mrtr/unsupported-method-rejected`, `mrtr/sampling-input-request-fails`, `mrtr/parallel-calls-isolated-state`, `mrtr/max-rounds`, `mrtr/cancel-during-consent`, `mrtr/retry-not-cached`, `elic/url-no-prefetch`, `elic/url-full-url-shown`, `elic/url-bad-scheme`, `elic/form-schema-outside-subset`, `elic/form-response-validated`, `elic/capability-only-when-port`, `sub/ack-first`, `sub/ack-subset`, `sub/two-listeners-demux`, `sub/unrequested-type-dropped`, `sub/graceful-close`, `sub/stdio-restart-resend`, `sub/http-abrupt-reconnect-invalidates-cache`, `cache/ttl-fresh-stale`, `cache/ttl-absent-negative`, `cache/private-not-shared-across-auth`, `cache/public-default-partitioned`, `cache/cursor-in-key`, `cache/invalid-cursor-purge`, `cache/notification-invalidates`, `cache/input-required-not-cached`.

## 10. Authorization and consent

Anchors: `S/basic/authorization/index.md` (AUTHZ), `.../authorization-server-discovery.md` (ASD), `.../client-registration.md` (REG), `.../security-considerations.md` (SECC), `W/docs/2026-07-28/tutorials/security/security_best_practices.md` (SBP, SSRF section), changelog minors 7-9. Package: `packages/auth` (HTTP-only; stdio never imports it, `STDIO-AUTH-1`). Auth uses RFC text (6749/6750/7636/8414/8707/9207/9728, OAuth 2.1 draft, CIMD draft-00) as standards inputs; they are standards, not MCP implementations (N1, N4).

### 10.1 Layering and ports
`AuthProvider` is a narrow interface consumed by `transport-http` through a request interceptor (`transport-http` never imports `auth`; both import the `AuthProvider` type from `core`):

```ts
// packages/core/src/auth-types.ts
export interface AuthProvider {
  /** Headers for the next request to `resource` (canonical URI). Called for EVERY HTTP request (AUTHZ "included in every request"). */
  authorize(ctx: { resource: string; signal: AbortSignal }): Promise<AuthHeaders | undefined>;
  /** Called on 401/403 with parsed challenge; resolves to "retry" (new credentials ready) or "fail". */
  onChallenge(ctx: { resource: string; status: 401 | 403; challenges: BearerChallenge[]; operation: OperationKey; signal: AbortSignal }): Promise<"retry" | "fail">;
  /** Opaque, stable per (server, issuer, client_id, grant); NOT the token. Used as cache partition (9.4). */
  readonly contextId: () => string;
}
```
Host-neutral ports used by `packages/auth` (all optional; absent port => that flow is unavailable and reported as `auth-unavailable/<flow>`):

| Port | Methods | Used by |
|---|---|---|
| `BrowserPort` | `open(url: URL, opts:{purpose:"authorize"\|"elicitation"}): Promise<void>` (system browser; must not give the page contents back to the client) | auth code flow, URL elicitation |
| `RedirectPort` | `waitForCallback({redirectUri, state, signal, timeoutMs}): Promise<URLSearchParams>`; reference loopback implementation in `packages/auth/src/node-loopback.ts` binds `127.0.0.1` on an ephemeral port, accepts exactly one request on the registered path, replies a static page, closes | auth code flow |
| `ConsentPort` | `confirm(kind, details): Promise<"accept"\|"decline"\|"cancel">` where `kind` in `authorize` (shows server label, AS issuer host, scopes, resource), `client-info` (prompt user for pre-registered client id/secret when no other registration works), `tool-call` (optional), `url-elicitation`, `form-elicitation` | all host-visible decisions |
| `CredentialStore` | `get/put/delete(key)`, where key = `{serverRef, issuer, clientId?}`; values opaque; contract: confidentiality at rest is the host's duty (MUST keep refresh tokens confidential, SECC "Token Theft"); in-memory default | tokens, client registrations |
| `IdentityPort` | extension seam (Enterprise-Managed Authorization, 12.4): obtain an IdP assertion/ID token | ext-enterprise-auth |
| `FetchPort` | SSRF-guarded fetch for discovery (10.7); default implemented in `packages/auth/src/safe-fetch.ts` | discovery/CIMD/JWKS |
| `Clock`, `Random` | injected for deterministic tests (`state`, PKCE verifier) | tests |

### 10.2 Challenge handling and discovery
1. **Bearer parsing**: parse every `WWW-Authenticate` header (multiple headers and multiple comma-separated challenges; quoted-string params with escapes; case-insensitive scheme/param names). Fields kept: `resource_metadata`, `scope`, `error`, `error_description`, `error_uri` (`AUTH-CHAL-1`). Malformed header -> treated as no challenge (diagnostic), not a crash.
2. **PRM discovery order** (ASD): `resource_metadata` URL from the header when present; otherwise `/.well-known/oauth-protected-resource/<path of MCP endpoint>` then `/.well-known/oauth-protected-resource` at the origin root (`AUTH-PRM-1`, MUST support both). PRM must list at least one `authorization_servers` entry, else `auth-failure/prm-invalid` (`AUTH-PRM-2`). Per RFC 9728 (standard input), `resource` in PRM must match the MCP server's canonical URI; mismatch -> reject (mix-up/confused-deputy guard; UNRESOLVED: the wiki pages do not restate the check, derive from RFC 9728 section 3.3 and record as `derived`) (`AUTH-PRM-3`).
3. **AS selection**: PRM may list several independent authorization servers; the client chooses (`AuthServerChooser` callback; default: first entry whose metadata passes the PKCE/https checks). State (client credentials, tokens) is kept **per AS** and never reused across AS (`AUTH-AS-1`, ASD "MUST maintain separate registration state").
4. **AS metadata discovery** (ASD, MUST try in order): for issuer with path: (1) `/.well-known/oauth-authorization-server/<path>`, (2) `/.well-known/openid-configuration/<path>`, (3) `<issuer>/.well-known/openid-configuration`; no path: (1) oauth-authorization-server, (2) openid-configuration (`AUTH-ASM-1`). `issuer` in the document must equal the issuer used to build the URL (exact) (RFC 8414 s3.3 / OIDC s4.3) (`AUTH-ASM-2`). Fields consumed: `authorization_endpoint`, `token_endpoint`, `code_challenge_methods_supported`, `client_id_metadata_document_supported`, `authorization_response_iss_parameter_supported`, `scopes_supported`, `grant_types_supported`, `registration_endpoint` (**read, never used**, DCR excluded).
5. All endpoints from metadata: https required (loopback http only under `allowInsecureDev`), checked before use (`SECC#Communication Security`; `AUTH-COMM-1`).

### 10.3 Registration (priority order, DCR removed)
Per `REG` priority: (1) **pre-registered** `{clientId, clientSecret?}` supplied by host config for this server+issuer (`AUTH-REG-1`, SHOULD support); (2) **Client ID Metadata Document** when AS metadata advertises `client_id_metadata_document_supported: true` (`AUTH-REG-2`, SHOULD): the host supplies `clientIdUrl` (https, has path, document hosted by the host/app; the library does not host it). The library validates the URL shape, and (optional `selfCheck`) fetches it via `FetchPort` and checks that `client_id` equals the URL exactly, `client_name` and `redirect_uris` present, and the chosen `redirect_uri` is listed (`AUTH-REG-3`, MUST/derived). `private_key_jwt` client auth (CIMD MAY) is deferred behind `ClientAuthPort` (no default; Wave 2 optional). (3) **DCR: not implemented** (deprecated, PR 2858; `AUTH-DCR-1`, excluded): the library never POSTs to `registration_endpoint`, never sends `application_type` (that requirement in changelog minor 8 only applies to DCR users). (4) otherwise `ConsentPort.confirm("client-info")` asks the host/user for pre-registered credentials; if the port is absent -> `auth-failure/no-registration-mechanism` with advice (`AUTH-REG-4`).
- **AS binding** (SEP-2352; `AUTH-BIND-1`, MUST): persist registrations keyed by `issuer`; never reuse credentials with another AS; AS changed for the same server -> discard registration+tokens and redo; surface a notice (`AUTH-BIND-2`, SHOULD).

### 10.4 Authorization code flow
- Authorization requests: `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` (S256), `code_challenge_method=S256`, `state` (random >= 128 bits, verified on callback; SHOULD), `scope` (below), `resource` (canonical server URI) (`AUTH-FLOW-1`).
- **PKCE** MUST: verify `code_challenge_methods_supported` includes `S256`; **absent -> refuse** (also for OIDC-only metadata) (`AUTH-PKCE-1`). Verifier 43..128 chars from 32 random bytes (`Random` port), stored in the per-attempt record with `state`, expected issuer, redirect URI (`AUTH-PKCE-2`).
- **Redirect URIs**: must be `localhost`/loopback or https (SECC); must be registered/listed in CIMD (`AUTH-REDIR-1`). Show the redirect host in the consent display (`AUTH-REDIR-2`, localhost warning).
- **Resource indicator** (RFC 8707): `resource` in authorization **and** token requests (and refresh), canonical URI (lowercase scheme/host, no fragment, no trailing slash unless significant; examples in AUTHZ), sent regardless of AS support (`AUTH-RES-1`, MUST). Canonicalization vectors from AUTHZ examples are fixtures (`AUTH-RES-2`).
- **Callback validation** (before any token request; `AUTH-ISS-1..4`): record issuer pre-redirect; `state` must match one pending attempt (single use); `iss` table from AUTHZ#Authorization Response Validation: `supported=true & iss present` -> exact string compare; `true & absent` -> reject; `false/absent & present` -> compare; `false/absent & absent` -> proceed. Compare **without** normalization (no case folding, port/slash/percent normalization). On mismatch (also on error responses) do **not** act on or display `error`/`error_description`/`error_uri`. Authorization code sent only to the recorded AS token endpoint.
- Token request: `grant_type=authorization_code`, `code`, `code_verifier`, `redirect_uri`, `client_id`, `resource` (+ client auth when confidential) (`AUTH-TOKEN-1`).
- **Scope selection** (`AUTH-SCOPE-1`): (1) `scope` from initial `WWW-Authenticate`; (2) else all `scopes_supported` from PRM; (3) omit `scope` if neither. No assumption on relation between challenge scopes and `scopes_supported`. Least privilege otherwise. `offline_access` only if the AS lists it and host opts in (`AUTH-SCOPE-2`, MAY).

### 10.5 Token use, refresh, step-up
- `Authorization: Bearer <token>` on **every** HTTP request including `server/discover`, listen, retries; **never** in the query string (`AUTH-USE-1`, `AUTH-USE-2`); never on stdio.
- A token is bound to `(canonical resource, issuer)`; the interceptor refuses to attach it to any other origin/resource and strips it on cross-origin redirect (`AUTH-USE-3`; AUTHZ "MUST NOT send tokens other than ones issued by the MCP server's AS").
- **Refresh**: use `refresh_token` grant with `resource`; refresh tokens stored via `CredentialStore` (confidential); don't assume issuance; if refresh fails with `invalid_grant` -> discard, start interactive flow if a `ConsentPort` exists (`AUTH-REFRESH-1..3`). Refresh proactively when `expires_in` is within `skewMs` (default 30 s) (derived).
- **Single-flight** (`AUTH-CONC-1`): N concurrent requests hitting 401 trigger at most **one** refresh/authorization; others await the same promise; abort of one requester detaches only itself. A pending interactive authorization is shared; a user decline resolves all waiters with `auth-failure/declined`.
- **401 handling** (`AUTH-401-1`): response 401 (token missing/invalid/expired) -> `onChallenge`; if `retry`, re-issue as a **new request id** (a 401 means the server rejected before processing; safe even for writes, since the HTTP status is definitive pre-execution); at most one auth retry per request (`AUTH-401-2`).
- **403 / `insufficient_scope`** (`AUTH-STEP-1..4`): parse `scope`, union with previously requested scopes (never drop granted ones), re-authorize (user-driven clients SHOULD; `client_credentials` clients MAY abort), retry; track attempts per `(resource, operation)`, default limit 3, then permanent `auth-failure/insufficient-scope` (SHOULD). A 403 without `insufficient_scope` is `transport-failure/forbidden`, not a step-up trigger.
- **Auth continuity across requests** (gate scenario): in-flight requests on a stream are not interrupted by token expiry; the next request re-authorizes; a long `subscriptions/listen` reconnect uses the then-current token (`AUTH-CONT-1`).
- Tokens/secrets never logged or placed in telemetry or `uncertain-write` digests (`AUTH-LOG-1`; fixture scans all emitted diagnostics for the test token string).

### 10.6 Configured bearer credentials
`ConfiguredBearer` implements `AuthProvider` with a host-supplied `token: string | () => Promise<string>` (e.g., an environment-provided API token): sent on every request to the configured origin only; no discovery or flows run; on 401 `onChallenge` calls the optional `refresh()` callback, else `fail` (`AUTH-BEARER-1..3`). It is an **allowed** mechanism per PLAN.md ("OAuth + configured bearer credentials"), and a bearer configured for server A is never sent to server B (`AUTH-BEARER-4`). The bearer's `contextId` is `hash(serverRef, "bearer", hash(token))` so token changes partition caches (strict reading of CACHE-AUTH-1 for this mechanism).

### 10.7 SSRF, redirect, audience controls (`safe-fetch.ts`)
Applies to PRM, AS metadata, CIMD self-check, JWKS, opt-in `$ref` fetches, any URL from a server-controlled value (`SBP#Server-Side Request Forgery`). Rules (`AUTH-SSRF-1..6`): https only (http only for loopback under `allowInsecureDev`); resolve DNS then **validate the resolved address** with `node:net` `BlockList` over IPv4/IPv6 (10/8, 172.16/12, 192.168/16, 127/8, ::1, 169.254/16 incl. metadata 169.254.169.254, fc00::/7, fe80::/10, plus IPv4-mapped IPv6, and numeric-encoding normalization by parsing with `net.isIP` + WHATWG URL, never by regex); connect to the validated IP (pinning, TOCTOU) while keeping SNI/Host of the original name; redirects `manual`, max 3, each hop re-validated, https->http refused; response size cap 1 MiB, timeout 10 s, no cookies, no ambient credentials, no `Authorization`. Operators can inject an egress `FetchPort` instead. Browser authorization URLs are validated the same way for scheme (https) before `BrowserPort.open`, but not for IP range (users may be on private networks) - host decision recorded in 17 (D6).
- Audience: the client cannot inspect opaque tokens; it ensures `resource` is sent and tokens are only presented to the resource they were requested for (`AUTH-AUD-1`).
- Mix-up: issuer recorded, compared (10.4); AS endpoints taken **only** from validated metadata of the chosen AS (`AUTH-MIX-1`).
- Open redirect: only registered redirect URIs; ignore any `redirect_uri` returned by servers (`AUTH-REDIR-3`).

### 10.8 Host consent model
Core never decides policy. It guarantees **interception points** with enough context for a host to show an informed choice: `authorize` (what server, which AS host, scopes, resource, redirect host), `url-elicitation` (full URL), `form-elicitation` (server label, message, schema), `tool-call` (name, arguments digest + raw args, annotations flagged untrusted), `client-info`. A missing port means "deny/unavailable", never "auto-approve" (`CONSENT-1`). Decline/cancel are distinct outcomes (`CONSENT-2`). Tests use a scripted `TestConsentPort` and assert both the payload shown and the post-decision wire behavior (`CONSENT-3`).

### 10.9 Excluded or out of scope
DCR (excluded), HTTP+SSE auth, stdio OAuth, server-side token validation/audience checks (server role: recorded `out-of-scope`), authorization-server implementation, token passthrough (server), proxy-server consent (server role), `private_key_jwt` default support (deferred), `client_credentials` and enterprise IdP flows (extensions, 12.3-12.4).

### 10.10 Acceptance fixtures (synthetic server + synthetic AS in `packages/fixtures`)
`auth/401-prm-header`, `auth/prm-wellknown-subpath-then-root`, `auth/as-metadata-order-path-issuer`, `auth/as-issuer-mismatch`, `auth/pkce-absent-refused`, `auth/resource-param-authz-and-token`, `auth/iss-table` (4 rows + error response), `auth/state-mismatch`, `auth/cimd-flow`, `auth/pre-registered-flow`, `auth/dcr-never-called` (AS advertises only `registration_endpoint`: no POST observed, `no-registration-mechanism`), `auth/as-change-reregisters`, `auth/refresh-single-flight`, `auth/401-retry-new-id`, `auth/step-up-union-scopes`, `auth/step-up-limit`, `auth/token-not-in-query`, `auth/token-not-forwarded-cross-origin`, `auth/configured-bearer`, `auth/ssrf-block-ranges` (table of encodings: `0x7f.1`, `2130706433`, `::ffff:127.0.0.1`, `[::1]`, `169.254.169.254`), `auth/ssrf-redirect-hop`, `auth/secrets-not-logged`, `consent/decline-vs-cancel`, `consent/missing-port-denies`.

## 11. Telemetry, errors, limits

Anchors: `W/seps/414-request-meta.md` (SEP-414), `S/basic/index.md#_meta` (OpenTelemetry trace context), `S/basic/index.md#Error Codes`, `S/basic/patterns/cancellation.md#Timeouts`. Package: errors/limits in `packages/core`; telemetry interface in `packages/core/src/telemetry.ts` (no OTel dependency in core).

### 11.1 Telemetry (kept separate from progress and stderr, N9)
- **Three independent channels**: (1) *progress* = protocol notifications delivered to the caller (5.6); (2) *stderr diagnostics* = captured child output (6.1), a host-readable ring buffer, never telemetry; (3) *OpenTelemetry* = spans/metrics via `TelemetryPort`. No channel feeds another (`TEL-SEP-1`; test: emit progress and stderr, assert zero spans/events created and vice versa).
- **Trace context propagation**: when the host's `TelemetryPort.activeContext()` returns a W3C trace context, the library writes `_meta.traceparent` (+ optional `tracestate`, `baggage`) on the outgoing request body; keys are **unprefixed** exactly as written (SEP-414: namespacing them would break traces) (`TEL-CTX-1`). Values validated against W3C formats before sending (`traceparent` = `00-<32 hex>-<16 hex>-<2 hex>`, not all-zero ids; `tracestate`/`baggage` size caps: UNRESOLVED, apply W3C limits 512 chars/32 members); invalid -> omitted + diagnostic (`TEL-CTX-2`). The library never fabricates a trace context itself (host/OTel SDK owns ids) (`TEL-CTX-3`).
- HTTP transport does **not** additionally set `traceparent` HTTP headers unless the host's OTel HTTP instrumentation does so; MCP-level `_meta` is the specified carrier (`TEL-CTX-4`).
- **Spans**: one client span per request, name `mcp.client <method>`; attributes follow the OpenTelemetry MCP semantic conventions (`opentelemetry.io/docs/specs/semconv/gen-ai/mcp/`; referenced in `S/basic/index.md`; attribute names UNRESOLVED until that page is pinned: Wave 0 Wire lane fetches and records its revision). Mandatory local attributes: `mcp.method.name`, `mcp.protocol.version`, `network.transport` (`pipe`|`tcp`), outcome kind, retry-of link, `cache` state. **Never** attributes carrying arguments, tokens, `requestState` content, URLs with credentials, or tool results by default (`TEL-PRIV-1`); `captureContent:false` default.
- `TelemetryPort` default is a no-op; no OTel package is imported by core; `packages/telemetry-otel` (optional, Wave 2, adapter implementing the port with `@opentelemetry/api` pinned) (`TEL-ADAPT-1`).
- Removed/excluded: MCP Logging (`logLevel`, `notifications/message`) is not telemetry (N8).

### 11.2 Error taxonomy (normalized `Outcome`, 4.4; each class has distinct type and no overlap)
| Class (`kind`) | Source | Retry guidance | Examples |
|---|---|---|---|
| `jsonrpc-error` | peer returned `error` | not retried automatically except documented cases (version retry, header-mismatch refresh) | -32700, -32600, -32601, -32602, -32603, -32020, -32021, -32022, unknown reserved; `resource-not-found` is a refinement of -32602/-32002 |
| `protocol-violation` | peer broke a MUST (unknown resultType, request on stream, bad ack order, noise) | never retry; report evidence | see 5.2, 7.5, 9.x |
| `transport-failure` | connect/spawn/stream/status failure with **no** JSON-RPC error | per phase table: `safeToRetry` boolean, set from certainty about delivery | `connect`, `spawn`, `process-exit`, `stream-broken`, `http-status`, `closed`, `timeout`, `forbidden`, `too-large` |
| `tool-isError` | `tools/call` result with `isError:true` | model-facing; never auto-retried | validation failures from the tool |
| `mrtr-interim` | `resultType:"input_required"` in manual mode | resume with `inputResponses` | 9.1 |
| `task-handle` | extension `resultType` from Tasks | poll via extension | 12.1 |
| `uncertain-write` | request may have taken effect, no response observed | **never** auto-retried; caller reconciles | 6.5, 7.7 |
| `ok` | `resultType:"complete"`, no `isError` | - | - |
| `cancelled` | local abort with response observed or request provably unsent | - | wire facts recorded as `wasSent` |
| `auth-failure`, `auth-unavailable` | auth layer | host UI | 10 |
| `capability-absent`, `invalid-arguments`, `invalid-schema`, `unsupported-version` | local classification | n/a | 5.3, 8.x |
| `local-error` | library misuse/bug (`ProgrammerError`) | never retried | **never** printed in JSON-RPC-shaped structure (spec: local errors must not be mistaken for peer errors) |

Rules: (1) a local timeout is a `transport-failure/timeout` (or `uncertain-write`), **never** a `jsonrpc-error`, and it carries no numeric JSON-RPC code (`ERR-LOCAL-1`; spec: "purely local errors ... ensure they cannot be mistaken for errors received from the peer"). (2) A peer `-32602` for an invalid cursor/tool/resource is `jsonrpc-error` always, with refinement tags. (3) `isError` is never converted to a throw by default. (4) Errors carry `cause`, `requestId`, `method`, `binding`, redacted evidence.
- Public API shape: functions return `Promise<Outcome<T>>`; a convenience `.unwrap()` throws typed `McpOutcomeError` subclasses for hosts that prefer exceptions (`API-OUT-1`).

### 11.3 Timeouts, bounds and defaults (all overridable per client and per request)
| Limit | Default | Row |
|---|---|---|
| Request timeout | 60 s (hard max 10 min unless overridden) | `WIRE-TO-1` |
| `server/discover` probe timeout (stdio) | 10 s | `STDIO-DISC-1` |
| Spawn-to-first-response | 30 s | `STDIO-LAZY-1` |
| Shutdown grace / term | 2 s / 2 s | `STDIO-SHUT-1` |
| Max stdio line | 16 MiB | `STDIO-LIMIT-1` |
| stdout noise budget | 100 lines / 1 MiB | `STDIO-STDOUT-1` |
| stderr ring | 64 KiB, 4 KiB/line | `STDIO-STDERR-1` |
| Max HTTP response body (JSON) | 64 MiB | `HTTP-LIMIT-1` |
| Max SSE event / total stream | 4 MiB / 64 MiB | `HTTP-LIMIT-1` |
| Listen idle watchdog | 120 s (off for non-listen) | `HTTP-LIMIT-1` |
| Redirects (MCP endpoint) | 3 same-origin | `HTTP-REDIR-1` |
| Discovery fetch (auth) | 10 s, 1 MiB, 3 redirects | `AUTH-SSRF-*` |
| Pagination pages / items | 1000 / 100 000 | `PAGE-5` |
| MRTR rounds / overall deadline | 8 / 5 min | `MRTR-LOOP-1/2` |
| Concurrent in-flight requests per client | 256 (excess queued, FIFO, abortable) | `LIM-CONC-1` |
| Concurrent listen streams | 8 | `LIM-SUB-1` |
| `resourceSubscriptions` per stream | 1000 | `LIM-SUB-2` |
| Schema bytes / depth / subschemas | 1 MiB / 64 / 10 000 | `OPS-SCHEMA-6` |
| Cache entries / bytes / per-entry | 500 / 32 MiB / 4 MiB | `CACHE-LIMIT-1` |
| Progress notifications/s per request delivered | 50 (excess coalesced; last value always delivered) | `LIM-PROG-1` (progress flooding guard, `S/basic/patterns/progress.md` SHOULD rate-limit) |
| Diagnostics buffered | 1000 events ring | `LIM-DIAG-1` |
| Auth retry per (resource, op) | 3 | `AUTH-STEP-3` |
Bounds failures are typed (`limit-exceeded{limit, observed}`), never silent truncation (except explicitly noted: completion values, progress coalescing).

### 11.4 Edge-case catalogue (each becomes a fixture; IDs `EDGE-*`)
| ID | Case | Expected | Anchor |
|---|---|---|---|
| EDGE-1 | Two requests, responses arrive reversed | each settles with its own id | S/basic/index.md#Responses |
| EDGE-2 | Duplicate response for one id | second ignored + violation diagnostic | derived |
| EDGE-3 | Response id type mismatch (`"1"` vs `1`) | **not** equal (ids compared strictly by type) -> unknown id, ignored | S/basic/index.md#Requests |
| EDGE-4 | `id: null` in response | cannot correlate; diagnostic | S/basic/index.md |
| EDGE-5 | Cancel races a completed response | settles `ok`; no error | cancellation.md |
| EDGE-6 | Abort before send | no wire traffic; `cancelled{wasSent:false}` | derived |
| EDGE-7 | Abort mid-SSE (HTTP) | connection closed; no `notifications/cancelled` | cancellation.md |
| EDGE-8 | Server sends progress with decreasing value | dropped | progress.md |
| EDGE-9 | Progress after final response | dropped | progress.md |
| EDGE-10 | Result carries `resultType:"task"` w/o Tasks registered | `protocol-violation` | index.md#ResultType |
| EDGE-11 | Unicode: BOM, lone surrogate in JSON, NUL | parse per JSON; invalid UTF-8 on stdio -> protocol violation | basic/transports/index.md |
| EDGE-12 | Huge integer ids/progress (>2^53) | ids we generate stay <2^53; inbound parsed as number (precision loss) flagged | derived |
| EDGE-13 | Result missing `_meta.serverInfo` | fine | basic/index.md |
| EDGE-14 | Capability object has unknown keys | preserved, ignored | derived |
| EDGE-15 | `tools/list` returns duplicate tool names | keep first, warn (SHOULD be unique) | tools.md#Tool Names |
| EDGE-16 | Tool name has spaces/comma | accepted, warned | tools.md |
| EDGE-17 | `nextCursor: ""` | continue | pagination.md |
| EDGE-18 | `ttlMs` is string/float/huge | non-integer coerce/floor; wrong type -> 0 + diagnostic | caching.md |
| EDGE-19 | SSE data split across chunks mid-UTF-8 | reassembled | derived |
| EDGE-20 | SSE `data:` JSON invalid | event dropped + violation counter; stream continues, request ultimately fails if no response | derived |
| EDGE-21 | HTTP 200 with empty body for a request | protocol-violation, write uncertain | derived |
| EDGE-22 | `Mcp-Name` with non-ASCII tool name | base64 sentinel | HTTP-ENC |
| EDGE-23 | MRTR retry returns another `input_required` with same key repeatedly | rounds cap | MRTR-LOOP-1 |
| EDGE-24 | `requestState` contains `\n`/quotes | echoed verbatim | MRTR-C-4 |
| EDGE-25 | Subscription ack never arrives | timeout, close | SUB-ACK-2 |
| EDGE-26 | Listen notifications interleaved on stdio with a response | routed independently | stdio.md |
| EDGE-27 | Process exits during consent prompt | MRTR session fails `transport-failure`; consent aborted | derived |
| EDGE-28 | Same cursor string returned for two pages | loop guard | PAGE-5 |
| EDGE-29 | Auth: 401 on `server/discover` | normal auth path | AUTH-401-1 |
| EDGE-30 | Auth: `WWW-Authenticate` with only `Basic` | no bearer challenge -> `auth-failure/unsupported-scheme` | derived |
| EDGE-31 | Auth: PRM lists AS with only DCR | `no-registration-mechanism` | AUTH-REG-4 |
| EDGE-32 | Server returns `-32002` for resource | resource-not-found | OPS-RES-ERR-1 |
| EDGE-33 | Server emits `notifications/message` unsolicited | dropped + counted | WIRE-LOG-1 |
| EDGE-34 | Server emits `-32042` | plain `jsonrpc-error` | basic/index.md#Error Codes |
| EDGE-35 | Server emits `ping` request | violation (server request) | patterns/index.md |
| EDGE-36 | Clock jump during TTL | monotonic clock used | CACHE-TTL |
| EDGE-37 | Concurrent identical `tools/list` misses | single-flight | CACHE-SF-1 |
| EDGE-38 | Abort one of two single-flight waiters | other completes | CACHE-SF-1 |
| EDGE-39 | Extension result type registered then unregistered mid-flight | request settles with `protocol-violation` | EXT-REMOVE |
| EDGE-40 | Header injection via tool arg containing CRLF with `x-mcp-header` | base64 encoded | HTTP-ENC-1 |

## 12. Optional extensions

Anchors: `W/extensions/overview.md` (lifecycle table, "Extensions are always disabled by default and require explicit opt-in ... at every stage"), `W/extensions/client-matrix.md`, `W/seps/3392-extension-lifecycle.md` (SEP-3392), `S/basic/versioning.md#Extension Negotiation`. Each extension is its own package, loaded only by explicit `client.use(ext)`; `packages/core` has **no** import of any extension and no extension method names.

### 12.0 Common extension contract

```ts
// packages/core/src/extension.ts
export interface Extension {
  readonly id: string;                        // e.g. "io.modelcontextprotocol/tasks"
  readonly stage: "stable" | "beta" | "experimental" | "draft";
  readonly pin: ExtensionPin;                 // repo + commit/tag/revision or wiki page + frontmatter version
  readonly defaultEnabled: false;             // literal type: nothing is on by default (overview.md)
  /** Settings object advertised in clientCapabilities.extensions[id]; undefined => do NOT advertise. */
  settings(): Record<string, unknown> | undefined;
  /** Advertise only while this is "working" (dependencies present, self-test passed). */
  health(): "working" | "degraded" | "unavailable";
  /** resultType values this extension adds to the core set (basic/index.md#ResultType). */
  resultTypes?: ReadonlyMap<string, ResultTypeHandler>;
  /** Wire methods/notifications the extension owns; core routes by registry, never by name knowledge. */
  methods?: ReadonlyMap<string, MethodHandler>;
  notifications?: ReadonlyMap<string, NotificationHandler>;
  /** Called once with the narrow host surface the extension is allowed to use. */
  attach(host: ExtensionHost): Disposable;
}
export interface ExtensionHost {
  request<T>(spec: RequestSpec, opts?: RequestOptions): ClientRequest<T>;   // same stream primitives as core
  openStream(spec: StreamSpec, opts?: RequestOptions): StreamHandle;       // for events/stream, listen-like
  capabilities(server: ServerRef): DiscoveredCapabilities | undefined;
  ports: PortRegistry;                                                      // consent/browser/storage/listener, only what the host provided
  telemetry: TelemetryPort;
}
```
Rules (all rows `EXT-*`):
- `EXT-REG-1`: registration is explicit and per client instance; importing a package registers nothing (no side effects at import; lint rule `no-import-side-effects`).
- `EXT-CAP-1`: `clientCapabilities.extensions[id]` appears **only** when `settings()` returns a value and `health()==="working"`. A capability whose required port is missing (e.g., Apps without a renderer) reports `unavailable` and is omitted. No vacuous flags (PLAN.md).
- `EXT-CAP-2`: the client does not call an extension's methods on a server whose discovered capabilities lack the extension id (Events: MUST NOT; others: by the same rule), unless the host forces it (`force:true`) (SEP-3415 fallback).
- `EXT-REV-1` (SEP-3392): Experimental/Beta settings may carry a `revision` string; a peer `revision` we do not know -> **do not enable** the extension for that server (SHOULD NOT enable); absent = initial revision. Extension data from peers is untrusted and validated against the pinned schema.
- `EXT-RES-1`: `resultType` values added by extension X are valid only while X is registered and working; otherwise `protocol-violation` (EDGE-10, EDGE-39).
- `EXT-STREAM-1`: Tasks and Events use the **same** `ClientRequest`/`StreamHandle` primitives as core; no extension needs a private transport path (PLAN.md modules item 3).
- `EXT-REMOVE-1` **removal test**: for each extension package, CI job `remove:<ext>` deletes the package directory (and its import) then runs the full core fixture suite + the other extensions' suites: all must pass byte-identically (same wire transcripts for core fixtures). A second job asserts that the `clientCapabilities` of a client built without the extension contain no trace of the id. Per-extension acceptance additionally includes the **negative** fixture: server returns the extension's result type to an unregistered client -> `protocol-violation`, no crash.
- `EXT-PIN-1`: each extension package has `PIN.md` stating source revisions and "what changed since" (SEP-3392: Experimental may change any time; implementers pin to a tag/commit).
- `EXT-STAGE-1` (stage handling): Stable = implement and claim after fixtures pass; Beta = implement behind `stage:"beta"` badge and **do not** count as core conformance; Experimental/draft = not implemented unless explicitly requested; never auto-adopted.
- `EXT-PORT-1`: extension-specific ports are defined inside the extension package (not core) and are narrow: only what the extension needs.

### 12.1 Tasks (`io.modelcontextprotocol/tasks`)  | stage **Beta, to Core** | package `packages/ext-tasks`
- **Pin**: wiki page `W/extensions/tasks/overview.md` (`docs@de3550c9fea3`); normative spec lives in repo `modelcontextprotocol/ext-tasks` (`specification/beta/...`); that revision/commit is **UNRESOLVED** (not in wiki; Wave 0 Extensions lane pins it and reconciles). Changelog major 6 / SEP-2663 record the redesign. Because Beta may break, the pin is a hard prerequisite for any test.
- **Client contract** (from overview, wire shapes UNRESOLVED until ext-tasks is pinned): declare `extensions["io.modelcontextprotocol/tasks"] = {}` per request; any supported request (`tools/call` e.g.) may return `CreateTaskResult` with `resultType:"task"` {`taskId`, `status`, `ttl`, suggested `pollIntervalMs`} (servers may return it unsolicited); `tasks/get` polling honoring `pollIntervalMs`; statuses `working`, `input_required`, `completed`, `failed`, `cancelled` (terminal: last three); `input_required` -> `inputRequests` map fulfilled via `tasks/update {taskId, inputResponses}` (reusing 9.2 elicitation ports); `tasks/cancel` cooperative; optional `notifications/tasks` via `subscriptions/listen`; **persist task ids durably**; `tasks/list` and blocking `tasks/result` do **not** exist (removed).
- **Disposition**: Beta -> **active-optional, implement after pin** (Wave 2). Outcome mapping: `CreateTaskResult` -> `task-handle` Outcome; `TaskHandle { id, server, status(), poll(), update(), cancel(), result() }`. The Durable adapter (15.3) persists `{serverRef, taskId, createdAt, lastStatus, ttl}`.
- **Interfaces**: `TaskStore` port (`put/get/delete`), `Clock`, reuses `ElicitationPort`.
- **Acceptance** (`EXT-TASKS-*`): handle creation; polling cadence honors interval with jitter; `input_required` round trip; terminal states; cancel idempotence; lost handle after restart resumes from `TaskStore`; unsolicited task result handled; **unregistered client gets `protocol-violation`**; `tasks/get` for unknown id surfaces `jsonrpc-error`; ambiguous break during **creation** request = `uncertain-write` (the task may exist: no list method to find it, flag loudly).
- **Removal test**: remove `ext-tasks` -> `resultType:"task"` rejected, no `tasks/*` calls, core suite identical.

### 12.2 Skills over MCP (`io.modelcontextprotocol/skills`)  | stage **Beta, destination not stated** | `packages/ext-skills`
- **Pin**: `W/extensions/skills/overview.md`; repo `modelcontextprotocol/ext-skills` `specification/beta/skills.mdx` (revision UNRESOLVED); SEP-2640 (Final per the page; text not in the pinned set -> UNRESOLVED fetch).
- **Client contract**: only issue `skills/list`/`skills/get` after observing the server's declaration of the extension **and** `resources` capability; list results paginated; manifest with every file (+ size + SHA-256 digest) atomic per entry; direct lookup by URI independent of listing; `resources/read` serves files; names are labels (not unique): hosts preserve both and **never let same-name skills silently replace** each other; skills identified by manifest/entry, not by `skill://` scheme alone; optional `resources/directory/read` only if `directoryRead:true`; `SKILL.md` must begin with YAML frontmatter `name`+`description` and parent dir segment must equal name; **no prefetch** of files (not on connect, listing, etc.); integrity: restrict reads to retained manifest URIs, verify byte size + SHA-256, compare frontmatter field-by-field, never use failing content, refresh via `skills/get`; persisted approval binds to the full set of file URIs+digests, any change revokes; disk cache immutable or re-verified, excluded from filesystem-skill discovery paths, origin preserved after restart; `resources:"dynamic"` skills may be declined; limits 512 files / 16 MiB per skill (hosts must support up to). Host duties (approval, `allowed-tools`, nested skill consent) are expressed as `SkillApprovalPort`; library supplies verification and bookkeeping, **not** policy.
- **Disposition**: Beta -> active-optional (Wave 2) **library part only**: discovery, retrieval, verification, retained-entry store. Model-context loading and approval UX are host adapters (15).
- **Interfaces**: `SkillApprovalPort`, `SkillCache` (verified-bytes store with immutability contract), uses core `resources/read` + SHA-256 from platform crypto.
- **Acceptance**: manifest verification pass/fail (size, digest, frontmatter), same-name collision, URI outside manifest rejected, dynamic resources declined by default, approval revoked on file change, no prefetch (network spy), capability gating (no `skills/*` w/o declaration), paginated atomic manifests, `directoryRead` absent -> never calls directory read.
- **Removal**: skills methods vanish; `resources/*` core unaffected.

### 12.3 OAuth Client Credentials (`io.modelcontextprotocol/oauth-client-credentials`)  | **Stable** | `packages/ext-client-credentials`
- **Pin**: `W/extensions/auth/oauth-client-credentials.md` + repo `modelcontextprotocol/ext-auth` `specification/stable/` (revision UNRESOLVED; Stable revisions are immutable and keyed to core revision per SEP-3392, so pin `.../2026-07-28/`).
- **Client contract**: advertise `extensions["io.modelcontextprotocol/oauth-client-credentials"] = {}`; obtain token via `grant_type=client_credentials` with `resource` = canonical MCP server URI; two credential formats: **JWT bearer assertion (recommended)**: `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`, claims `iss`=`sub`=client id, `aud` = the AS `issuer` as the **only** value (RFC 10070 forbids token endpoint URL), `exp`, `iat`; **client secret**: `client_id`+`client_secret`; use token as `Authorization: Bearer`; handle expiry by obtaining a new token (no user, no refresh token assumed); step-up: clients acting on own behalf MAY attempt or abort (core AUTHZ).
- **Disposition**: Stable -> **active-optional implement** (Wave 2). Reuses `packages/auth` discovery, SSRF guard, issuer binding, resource param, scope selection; adds only the grant. Secrets via `CredentialStore`; JWT signing via pinned `jose` (justify in `docs/deps.md`; alternatives: WebCrypto `subtle.sign` directly for ES256/RS256 to avoid the dependency: decision in Wave 2 slice S2.3).
- **Interfaces**: `ClientCredentialsConfig {clientId, secret|signer, scopes?}`; `AssertionSigner { alg, sign(payload) }` so keys can live in HSM/host; `AuthProvider` implementation.
- **Acceptance**: grant request shape (secret and JWT), `aud` single issuer value (negative: token endpoint URL rejected by fixture AS), `resource` included, issuer binding preserved, expiry -> new token (single-flight), secret never logged, advertised only when configured, mid-flow AS change.
- **Removal**: remove -> core interactive auth fixtures unchanged.

### 12.4 Enterprise-Managed Authorization (`io.modelcontextprotocol/enterprise-managed-authorization`)  | **Stable** | `packages/ext-enterprise-auth`
- **Pin**: `W/extensions/auth/enterprise-managed-authorization.md` + `ext-auth` stable (revision UNRESOLVED; also RFC 8693 token exchange, RFC 7523 JWT bearer grant, ID-JAG draft: standards inputs).
- **Client contract**: advertise extension `{}`; user SSO to the enterprise IdP happens **in the host** (`IdentityPort` supplies the Identity Assertion: OIDC ID token or SAML assertion); when the server indicates enterprise-managed auth is required: token exchange at the **IdP** token endpoint: `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `requested_token_type=urn:ietf:params:oauth:token-type:id-jag`, `subject_token` (+type), `audience` = MCP AS issuer, optional `resource`; then redeem ID-JAG at the MCP AS token endpoint using `urn:ietf:params:oauth:grant-type:jwt-bearer`; **never redirect the user to the MCP AS authorization endpoint**; honor IdP/org scope restrictions and handle scope errors; admin-configured IdP endpoints (no per-user prompt).
- **Disposition**: Stable -> **active-optional**, seam-only in core: the library implements the two token requests and state machine; SSO UI and IdP login belong to the host `IdentityPort` (host-neutral: **no browser code here**). If no `IdentityPort`, health = `unavailable`, not advertised.
- **Interfaces**: `IdentityPort { getIdentityAssertion(ctx): Promise<{type:"id_token"|"saml2"; value:string}> }`, `EnterpriseConfig {idpIssuer, idpTokenEndpoint?}` (endpoints validated by SSRF guard).
- **Acceptance**: exact token-exchange form (fixture IdP), ID-JAG redemption form, no authorization-endpoint redirect observed, scope-restricted token -> `auth-failure/insufficient-scope` without loops, IdP failure -> typed failure, assertion never logged, advertised only with port.
- **Removal**: as above.

### 12.5 MCP Apps (`io.modelcontextprotocol/ui`)  | **Stable** | `packages/ext-apps`
- **Pin**: `W/extensions/apps/{overview,build}.md`; repo `modelcontextprotocol/ext-apps` stable spec (revision UNRESOLVED; the wiki links `apps.extensions.modelcontextprotocol.io`). The app<->host `ui/*` JSON-RPC dialect is **not** in the wiki: UNRESOLVED.
- **Client contract (protocol side only)**: advertise `extensions["io.modelcontextprotocol/ui"] = {mimeTypes:["text/html;profile=mcp-app"]}`; recognise `_meta.ui.resourceUri` (a `ui://` URI) on tool definitions; fetch the UI resource via core `resources/read` (cacheable, may be preloaded by the host; no auto-fetch by the library); surface `_meta.ui.csp` and `_meta.ui.permissions` verbatim to the host renderer; route app-originated `tools/call` through the core client under host consent; push tool results to the app is host-side.
- **Disposition**: Stable, but its substance (sandboxed iframe + postMessage bridge) is a **UI shell**, which PLAN.md bars from core. Plan: `ext-apps` implements the metadata/resource/capability contract and exposes `AppRenderPort` (host renders; contract: sandbox, CSP applied from metadata, no host-DOM access). The `ui/*` bridge is **named disposition: `deferred (spec not pinned; host-owned)`**; capability is advertised only when an `AppRenderPort` is registered and its self-test passes.
- **Acceptance**: tool metadata exposure; `ui://` resource read with correct mime type; capability omitted without renderer; app-originated call goes through `tool-call` consent; CSP/permissions passed unchanged; bad mime type rejected.
- **Removal**: tools with `_meta.ui` are still ordinary tools; `_meta` preserved.

### 12.6 Server Cards (SEP-2127; `ext-server-card`)  | **Beta, destination not stated** | `packages/ext-server-cards`
- **Pin**: `W/seps/2127-mcp-server-cards.md` (marked Final; says implementers follow the current versioned extension spec, **not** the SEP). Review snapshot: repo `modelcontextprotocol/experimental-ext-server-card` commit `526201bbc80231daa40ffcdecfc9da4e54e5dc93`; current spec in `ext-server-card` (revision UNRESOLVED). Normative details (media types, CORS, caching, canonical path `<streamable-http-url>/server-card`, AI Catalog at `/.well-known/ai-catalog.json`) are in `docs/discovery.md` there: UNRESOLVED.
- **Client contract**: HTTP discovery **before** connecting: fetch a card (static JSON: `name`, `version`, `description`, optional `title/icons/repository/websiteUrl`, `remotes[]` with URLs, headers, variable templates, supported protocol versions, namespaced `_meta`) from an explicit URL or `<url>/server-card`, optionally via an AI Catalog; **no primitives in cards**: tools/resources/prompts are always obtained at runtime; cards are advisory: verify against live `server/discover`; respect cache headers; treat as untrusted public data; HTTPS with cert validation (SSRF guard, 10.7); cards carry no credentials.
- **Disposition**: Beta -> active-optional **non-wire-critical**: provides `discoverCard(url)` returning a typed card and `connectionCandidates` filtered to versions we support (`2026-07-28`) and transports we implement (`streamable-http`); **no** automatic connection or trust. No capability advertisement (not a protocol capability).
- **Acceptance**: card parse/validate (schema from pinned `schema.json`), unsupported-version remotes filtered, card claiming tools ignored, cache headers honored, SSRF block, mismatch with `server/discover` flagged.
- **Removal**: nothing in core references cards.

### 12.7 Events (SEP-3415, `io.modelcontextprotocol/events`)  | **draft-labeled; OFF BY DEFAULT; explicit request only** | `packages/ext-events` (+ `packages/ext-events-webhook`)
- **Pins** (separate): wiki mirror `W/seps/3415-events-extension.md` at `sep-3415@4165cc2e580a` (**behind**); upstream PR head `60b15c16f2e7265ea34ac51099dc5be62f734692` (Nov. 19) is the target; incubation repo `experimental-ext-triggers-events`. The wiki table says "Status: Accepted" but PLAN.md governs: draft-labeled. Before any Events test: reconcile mirror vs PR head (2.4). Not core conformance evidence (N11).
- **Client contract** (mirror text; to be re-read at PR head): ext `{}` advertised per request (MAY); server advertises `extensions["io.modelcontextprotocol/events"] = {listChanged?}` in `server/discover`; client MUST NOT send `events/*` to a server that did not advertise it (server answers `-32601` otherwise); `events/list` (descriptors; paginated? UNRESOLVED), `notifications/events/list_changed` only if `listChanged`; every `events/*` over HTTP sets `Mcp-Name` = `params.name` (SEP-2243 encoding applies). **Three delivery modes**:
  1. **Poll**: `events/poll {name, arguments, cursor, maxAgeMs?}` -> `{events[], cursor, truncated, hasMore, nextPollMs}`; first poll with `cursor:null` bootstraps ("from now"); server holds no required state; loop at `nextPollMs` with jitter. `truncated:true` = gap, never a JSON-RPC error.
  2. **Push**: `events/stream` long-lived request (same shape as `subscriptions/listen`): first `notifications/events/active {cursor, truncated, heartbeatMs}`; then `notifications/events/event {eventId, name, timestamp, data, cursor}` tagged with `subscriptionId`; `notifications/events/heartbeat` (server MUST send; client watchdog from granted `heartbeatMs`); `notifications/events/error`/`terminated`; final empty `StreamEventsResult`; cancel by aborting stream (HTTP) / `notifications/cancelled` (stdio); reconnect with last cursor + jitter (SHOULD). Reuses stream primitives (EXT-STREAM-1).
  3. **Webhook**: `events/subscribe {name, arguments, cursor, delivery:{url (https), secret (client-supplied, required)}}` -> `{id, refreshBefore, cursor, truncated, deliveryStatus}`; TTL negotiated (maybe no expiry); client refreshes (idempotent upsert) before `refreshBefore` (also advances cursor; secret rotation = new secret in refresh); `events/unsubscribe`; server POSTs deliveries signed per **Standard Webhooks profile**: headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (`v1,<base64 HMAC-SHA256(secret, id.timestamp.rawBody)>`, possibly several space-delimited), `X-MCP-Subscription-Id`; verification handshake (`verification` control envelope with `challenge` echoed in a 2xx JSON body `{"challenge":...}`), `gap` and `terminated` envelopes; receivers reject timestamps older than 5 min, verify over raw bytes, constant-time compare.
  - Semantics: cursors opaque; absent == `null`; `eventId` dedupe; **at-least-once** only when upstream cursor is durable, duplicates and reordering possible, **no exactly-once** claim; client owns all subscription state (no server list method).
- **Isolation of webhook delivery** (PLAN.md): `packages/ext-events-webhook` is a **separate package and separate process-capable unit**: it owns the inbound listener (`ListenerPort`: bind address/port/TLS termination are host/ops decisions, **https callback URL required** by the server), signature verification, challenge echo, and writes verified events to an `EventSink` (append-only, idempotent on `eventId`, bounded). The local client runtime **never** accepts inbound connections; it reads from the sink (`EventSource` pull) or the host wires them. The poll/push modes live in `ext-events` and have no listener dependency. Webhook is enabled by a **second** explicit opt-in (`enableWebhook`) with its own risk note; absent a `ListenerPort` the mode is unavailable and `events/subscribe` is never sent. Local runtime failures never affect receiver verification and vice versa (separate fixtures and separate removal test).
- **Disposition**: draft -> **inventoried and planned, implemented only on explicit director request** (D4 in 17) as Wave 2/late; core never learns `events/*`. Open questions in the SEP (error code allocation: it requests codes in the MCP-reserved `-32020..-32099` range, e.g. `-32024 Forbidden`, which core policy says MUST NOT be emitted unless defined by the spec) are recorded as `unresolved` rows (`EXT-EVENTS-ERR-1`).
- **Acceptance** (fixtures against the synthetic events server, separate from core ones): poll bootstrap + cursor advance in quiet period; `truncated` handling for each mode; push active/event/heartbeat/terminated/gap; heartbeat watchdog; reconnect with cursor + jitter; webhook signature vectors (Standard Webhooks test vectors: raw-body HMAC, multi-signature rotation, stale timestamp rejected, tampered body rejected); challenge handshake echo; secret rotation; duplicate `eventId` discarded; `-32601` for unadvertised -> no sends; payloads treated as untrusted data (never executed/interpolated into instructions by the library; model delivery is the host's); removal test.

### 12.8 Other Experimental extensions: inventory with named disposition
Source for the list: `W/seps/3392-extension-lifecycle.md#Transition` table, `W/community/working-groups/*`, `W/community/interest-groups/tool-annotations.md`. Test: is there a pinned spec, and an independent client contract?

| Item | Source | Pinned spec in wiki? | Independent client contract? | Disposition |
|---|---|---|---|---|
| `experimental-ext-interceptors` (validators/mutators on context ops) | `W/community/working-groups/interceptors.md`; SEP-3392 table | no (WG charter only) | no (host-side hook design; WG says client hook engines are out of scope) | **not-adopted: no pinned spec** (row `EXT-EXP-INTERCEPT`); our own host hook points (8.2 `beforeCall`) are local and **not** advertised as an MCP capability |
| `experimental-ext-variants` | SEP-3392 table only | no | no | **not-adopted: unresolved, no source beyond a name**; record for Wave 0 follow-up |
| `experimental-ext-tool-annotations` (Tool Annotations IG) | `W/community/interest-groups/tool-annotations.md` | no (IG; repo link) | no | **not-adopted**; annotations stay untrusted hints (8.2) |
| `experimental-ext-triggers-events` | SEP-3415 incubation | yes (SEP-3415) | yes | see 12.7 (explicit request only) |
| `experimental-ext-server-card` / `experimental-ext-skills` | now Beta | see 12.6 / 12.2 | yes | promoted, see sections |
| Any extension found later under `specification/experimental/` of an `ext-` repo | `W/extensions/overview.md` | n/a | n/a | **no automatic adoption**; needs director approval + pin |
Each row is an inventory row in section 3 with `disposition: excluded (no pin)` or `unresolved`, so none is silently omitted.

### 12.9 Client matrix cross-check
`W/extensions/client-matrix.md` lists host support per extension; Wave 0 Extensions lane reads it to record which hosts the Pi adapters resemble (informational; not a wire reference) and confirms no extension is claimed as supported without a passing fixture.

## 13. Fixtures and synthetic server

Anchors: `PLAN.md` Modules 1 and 4; `W/community/sdk-tiers.md#Conformance testing` (the official suite is `github.com/modelcontextprotocol/conformance`; counts only target-version, non-experimental, non-legacy, non-`disputed` tests). Packages: `packages/fixtures` (data + synthetic server) and `packages/conformance` (runner, mapping, gate scripts).

### 13.1 Principles
1. **Fixtures are data, stored separately from implementation.** `packages/fixtures/exchanges/**.json` import nothing; `packages/fixtures` has no dependency on any implementation package (4.3). A fixture can be run against any client that exposes the harness adapter (so the same files could test another implementation).
2. Every fixture names the **requirement IDs** it proves, the **source anchor** (`page#heading`, plus `pin`), and what makes it red (the negative assertion). A fixture whose requirement is `unresolved` is not allowed (2.4 step 7).
3. A fixture must be shown **red against a deliberately wrong behavior** before it counts (`wf-tdd` red-green): each fixture ships `mutants` (a named list of synthetic-server or client-hook mutations it must fail under), checked by the runner `--mutate` mode (13.5).
4. The synthetic server is a **test fixture, not a shipped server or proxy** (PLAN.md Scope): no `bin`, `private`, not exported from any published entry point, behavior driven only by exchange scripts.

### 13.2 Scripted exchange format (`*.exchange.json`)
```jsonc
{
  "id": "http/stream-break-write-uncertain",          // path-like unique id
  "requirements": ["HTTP-RETRY-1", "HTTP-AMBIG-1", "HTTP-AMBIG-2"],
  "pin": "tag",                                        // tag | wiki | sep-pr-head | ext-page
  "source": ["S/basic/transports/streamable-http.md#Receiving Messages", "S/changelog.md#Major changes"],
  "tier": "B",                                         // A = in-memory scripted transport, B = real transport (child process / loopback HTTP)
  "binding": "http",                                   // stdio | http | any
  "server": {                                          // declarative synthetic-server profile
    "capabilities": { "tools": {} },
    "tools": [{ "name": "create_item", "inputSchema": { "type": "object" } }],
    "era": "modern"                                    // modern | legacy-silent | legacy-error | noisy
  },
  "client": { "setup": { "timeoutMs": 2000, "auth": null }, "clock": "fake" },
  "script": [
    { "do": "call", "as": "c1", "method": "tools/call", "params": { "name": "create_item", "arguments": { "n": 1 } } },
    { "expect": "wire", "match": { "method": "tools/call", "params._meta.io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      "headers": { "mcp-method": "tools/call", "mcp-name": "create_item" }, "capture": { "id": "$id1" } },
    { "server": "sse-open" },
    { "server": "sse-event", "message": { "jsonrpc": "2.0", "method": "notifications/progress", "params": { "progressToken": "$tok1", "progress": 1 } } },
    { "fault": "http.break-stream", "after": "events:1" },
    { "advance": 0 }
  ],
  "expect": {
    "outcome": { "c1": { "kind": "uncertain-write", "uncertain.evidence": "stream-broken", "uncertain.binding": "http" } },
    "wire": { "count": { "tools/call": 1 }, "never": ["Last-Event-ID", "Mcp-Session-Id", "GET", "DELETE"] },
    "diagnostics": []
  },
  "mutants": ["client-auto-retries-write", "client-sends-last-event-id"]
}
```
- **Steps**: `call` (client API call, async handle), `expect wire` (assert next/any outbound message, header and body matchers; JSON-pointer-like paths; `$var` capture/substitute; `ignore` list for volatile fields), `server` (reply: `result`, `error`, `sse-*`, `notification`, `raw` bytes), `fault` (transport faults, below), `advance` (fake clock ms), `abort` (call the handle's `AbortSignal`), `restart` (stdio process restart), `auth` (synthetic AS/PRM actions).
- **Faults**: stdio: `exit(code|signal)`, `eof`, `truncate-line(n bytes)`, `noise-line(text)`, `split-chunks(sizes[])`, `stderr(text)`, `ignore-stdin-close`, `delay(ms)`; HTTP: `status(n)`, `header(k,v)`, `break-stream(after bytes|events)`, `reset`, `truncate-json`, `slow-body`, `redirect(location)`, `content-type(x)`, `dns(addr)` (for SSRF tests, via injected resolver).
- **Matching** is structural and order-aware (`ordered: true` default for the per-request message sequence, `any-order` for concurrent scripts). **Never** compares serialized strings of full messages except where bytes matter (`raw`, `requestState` echo, base64 vectors).
- **Assertions on outcome** use the `Outcome` kinds (4.4) and the harness adapter's JSON view (`toJSON`) so other implementations can adapt.
- **Time** is fake by default (tier A and B: the harness injects `Clock`); real-time only for fixtures tagged `realtime` (shutdown escalation).

### 13.3 Synthetic server
`packages/fixtures/server/` with three drivers sharing one script interpreter:
- `inproc.ts`: implements `Transport` for tier A (no sockets), driven by the interpreter; fastest, used for all protocol-logic fixtures.
- `stdio-main.ts`: a Node script spawned by tier B stdio fixtures; reads exchange script path from argv; speaks newline-delimited JSON; logs raw stdin to a side file for "client wrote only valid MCP" assertions and signals received (shutdown escalation).
- `http-main.ts`: loopback HTTP server (random port) with routes for the MCP endpoint, PRM, AS metadata, authorization/token endpoints (synthetic AS), CIMD document, and a **network spy** that records every inbound request (used by "no prefetch", "no network `$ref`", "no DCR" assertions).
- Server **eras** for negative paths: `legacy-silent` (never answers discover), `legacy-error` (-32601/-32602 for unknown methods, answers `initialize`: the test asserts it **never** receives `initialize`), `noisy` (non-JSON on stdout).
- Server-side validation behaviors the spec requires of servers (Origin, header-vs-body validation, `-32020`) are implemented in the synthetic server as **test behavior only** and flagged `out-of-scope (server role)` in the matrix.

### 13.4 Requirement ID -> fixture mapping
- Canonical form of rows: the Wave 0 `docs/conformance/*.md` tables (section 3 format). Wave 1 slice S1.0 adds `packages/conformance/requirements.json` (generated by `npm run req:build` from the markdown tables; the markdown stays canonical, the JSON is derived and checked in).
- Each fixture lists `requirements[]`; `npm run check:coverage` fails if: (a) a row with disposition `required|active-optional|conditional` and status `implemented` has **no passing fixture**; (b) a fixture references an unknown ID; (c) a row has a disposition but its `acceptance check` field is empty; (d) a fixture's requirement has disposition `unresolved`. Output: `reports/coverage-matrix.md` (row x fixture x result x tier x official-runner scenario).
- A row may be satisfied by **review/doc/lint checks** (e.g., `VER-6`): these are registered as `checks/<id>.ts` scripts with the same pass/fail contract so the matrix stays complete.
- The mapping to official scenarios is a third column: `official: <scenario-id | none>`.

### 13.5 Runner design (`packages/conformance/src/run.ts`)
- CLI: `conformance run [--tier A|B] [--area wire|ops|auth|ext:<id>] [--id <fixture>] [--mutate] [--json] [--seed n]`. Exit non-zero on any failure.
- Harness adapter contract (`HarnessAdapter`): `create(setup) -> {client, transportFactory}`, `call(method, params, opts) -> Handle`, `abort(handle)`, `outcomeJson(handle)`, `clock.advance(ms)`. One adapter ships for this library; the interface is deliberately implementation-neutral.
- Determinism: seeded `Random`, fake `Clock`, ephemeral ports, per-fixture temp dirs, no network access beyond loopback (enforced with a spy + egress block in tier B).
- `--mutate`: for every fixture it applies each named mutant (adapter-level fault injections such as "retry writes", "send Last-Event-ID", "echo modified requestState", "share cache across auth", "log token") and asserts the fixture fails; a fixture that still passes under its mutant is reported as **vacuous** and fails the gate.
- Property/fuzz layer (`fast-check`, seeded): SSE parser chunk-boundary invariance; stdio line splitter invariance; base64 header encoding round-trip; pagination loop guard; id uniqueness.
- Reports are written under `reports/` (git-ignored) in Markdown + JSON.

### 13.6 Official conformance runner as a black box
- Repository: `github.com/modelcontextprotocol/conformance` (named in `W/community/sdk-tiers.md`). Package name, CLI shape, and which scenarios target **clients** and **2026-07-28**: UNRESOLVED; Wave 0 Wire lane records them from the repo's README/release notes (not its source) and pins a version/commit.
- Integration: `packages/conformance/src/official.ts` launches the runner as a subprocess against a thin **client-under-test entrypoint** (`packages/conformance/cut/main.ts`, written from the runner's documented CLI contract), captures its result JSON, and maps scenario ids to requirement ids in `official-map.json`. The runner's code is never imported or read for design.
- Counting rules follow `sdk-tiers.md`: only target-version, non-experimental, non-legacy, non-`disputed` scenarios are claims; **Events/extension scenarios never count as core conformance** (PLAN.md).
- Where no official scenario covers a clause, the spec-derived fixture is the evidence and the matrix says `official: none` (not hidden).

### 13.7 Known coverage gaps (to be tracked in `reports/gaps.md`)
- Clauses with no official scenario (expected: client-side SSE comment handling, `x-mcp-header` rejection paths, MRTR echo edge cases, cache scope separation, SSRF handling, step-up limits): spec-derived fixtures only.
- Server-role clauses: out-of-scope (explicit rows).
- UNRESOLVED upstream pins (Tasks, Skills, Apps, Server Cards, Events) block their fixtures; their rows stay `unresolved-pending-pin` and appear in the gate as **non-claims**.
- Real-network behavior (corporate proxies buffering SSE, HTTP/2 stream resets) is not reproducible in loopback tests: recorded as residual risk (17).
- OAuth with real IdPs (browser UX) is covered only through synthetic AS + scripted `BrowserPort`/`RedirectPort`.

### 13.8 Requirement rows
`FIX-1` (fixtures reference real IDs; `check:coverage`), `FIX-2` (every fixture has mutants and fails under them), `FIX-3` (fixtures package imports no implementation), `FIX-4` (synthetic server not exported/published), `FIX-5` (official runner executed as subprocess only; map file complete).

## 14. Spec gate

Anchors: `PLAN.md` Modules 4 ("Spec gate"). The gate is a **scripted, repeatable procedure** (`npm run gate`) that produces a signed-off-by-the-director report; it is the only door to Wave 3.

### 14.1 Entry criteria (all must hold before `npm run gate` is attempted)
1. Waves 0-2 slices landed (16): every row in section 3 has a **disposition**; no row is blank; `unresolved` rows are listed with owner and decision needed.
2. Director has recorded decisions D1-D10 (17) or marked the dependent rows `non-claim`.
3. `docs/conformance/PINS.md` and `RECONCILIATION.md` are complete for every `required`/`active-optional` row (2.4 step 7).
4. `npm ci` clean on a fresh checkout; lockfile unchanged; `check:deps`, `check:forbidden`, `check:deps-doc` pass (ARCH-DEP-*).
5. All unit and tier A/B fixtures pass locally (`conformance run`), and `--mutate` reports **zero vacuous fixtures**.
6. Official runner pinned (13.6) and runnable offline from a cached checkout.

### 14.2 Fresh-process isolation ("no Pi packages")
- The gate runs in a **new container/VM or at minimum a fresh process tree** with: a clean temp `HOME`, an empty `XDG_*`, no `PI_*` environment variables, `NODE_PATH` unset, and a `node_modules` tree created by `npm ci --omit=dev --workspace packages/*` that contains **no** Pi packages (checked by `scripts/assert-no-pi.mjs`: scans `package-lock.json` and `node_modules/**/package.json` against `deny-pi.json`; then at runtime installs a `module.register` loader hook that **throws on resolution** of any denied specifier). The gate fails if the hook ever triggers or any adapter code is loaded.
- Process starts from the built output (`dist/`) of `packages/*`, not from TS sources via a Pi-aware loader.
- Network: loopback only (egress block for tier B).
- Evidence captured: Node version, OS, commit SHA, lockfile hash, pin table (PINS.md hash), command lines, start/end times.

### 14.3 Required scenarios (each a named gate suite; every one has fixtures from sections 5-12)
| # | Scenario | What is exercised | Pass condition | Fixtures (representative) |
|---|---|---|---|---|
| G1 | **Simultaneous requests** | N=64 concurrent requests per binding: mixed reads/writes, out-of-order responses, one slow, interleaved progress/listen notifications | each settles with its own result; no cross-talk; in-flight limit queues rather than drops; listener notifications stay demuxed | `stdio/concurrent-out-of-order`, `sub/two-listeners-demux`, `edge/EDGE-1` |
| G2 | **Cancellation and closure** | cancel before send, mid-flight, after response, during MRTR consent, during auth wait; client close with in-flight writes; stdio shutdown escalation; HTTP abort | per-binding behavior (notification vs stream close); writes with no observed response -> `uncertain-write`; no leaked processes/sockets/timers (resource-leak check) | `wire/cancel-*`, `http/abort-closes-stream`, `stdio/shutdown-escalation`, `mrtr/cancel-during-consent`, `arch/close-settles-all` |
| G3 | **Permissions and consent** | auth consent, URL elicitation consent, form elicitation, tool-call hook, missing ports | missing port => deny/unavailable; decline vs cancel distinct; URL not fetched/opened without consent; full URL shown | `consent/*`, `elic/*` |
| G4 | **Auth continuity** | token expiry mid-session, refresh, concurrent 401 single flight, step-up, AS change, configured bearer, secrets never logged, SSRF | one refresh for N waiters; no token forwarded cross-origin/query; issuer/PKCE/resource/iss rules enforced; scopes unioned | `auth/*` |
| G5 | **Cache separation** | public/private partitioning across two auth contexts and two servers, pagination per page, invalidation by notification, MRTR retries uncached, cursor purge | no private entry served to another context; cursor/URI in key; default config never shares public across auth | `cache/*` |
| G6 | **Subscriptions** | ack-first, subset ack, filter enforcement, concurrent listeners, graceful vs abrupt end, stdio restart re-send, HTTP reconnect + cache invalidation | state machine matches 9.3; no resume attempted (`Last-Event-ID` never sent) | `sub/*` |
| G7 | **Partial transport failure** | stdio crash mid-write/mid-line; HTTP stream break mid-response, 5xx after write, truncated JSON, connect failure; read retry vs write non-retry | reads re-issued with new ids only by policy; writes never silently duplicated (server-side counter of executed side effects == 1 after failure unless caller explicitly set `acceptDuplicate`); `uncertain-write` surfaced with evidence | `stdio/crash-*`, `http/stream-break-*`, `http/5xx-write-uncertain` |
| G8 | **Result/error shapes** | every `Outcome` kind produced by a distinct real wire situation: ok, jsonrpc-error (each code incl. -32020/21/22, legacy -32002), tool-isError, mrtr-interim, protocol-violation (unknown resultType), transport-failure, uncertain-write, capability-absent; `structuredContent` any JSON; absent `resultType` | kinds never overlap (type-level exhaustive switch test + runtime table); local errors never JSON-RPC-shaped | `ops/*`, `wire/resulttype-*`, `edge/*` |
| G9 | **Version/legacy diagnostics** | legacy server on stdio/HTTP; unsupported-version retry; no `initialize` ever sent | actionable diagnostic fields present; zero `initialize` bytes observed | `ver/*`, `stdio/legacy-peer-diagnostic`, `http/400-modern-error-vs-legacy` |
| G10 | **Extension independence** | each implemented extension's removal job; capability advertisement only with working ports; unregistered client vs extension result types | core fixture transcripts byte-identical with/without each extension | `remove:*`, `ext/*/negative` |
| G11 | **Isolation and hygiene** | no Pi packages (14.2); no network beyond loopback; no secrets in logs; no deprecated feature on the wire (roots/sampling/logging/DCR/HTTP+SSE/session/resume) | wire-scan over all recorded transcripts finds none of the forbidden constructs | `scripts/wire-scan.mjs` |
| G12 | **Official runner** | black-box official scenarios applicable to 2026-07-28 client (13.6) | all applicable, non-disputed scenarios pass; failures are listed per scenario id | `official.ts` |

### 14.4 Exit criteria and release-claim rule
- **Row rule (PLAN.md)**: *every* row in section 3 has a disposition, and *every implemented row has a passing check* (fixture, property test, lint/doc check, or official scenario) recorded in `reports/coverage-matrix.md` for the gate run's commit SHA.
- Dispositions count: `required` + `active-optional(implemented)` -> must pass; `conditional` -> pass in the configuration where the condition holds, otherwise recorded `n/a (condition false)` with the condition stated; `deprecated`/`excluded` -> pass = the **negative** fixture/wire-scan proves absence; `unresolved` -> allowed only as an explicit **non-claim** listed in the report; `out-of-scope (server role)` -> listed, no check.
- **What may be claimed**: "client-side MCP 2026-07-28 core, as of pins `<table>`, conformance evidence: `<n>` spec-derived fixtures + `<m>` official scenarios; clauses without official scenario: `<list>`." Extensions: each claimed separately with its own pin and stage label; **Beta/draft extension evidence is not core conformance evidence**; Events (draft) is never part of a core claim.
- **Not claimable**: interoperability with legacy servers (explicitly unsupported, diagnostic only); exactly-once side effects (never); server-role requirements; extensions with unresolved pins.
- Gate output: `reports/gate-<sha>.md` + `.json` (matrix, evidence block, non-claims, residual risks). **Gate passes only if** all G1-G12 pass and zero vacuous fixtures and no `required` row lacks a pass. The director reviews the report; passing the script is necessary, not sufficient, for starting Wave 3.
- **Regression rule**: any change to `packages/*` after the gate invalidates the gate for the changed packages; Wave 3 pins the gated commit SHA.

### 14.5 Requirement rows
`GATE-1` (fresh process, no Pi, loader hook never fires), `GATE-2` (matrix complete: disposition for every row), `GATE-3` (every implemented row passes), `GATE-4` (wire-scan: no forbidden constructs), `GATE-5` (official runner subprocess result recorded), `GATE-6` (non-claims enumerated), `GATE-7` (claim text generated from the matrix, not hand-written).

## 15. Pi adapters (Wave 3, after the gate)

Wave 3 starts **only after the spec gate (14)**. Sources read for integration surfaces only (N2): `~/pi/packages/mcp/README.md`, `~/Projects/pi-mcp-ext/README.md`, and greps of their `src/`. **They are not wire references**: no behavior in sections 5-12 comes from them, and adapters never import `@earendil-works/pi-mcp` or `@jangmanj/pi-mcp-ext` for protocol work. Paths below are relative to `~/pi/packages` (fork checkout, branch `next`, HEAD `7d80b45f6`, matching the installed build `next-7d80b45f62f8`; `e903c27bb` is a divergent line, see 2.1, D3) and `~/Projects/pi-mcp-ext/src`.

### 15.1 Observed integration surfaces (file:line, at the observed HEAD)
| Surface | Observation | Where |
|---|---|---|
| Built-in MCP extension is **replaceable** | `{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true }`; "an extension that registers `codemode`, `tool_search`, or `/mcp` ... takes over instead of running alongside" | `coding-agent/src/extensions/index.ts:9-14` |
| Built-ins can be disabled by setting `-builtin:mcp` or CLI `--no-mcp` | extension setting override; `disabledBuiltinExtensions: parsed.noMcp ? ["mcp"]` | `coding-agent/src/core/package-manager.ts:1075`, `coding-agent/src/main.ts:852` |
| **Standalone `pi mcp`** is a CLI path outside the extension API | `if (args[0] === "mcp") { ... runMcpCommand ... }` before arg parsing | `coding-agent/src/main.ts:659-663`; implementation `coding-agent/src/extensions/mcp/cli.ts`, `cli.lazy.ts` |
| Tool registration | `pi.registerTool(definition)`; hidden re-registration `{...definition, exposure:"hidden"}` for removed tools; resource tools registered once | `coding-agent/src/extensions/mcp/index.ts:442, 449, 458, 486`; pi-mcp-ext `index.ts:785, 925, 1038, 1129, 1228` |
| Exposure modes (`direct`, `codemode`, `deferred` via `tool_search`) | doc comment: `deferred` tools are not declared until `tool_search` loads them | `coding-agent/src/core/mcp-servers.ts:55-60`; `coding-agent/src/extensions/mcp/index.ts:8-14, 120` |
| `reachesTools` | a tool that reaches other tools waits for the servers it may reach before running; `tool_call` hook | `coding-agent/src/extensions/mcp/index.ts:222, 509-512, 1184-1197` |
| `tool_search` | activates when `deferred` servers exist; message when neither codemode nor tool_search is active | `coding-agent/src/extensions/mcp/index.ts:495-531` |
| `/mcp` command | `pi.registerCommand("mcp", ...)` (manager view, sign-in); pi-mcp-ext registers `/mcp-prompt` | `coding-agent/src/extensions/mcp/index.ts:1258`; pi-mcp-ext `index.ts:640, 679` |
| Native resource tools/aliases | `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`; server namespace `mcp__<server>__<tool>` with `aliases:[server]` | `coding-agent/src/core/mcp-servers.ts:36-49`; `coding-agent/src/extensions/mcp/index.ts:385-394` |
| Names | provider limit 64 chars `[A-Za-z0-9_-]` (README); renderer regex `^mcp__(.+?)__(.+)$` | `mcp/README.md` (Tools for an LLM), `coding-agent/src/extensions/mcp/index.ts:379-382` |
| Permission/hook pipeline | "Every call runs through pi's tool pipeline, so `tool_call`/`tool_result` hooks and permission ..." | `coding-agent/src/extensions/mcp/index.ts:20, 1189` |
| Cancel lifecycle | per-session `AbortController` aborted on `session_shutdown`; late results dropped; sign-in cancelable via `AbortSignal.any` | `coding-agent/src/extensions/mcp/index.ts:309-316, 673-696, 1250-1251` |
| Resume/branch/fork | resumed sessions render MCP calls before their server connects; pi-mcp-ext persists cursors/approvals via `appendEntry` and `restoreBranch(branch, allEntries)` | `coding-agent/src/extensions/mcp/index.ts:379`; pi-mcp-ext `session.ts:109-110, 324-326, 975-979` |
| Codemode result channel | MCP tool results: bounded text for the model (text > 20 KB middle-cut, full text to temp file); codemode scripts receive the whole `CallToolResult` (raw `content`, `structuredContent`, `isError`), never truncated | `coding-agent/src/extensions/mcp/tools.ts:1-12`; `coding-agent/src/core/agent-session.ts:482-490` (allowlist/`mcp__*` filtering) |
| Durable tool contract | a call's intent is committed before `execute()`; after a crash the tool reruns **only if declared `replay: "safe"`**, otherwise the model gets an `interrupted` error result; nested calls (`api.executeTool`) are durable tasks keyed by position or `{key}` | `durable/README.md:336, 368-387`; resume `durable/README.md:127`; crash loops `durable/README.md:265` |
| pi-mcp-ext also implements several extensions on top of Pi | `mcp_events`, `mcp_tasks`, `mcp_skills`, ... | `Projects/pi-mcp-ext/README.md` (Tools): shows which host features users already expect, **not** a spec for them |

UNRESOLVED (verify when Wave 3 starts, against the pinned fork revision): exact extension API names/types (`ToolDefinition.exposure`, `reachesTools` signature, `registerToolRenderer`), how a replacement extension declares it replaces `builtin:mcp`, whether `pi mcp` can be served by an extension at all, and the durable `ToolTask` lifecycle hooks an MCP bridge needs.

### 15.2 Coding Agent adapter (`adapters/pi-coding-agent`)
**Allowed to import**: Pi extension API and the gated `packages/*` (built output). **Owns** (PLAN.md Modules 5):
1. **Session registration**: create one `McpClient` per configured server at `session_start`, close at `session_shutdown`; per-session `AbortController` bridging to request `AbortSignal`s; late results dropped after abort.
2. **`/mcp`**: server list/status, enable/disable, sign-in (uses `packages/auth` with Pi's `BrowserPort`/`ConsentPort`/loopback `RedirectPort`), no protocol logic.
3. **Trust and exposure**: per-server `exposure` modes, trust flags (`ServerTrust` for annotations, 8.2), project-vs-global config trust (a project file must not silently enable a server that can spawn commands or send credentials).
4. **Native resource aliases and names**: map tools to `mcp__<server>__<tool>` within the 64-char provider limit with deterministic collision-safe truncation (hash suffix); resource tools; `aliases`.
5. **`tool_search` / `reachesTools`**: deferred exposure, waiting for server readiness before a reaching tool runs (adapter concern; library offers `client.ready()`).
6. **Result handling**: the library returns raw complete `Outcome`; the adapter derives **(a)** bounded model output (truncate with temp-file spill, images, resource links, `isError` as error result) and **(b)** the **raw structured result for codemode** (full `CallToolResult`, never truncated). `uncertain-write`, `transport-failure`, `mrtr-interim` etc. get distinct model-visible renderings; `uncertain-write` is told to the model **explicitly** ("may or may not have run; do not retry blindly").
7. **Nested permission/cancel lifecycle**: MCP calls from codemode run inside Pi's tool pipeline so permission hooks apply to nested calls; aborting the parent aborts nested requests; consent prompts (elicitation, URL, auth) are routed through Pi UI/`ConsentPort` and are cancellable.
8. **Branch/fork/resume**: persist only **data** (cursors, approvals, task ids, `requestState` of manual MRTR) in session entries (`appendEntry`-style); on resume re-create clients lazily and re-establish subscriptions; never persist tokens in session entries (use `CredentialStore`).
9. **Reuse the host's codemode sandbox, not its MCP implementation**: the adapter exposes MCP tools to the existing codemode runtime; it does not embed or call `@earendil-works/pi-mcp`.
10. **Migration/rollback** (15.5).
**Requirement rows**: `PICA-1..12`, one per item above plus: `PICA-13` (no Pi import in `packages/*`, re-checked), `PICA-14` (adapter acceptance run against a **pinned fork revision**, recorded).
**Acceptance** (Wave 3 slice S3.1): (a) contract tests against a fake Pi extension host built from the extension API types (no live Pi needed for CI); (b) a manual/scripted run in a **scratch Pi config directory** (never the active config) with the pinned fork build against the synthetic server: tool registration, `/mcp`, exposure modes, deferred search, branch/fork/resume, abort mid-call, `uncertain-write` rendering, URL elicitation consent; (c) removal check: adapter disabled -> Pi falls back to its built-in without residue.

### 15.3 Durable adapter (`adapters/pi-durable`)  (separate from 15.2)
Target: `durable/` tool/extension contracts (`defineExtension`, tool tasks, nested `api.executeTool`). Verified behaviors (each a Wave 3 acceptance test with the pinned durable revision):
| Property | Rule | Row |
|---|---|---|
| **Commit before wake** | an MCP call's intent (server ref, method, name, args digest, request id, attempt) is committed to durable storage **before** the request is sent; any host-visible effect (tool result, wake-up) occurs after the outcome is committed | `PICD-1` |
| **Replay of completed results** | after crash/reopen, a call whose outcome was committed is **answered from storage** and not re-sent; replay returns the same `Outcome` (including `uncertain-write` and `tool-isError`) | `PICD-2` |
| **Interruption with unresolved external side effects** | intent committed, outcome not committed => on reopen the call is treated as `uncertain-write` (`evidence: "host-restart"`), surfaced as the durable `interrupted` result; MCP `tools/call` is **never** declared `replay: "safe"` by default; only operations on the read-only list (6.5) may be `replay: "safe"`; an operator override is explicit per tool | `PICD-3` |
| **Persisted remote handles** | Tasks `taskId`s (+ server ref, ttl), manual-MRTR `requestState`/`inputRequests`, subscription descriptors are persisted as data and resumed: tasks via `tasks/get`, MRTR via a **new** retry request (new id), subscriptions by re-sending listen (no resume) | `PICD-4` |
| **Replay cursors** | Events cursors (if Events enabled) persisted per subscription; advanced only after the events are committed to the conversation (at-least-once; dedupe by `eventId`) | `PICD-5` |
| **No exactly-once claim** | docs and API never claim exactly-once; local checkpoints cannot prove remote effects; any `PICD` test asserts duplicates are possible only through explicit `acceptDuplicate` or when the remote itself is non-idempotent | `PICD-6` |
| Idempotency keys | the adapter MAY inject a host-chosen idempotency argument for tools that declare one in their schema (opt-in per tool, never automatic) | `PICD-7` |
| Crash-loop interplay | durable `restart_limit` semantics respected; MCP requests are not re-sent in tight loops | `PICD-8` |
| Nested calls from code mode | keys stable by position; MCP nested calls follow the same commit rules | `PICD-9` |

### 15.4 Standalone `pi mcp` cutover decision
- **Facts**: `pi mcp ...` (`main.ts:659`) is dispatched before extension loading, so a Pi extension cannot replace it; it currently runs the built-in `runMcpCommand` backed by `@earendil-works/pi-mcp`.
- **Options**: (A) leave `pi mcp` on the old implementation (two stacks coexist; documented); (B) re-point `pi mcp` to the new library via a fork change (violates "No changes to the fork ... before this gate and an explicit cutover plan" unless approved); (C) ship a separate bin from the new library (`adapters/pi-coding-agent/bin/mcp-cli`) used by users instead.
- **Plan decision (default)**: **A for the first adapter release**, with (C) as an optional, explicitly named tool; (B) only as a later, separate cutover with its own plan and approval. Rationale: PLAN.md says treat standalone `pi mcp` as a separate cutover **only if an extension cannot replace it**; here it cannot, so it is a distinct cutover decision (D7) and does not block the extension adapter.

### 15.5 Cutover and rollback (applies to 15.2/15.3 once the director authorizes; nothing in Waves 0-2 changes Pi)
1. **Pre-conditions**: gate report for commit SHA X; adapter acceptance run recorded against the pinned fork revision; backup of the active Pi config and extension dirs (copy, with checksums) written outside the repo.
2. **Side-by-side trial**: install adapter into a **scratch** Pi agent directory; run both stacks' tool names in parallel is not allowed (name clash `mcp__*`): trial uses `-builtin:mcp` in the scratch settings only.
3. **Cutover**: enable adapter in the active config with `-builtin:mcp` (mechanism at `package-manager.ts:1075`), one server first, then the rest; keep old `mcp.json` untouched (the adapter reads the same shape read-only; schema-compat table in Wave 3 docs).
4. **Rollback**: remove adapter entry and `-builtin:mcp` from settings (single edit); old `mcp-auth.json` untouched (adapter uses its own credential store file) so sign-ins survive; session entries written by the adapter are namespaced and ignored by the old stack.
5. **Observation window and abort criteria**: any `uncertain-write` rendering bug, credential leak in logs, or unbounded memory growth -> rollback.
6. **No changes** to the Pi fork source, the active config, or `pi-mcp-ext` by this project before the cutover plan is approved.

## 16. Waves and slices

Anchors: `PLAN.md` "Modules and order" and "Work assignment". Rule for every slice: **exact allowed paths** (a slice may not touch anything else; shared files change only through the director), **check command must pass on the slice branch**, **hidden checks** may be added by the director (`wf-slice` style) but the listed commands are the minimum. Slices run in separate worktrees/branches; merges are sequential by the director. No slice deploys, publishes, or creates a remote repository.

### 16.1 Wave 0: documentation and conformance design (parallel, four lanes + director)
Output location `docs/conformance/`; each lane owns **one** file, no shared edits. **Row format** (Markdown table, one row per requirement; header exactly this so `scripts/check-conformance-docs.mjs` can parse it):

`| ID | Anchor (page#heading) | Role | Strength | Condition | Default | Disposition | Acceptance check | Open question |`

- `Role` in `C|S|B|host`; `Strength` in `MUST|MUST NOT|SHOULD|SHOULD NOT|MAY|derived|n/a`; `Disposition` in `required|active-optional|conditional|deprecated|excluded|unresolved|out-of-scope`; `Acceptance check` names a fixture id, unit test, lint/doc check, or official scenario (exactly one observable); `Open question` empty or a question id `Q<n>` registered in the director's decisions log.
- Rows seeded from section 3 and sections 5-12 of this plan; lanes re-read each anchor at the **tag** (2.4) and amend; added/removed rows are listed in a lane changelog at the bottom of its file.

| Lane | File (sole allowed path) | Row-ID families owned | Inputs | Definition of done |
|---|---|---|---|---|
| Wire | `docs/conformance/wire.md` | `WIRE-*`, `VER-*`, `STDIO-*`, `HTTP-*`, `PROG-*`, `TEL-*`, `ERR-*`, `LIM-*`, `EDGE-*`, `API-*` | sections 5, 6, 7, 11; `S/basic/**`, `S/server/discover.md` (version fields), `W/seps/2243`, `W/seps/414` | every row above present with disposition; OTel semconv page pinned (11.1); `-32601`/`-32602` data shapes resolved from tag `schema.json`; open questions registered |
| Operations | `docs/conformance/operations.md` | `OPS-*`, `PAGE-*`, `DISC-*`, `MRTR-*`, `ELIC-*`, `SUB-*`, `CACHE-*`, `DEP-*` | sections 8, 9; `S/server/**`, `S/client/elicitation.md`, `S/basic/patterns/{mrtr,subscriptions}.md`, `W/seps/{2106,2164,2549}` | rows complete; ELIC-FORM-2 decision question raised; resource template/list-changed mapping resolved; schema bounds proposal (OPS-SCHEMA-6) recorded |
| Authorization | `docs/conformance/authorization.md` | `AUTH-*`, `CONSENT-*`, `EXT-cc-*`, `EXT-ema-*` (auth extension seams) | section 10 + 12.3-12.4; `S/basic/authorization/**`, `W/docs/.../security_best_practices.md`, `W/extensions/auth/**` | rows complete; `ext-auth` stable revision pinned or flagged; AUTH-PRM-3 verified against RFC 9728; D5, D6 questions raised |
| Extensions | `docs/conformance/extensions.md` | `EXT-REG\|CAP\|REV\|RES\|STREAM\|REMOVE\|PIN\|STAGE\|PORT-*`, `EXT-tasks-*`, `EXT-skills-*`, `EXT-apps-*`, `EXT-card-*`, `EXT-events-*`, `EXT-EXP-*` | section 12; `W/extensions/**`, `W/seps/{2127,3392,3415}` | per-extension pin (repo+commit) recorded or marked `unresolved-pending-pin`; **SEP-3415**: wiki mirror `4165cc2e580a` vs PR head `60b15c16f2e7265ea34ac51099dc5be62f734692` diff summarised; three delivery modes with rows; fallback rows; inventory of other Experimental items with named disposition |
| Director (not a lane) | `docs/conformance/{PINS,RECONCILIATION,DECISIONS}.md`, merged `requirements.md` | `ARCH-*`, `FIX-*`, `GATE-*`, `PICA/PICD/CUT-*` | sections 2, 4, 13-15, 17 | shared decisions D1-D10 recorded; conflicts across lanes reconciled; **implementation does not start before this** |

**Lane check command** (per lane, run from repo root; the `scripts/` files are produced by the director before lanes start, otherwise use the inline fallback):
`node scripts/check-conformance-docs.mjs docs/conformance/<lane>.md` (fallback: `test -s <file> && grep -c '^| [A-Z]' <file>` and `grep -qi 'UNRESOLVED\|^| .*| unresolved |' <file> || true`). Pass = parses, all IDs unique, dispositions in the allowed set, no blank acceptance-check cell except for `deprecated|excluded|out-of-scope` rows (which name a negative check), every anchor `page#heading` exists in the wiki file (script resolves against `~/vaults/JangsWiki/Wiki/mcp`, path configurable by `WIKI_ROOT`).

### 16.2 Wave 1: shared interface and fixture runner, then four independent slices
**S1.0 (serial, single owner; blocks the others)**: repo scaffolding + frozen shared interface + fixture runner.
- Lane: Contracts and fixtures. **Allowed paths**: `package.json`, `package-lock.json`, `tsconfig*.json`, `.gitignore`, `.dependency-cruiser.cjs`, `vitest.config.ts`, `packages/core/**`, `packages/fixtures/**`, `packages/conformance/**`, `scripts/**`, `docs/deps.md`.
- Inputs: sections 4, 11.2, 13; director-merged `docs/conformance/*`.
- Outputs: workspace skeleton; `core/src/{jsonrpc,outcome,request,ports,extension,telemetry,auth-types}.ts` implementing the 4.4 interfaces (request table, timeouts, cancel plumbing, in-proc `Transport`, **minimal** `metaInjector`); generated schema types; `fixtures` exchange schema + `inproc.ts` interpreter + loader; `conformance run` (tier A) + `--mutate` + `check:coverage` + `check:deps` + `check:forbidden` + `check:deps-doc`; five smoke fixtures covering: id uniqueness, `resultType` absent, `-32022` retry, cancel-before-send, concurrent out-of-order.
- Deps: Wave 0 complete. **Acceptance**: `npm ci && npm run build && npm test -w packages/core && npx conformance run --tier A --id 'smoke/*' && npx conformance run --mutate --id 'smoke/*' && npm run check:deps && npm run check:forbidden`.
- DoD: interfaces tagged **frozen** in `packages/core/INTERFACES.md` (any later change goes through the director); smoke fixtures green and red under mutants; no Pi/SDK in lockfile.

**Then four independent slices (parallel; each depends only on S1.0)**

| Slice | Lane | Exact allowed paths | Inputs | Outputs | Acceptance commands | Definition of done |
|---|---|---|---|---|---|---|
| **S1.1 Wire/lifecycle** | wire | `packages/core/src/{lifecycle,cancel,progress}.ts`, `packages/core/test/{lifecycle,cancel,progress}/**`, `packages/fixtures/exchanges/{wire,ver,prog}/**` | `docs/conformance/wire.md` rows WIRE-*, VER-*, PROG-*; 5.x | full `_meta` injection (capabilities from registry, clientInfo, trace ctx hook), version select + retry-once, discover + era cache, diagnostics for legacy (via injected transport behavior), resultType handling, error-code mapping, cancel/timeout semantics incl. `uncertain-write` classification hooks, progress registry | `npm test -w packages/core`; `npx conformance run --tier A --area wire`; `npx conformance run --mutate --area wire`; `npm run check:deps` | all WIRE/VER/PROG rows `implemented` with passing fixtures; mutants fail; no change outside paths |
| **S1.2 stdio** | stdio | `packages/transport-stdio/**`, `packages/fixtures/exchanges/stdio/**`, `packages/fixtures/server/stdio-main.ts` | `wire.md` STDIO-* rows; 6.x | `StdioTransport` (spawn, framing, routing, shutdown ladder, crash/restart policy, uncertain-write classification, stderr ring), synthetic stdio server driver | `npm test -w packages/transport-stdio`; `npx conformance run --tier A,B --area stdio`; `npx conformance run --mutate --area stdio` | all STDIO rows pass incl. shutdown escalation (realtime) and crash fixtures; no leaked child processes (test asserts) |
| **S1.3 HTTP/SSE/headers** | http | `packages/transport-http/**`, `packages/fixtures/exchanges/http/**`, `packages/fixtures/server/{http-main,sse}.ts` | `wire.md` HTTP-* rows; 7.x | `HttpTransport` (POST only, headers, base64 vectors, `x-mcp-header` validation + mirroring, SSE parser, partial-failure classification, redirects, limits), `AuthProvider` interceptor hook (no auth code), synthetic HTTP server + network spy | `npm test -w packages/transport-http`; `npx conformance run --tier A,B --area http`; `--mutate --area http`; property tests (chunk-boundary invariance) | all HTTP rows pass; `Last-Event-ID`/session/GET never emitted (wire-scan clean); SSE parser fuzz green |
| **S1.4 Operations** | ops | `packages/ops/**`, `packages/fixtures/exchanges/ops/**` | `operations.md` OPS-*/PAGE-*/DISC-* rows; 8.x | tools/prompts/resources/completion APIs, pagination helper, content block normalization, JSON Schema validator wrapper (Ajv behind `SchemaValidator`), schema bounds, `$ref` guard, resource-not-found mapping | `npm test -w packages/ops`; `npx conformance run --tier A --area ops`; `--mutate --area ops`; `npm run check:deps` | all OPS/PAGE rows pass; no network access from `ops` (spy); Ajv row in `docs/deps.md` |

Parallelism notes: S1.1-S1.4 touch disjoint paths. S1.2/S1.3 each own their server driver file; if a shared interpreter change is needed they raise it to the director (touching `packages/fixtures/src/**` is S1.0-owned, frozen). Merge order is irrelevant for correctness; the director merges S1.1 first because Wave 2 reads `lifecycle.ts`.

### 16.3 Wave 2: remaining modules and optionals (starts after Wave 1 lands; slices S2.x parallel unless noted)
| Slice | Lane | Exact allowed paths | Depends on | Acceptance | DoD |
|---|---|---|---|---|---|
| S2.1 Authorization | auth | `packages/auth/**`, `packages/fixtures/exchanges/auth/**`, `packages/fixtures/server/as-main.ts` | S1.0, S1.3 (interceptor seam) | `npm test -w packages/auth`; `conformance run --tier A,B --area auth`; `--mutate --area auth`; SSRF table | all AUTH/CONSENT rows pass; DCR never used; secrets scan clean |
| S2.2 MRTR / elicitation / subscriptions / cache | mrtr-cache | `packages/mrtr-cache/**`, `packages/fixtures/exchanges/{mrtr,elic,sub,cache}/**` | S1.1, S1.4; uses `AuthProvider.contextId` from core only (S2.1 not required) | `npm test -w packages/mrtr-cache`; `conformance run --area mrtr,elic,sub,cache --tier A,B`; `--mutate` | rows pass; CACHE-AUTH-1 decision D5 applied |
| S2.3 Client Credentials + Enterprise Auth | ext-auth | `packages/ext-client-credentials/**`, `packages/ext-enterprise-auth/**`, `packages/fixtures/exchanges/ext/{cc,ema}/**` | S2.1, pins | package tests; `conformance run --area ext:cc,ext:ema`; `remove:ext-client-credentials`, `remove:ext-enterprise-auth` | opt-in, capability-gated, removal test green |
| S2.4 Tasks | ext-tasks | `packages/ext-tasks/**`, `packages/fixtures/exchanges/ext/tasks/**` | S1.1, S1.4, S2.2 (elicitation port), **pin resolved** | package tests; fixtures; `remove:ext-tasks` | uses only core stream primitives |
| S2.5 Skills | ext-skills | `packages/ext-skills/**`, `packages/fixtures/exchanges/ext/skills/**` | S1.4, pin | as above | verification vectors pass; no prefetch |
| S2.6 Apps (protocol side) | ext-apps | `packages/ext-apps/**`, `packages/fixtures/exchanges/ext/apps/**` | S1.4, pin | as above | no UI code; renderer via port |
| S2.7 Server Cards | ext-cards | `packages/ext-server-cards/**`, `packages/fixtures/exchanges/ext/card/**` | S2.1 (SafeFetch), pin | as above | advisory only |
| S2.8 Events (**only on explicit request**) | ext-events | `packages/ext-events/**`, `packages/ext-events-webhook/**`, `packages/fixtures/exchanges/ext/events/**` | S2.2, **PR-head pin reconciled**, D4 | package tests; fixtures; `remove:ext-events`, `remove:ext-events-webhook`; assertion that local runtime opens no listener | off by default; draft label in package README and capability settings |
| S2.9 Telemetry (OTel adapter) | telemetry | `packages/telemetry-otel/**`, `packages/fixtures/exchanges/tel/**` | S1.1 | package tests; `conformance run --area tel` | no content in spans by default |
| S2.10 Conformance integration | conformance | `packages/conformance/src/official.ts`, `packages/conformance/official-map.json`, `packages/conformance/cut/**`, `scripts/{wire-scan,assert-no-pi}.mjs` | S1.0 (+ official runner pin) | `npx conformance official`; `node scripts/wire-scan.mjs reports/transcripts`; `node scripts/assert-no-pi.mjs` | map complete; runner invoked as subprocess only |
| S2.11 Gate script (serial, last) | gate | `packages/conformance/src/gate.ts`, `scripts/gate.sh`, `reports/.gitkeep` | all of Wave 2 that is in scope | `npm run gate` on a clean checkout | produces `reports/gate-<sha>.md` per 14.4 |
Parallelism: S2.1 and S2.2 run first and concurrently; S2.3 waits on S2.1; S2.4/S2.5/S2.6/S2.7/S2.9/S2.10 are independent of each other once their pins and S1 deps exist; S2.8 additionally waits for the director's explicit go.

### 16.4 Spec gate (14) - director-run, between Wave 2 and Wave 3
`npm run gate` on a fresh checkout/container; report reviewed; decisions D1-D10 closed or converted to non-claims.

### 16.5 Wave 3: Pi adapters (after the gate only)
| Slice | Lane | Exact allowed paths | Depends on | Acceptance | DoD |
|---|---|---|---|---|---|
| S3.0 Cutover plan (doc) | director | `docs/cutover.md`, `docs/decisions/pi-target.md` | gate report; D3, D7 | review | pinned fork revision chosen; rollback drill described; `pi mcp` decision recorded |
| S3.1 Coding Agent adapter | adapter-ca | `adapters/pi-coding-agent/**` (+ its own `fixtures-pi/**` inside) | gate commit SHA, S3.0 | `npm test -w adapters/pi-coding-agent` (fake Pi host); scripted scratch-config run per 15.2 acceptance | PICA-1..14 pass; no changes to the fork, active config, or `pi-mcp-ext` |
| S3.2 Durable adapter | adapter-du | `adapters/pi-durable/**` | gate SHA, S3.0 | `npm test -w adapters/pi-durable` (crash-injection tests against pinned durable revision) | PICD-1..9 pass; no exactly-once claim anywhere (grep check) |
S3.1 and S3.2 run in parallel; neither touches `packages/*` (a needed library change returns to Wave 2 and re-opens the gate for the changed package, 14.4).

### 16.6 Dependency graph
```
Wave 0:  [wire.md] [operations.md] [authorization.md] [extensions.md]   (parallel)
              \          |             |              /
               +------> Director reconcile (PINS, DECISIONS, merged requirements) ----+
                                                                                      v
Wave 1:                                                                       S1.0 shared interface + runner
                                                          +-----------+-----------+-----------+
                                                          v           v           v           v
                                                        S1.1        S1.2        S1.3        S1.4
                                                        wire        stdio       http        ops
                                                          |            \         |          /
Wave 2:                       S2.9 tel <-- S1.1           |             \        v         /
                                          +--------> S2.2 mrtr-cache <-------- S2.1 auth  (S2.2 needs S1.1,S1.4 only)
                                                          |                       |
                                    S2.4 tasks (pin) <----+                       +--> S2.3 cc/ema, S2.7 cards
                                    S2.5 skills (pin)  S2.6 apps (pin)  S2.8 events (pin + request)
                                    S2.10 official runner/wire-scan (any time after S1.0)
                                                          v
                                                  S2.11 gate script
                                                          v
                                                  SPEC GATE (14)  -------------------------------->  Wave 3
                                                                                          S3.0 -> S3.1 (CA) || S3.2 (durable)
```
Critical path: Wave 0 -> S1.0 -> S1.3 -> S2.1 -> S2.3/S2.7 -> S2.11 -> gate -> S3.x. Longest serial chunks: S1.0 and the gate; everything else parallel by design. Slices that are blocked by an `UNRESOLVED` pin (S2.4-S2.8) cannot start until the Extensions lane's pin is recorded; they do not block the core gate (their rows become non-claims).

### 16.7 Cross-slice rules
- Interface changes after S1.0: only via the director; must update `INTERFACES.md`, bump the interface version, and re-run all fixtures.
- Every slice's PR includes the fixtures it claims and the mutants; a slice with a row marked `implemented` and no fixture is rejected by `check:coverage`.
- Slices must not read or copy from `pi-mcp-ext`, `@earendil-works/pi-mcp`, or any SDK (N1/N2); reviewers grep diffs for imports and comments referencing them.
- Time-box: if a slice discovers an anchor contradiction between wiki and tag, it stops and files a RECONCILIATION entry (2.4) instead of picking a side.

## 17. Risks, open questions, director decisions

### 17.1 Risks
| # | Risk | Likelihood / impact | Mitigation | Owner |
|---|---|---|---|---|
| R1 | Spec text drifts between wiki mirror (Nov. 16) and the dated tag / PR heads | M / H | reconciliation procedure 2.4; fixtures only on reconciled rows; pins in PINS.md | director |
| R2 | Beta/draft extensions (Tasks, Skills, Server Cards, Events) change without notice; normative text is outside the wiki | H / M | independent packages, pin to commit, `revision` check (EXT-REV-1), non-claims in gate, no core dependency | extensions lane |
| R3 | No idempotency or resumption on either binding => any ambiguous write cannot be resolved by the protocol | H / H | `uncertain-write` outcome, no silent retries, caller reconciliation hook, Tasks handle as the only protocol recovery, explicit `acceptDuplicate` | wire lane |
| R4 | SSE behind buffering proxies/HTTP idle timeouts; keep-alive only "encouraged" | M / M | listen watchdog configurable (`listenIdleMs`), reconnect with jitter, doc note; cannot be tested on loopback | S1.3 |
| R5 | Ajv compiles schemas synchronously; malicious schema can stall the event loop; Ajv codegen vs CSP environments | M / M | pre-compile bounds (depth/bytes/subschemas), optional worker with deadline, validator interface so it can be swapped (D8) | ops lane |
| R6 | SSRF protection needs DNS pinning; platform `fetch` cannot pin resolved IPs | M / H | custom dispatcher (undici Agent connect hook) or `node:https` with `lookup`; decision D6; egress-proxy `FetchPort` alternative | auth lane |
| R7 | Official conformance runner shape/scenarios for 2026-07-28 clients unknown | M / M | treat as black box; pin; where absent, spec-derived fixtures and explicit `official: none` | conformance |
| R8 | Pi fork divergence (`e903c27bb` vs installed `7d80b45f6`; 105/94 commits apart) invalidates adapter assumptions | M / M | D3: choose pin; adapter acceptance records revision; UNRESOLVED API names re-verified at Wave 3 start | director |
| R9 | Scope: ~11 packages and 12 gate scenarios | H / M | wave structure; Events and Apps bridge explicitly deferrable; extensions never block core gate | director |
| R10 | Token/secret leakage via diagnostics, telemetry, `uncertain-write`, session persistence | M / H | AUTH-LOG-1 scans; digests only; no tokens in session entries (adapter rule); mutants that log tokens must fail fixtures | auth lane |
| R11 | CIMD requires the host to publish a metadata document; many embedders cannot | M / M | pre-registered and `ConsentPort client-info` paths; docs; DCR intentionally not offered as fallback | auth lane |
| R12 | Cache auth-context definition (grant vs access token) may be read strictly by reviewers | M / M | D5; default partitions all entries by auth context; public sharing opt-in | ops lane |
| R13 | Windows process termination semantics (no Job Objects without native code) | L-M / L | document `child.kill` behavior; tree kill best effort | S1.2 |
| R14 | Events error codes (`-32024 Forbidden` etc.) fall inside the MCP-reserved range that core says MUST NOT be emitted unless defined | M / L | EXT-EVENTS-ERR-1; treated as extension-defined only when Events registered; follow SEP open question 5 | extensions lane |
| R15 | Two MCP stacks coexist in Pi during/after cutover (`pi mcp` stays on the old one) | M / M | D7; clear docs; separate namespaces; rollback by single settings edit | director |
| R16 | Resource leaks (child processes, sockets, timers) under cancellation/crash tests | M / M | leak checks in G2; `--detectOpenHandles`-style assertions; fake-clock timers tracked | S1.1-S1.3 |
| R17 | Wiki frontmatter pins cannot prove upstream tag content (mirror could be stale or edited) | L / H | step 1-2 of 2.4 fetch the tag directly; mismatch is a RECONCILIATION entry | director |

### 17.2 Director decisions needed (each blocks the named rows; defaults shown are what the plan assumes if unanswered)
| # | Decision | Default assumed | Blocks |
|---|---|---|---|
| D1 | Lookback/compat set: is `{2026-07-28}` the only eligible revision (no revision dated 2026-05-19..2026-07-27)? | yes; verify with `git ls-remote` tags | VER-*, 5.5 |
| D2 | Runtime baseline: Node >= 22, ESM; need browser/edge support for `core`? | Node only for transports/auth; `core` runtime-neutral | package metadata |
| D3 | Pi pin for adapters: installed build `7d80b45f6` (checkout HEAD) or `e903c27bb` (PLAN.md checkout)? | `7d80b45f6` (matches installed build) | Wave 3 |
| D4 | Events: implement at all? error-code treatment; webhook listener packaging | not implemented until explicit request; webhook separate package | S2.8, EXT-events-* |
| D5 | Cache auth context = grant (token refresh keeps cache) or access token (refresh flushes)? Share `public` across auth contexts? | grant-based id; public sharing off | CACHE-AUTH-1, CACHE-SCOPE-3 |
| D6 | SSRF policy: block private ranges for discovery fetches by default? DNS-pinning mechanism? Browser authorization URLs exempt from IP checks? | block by default (override per host); pinning via custom dispatcher; browser URL https-only check | AUTH-SSRF-* |
| D7 | Standalone `pi mcp`: leave on old stack (A), separate bin (C), or fork change (B)? | A | CUT-PI-MCP-1 |
| D8 | JSON Schema validator (Ajv vs codegen-free alternative); validation time budget | Ajv behind `SchemaValidator`; size/depth bounds only | OPS-SCHEMA-6 |
| D9 | Form elicitation with unsupported `requestedSchema`: fail round or send `decline`? | fail with `protocol-violation` | ELIC-FORM-2 |
| D10 | Auto-retry policy for read-only methods after ambiguous failure: on or off by default? | on for the read-only list (6.5), off for everything else | STDIO-RECOVER-1, HTTP-RETRY-1 |
| D11 | Publication/remote repo/CI deployment: none planned in any wave | none | N12 |

### 17.3 Open questions ledger (UNRESOLVED items; each gets a `Q<n>` in `docs/conformance/DECISIONS.md` at Wave 0)
Q1 lookback tag list (D1) | Q2 Node baseline (D2) | Q3 exact repo path of dated tag docs and `schema.json` (2.4) | Q4 annotated-tag peel for `5f5440bb...` (2.1) | Q5 `ttlMs`/`cacheScope` presence on `DiscoverResult` and exact field types in tag schema (5.8) | Q6 `-32601`/`-32602` `data` shapes (5.8) | Q7 batching language absence (6.1) | Q8 `prompts/get` idempotency statement (6.5) | Q9 upstream revisions of ext-tasks / ext-skills / ext-apps / ext-auth / ext-server-card / SEP-2640 (12.x) | Q10 OTel MCP semconv revision (11.1) | Q11 W3C `tracestate`/`baggage` limits (11.1) | Q12 PRM `resource` check source (AUTH-PRM-3) | Q13 whether `resources/templates/list` is invalidated by `resourcesListChanged` (9.3) | Q14 server caps on resource subscription counts (9.3) | Q15 server behavior for expiring tokens on open streams (9.3) | Q16 official conformance runner package/CLI/version (13.6) | Q17 Events: Status label at PR head `60b15c16...` and mirror delta (2.2) | Q18 Events `events/list` pagination (12.7) | Q19 Apps `ui/*` dialect pin (12.5) | Q20 Server Cards current spec and discovery doc (12.6) | Q21 Pi extension API exact names, replacement semantics, durable hooks (15.1) | Q22 Windows tree termination (6.3) | Q23 `listenIdleMs` default evidence (7.5) | Q24 env inheritance policy for stdio (6.1) | Q25 `$ref`/`x-mcp-header` interplay (7.3 step 5) | Q26 schema validation time budget (8.6) | Q27 RFC 6570 template expander dependency (8.4) | Q28 Pi fork checkout drift (2.1) | Q29 `Mcp-Param` / notification-header requirements for extension notifications over HTTP (7.1) | Q30 which hosts in `client-matrix.md` resemble Pi's expectation (12.9).

### 17.4 Definition of "plan done" (for this document)
The plan is accepted when the director has (1) answered or deferred D1-D10, (2) assigned Wave 0 lanes, (3) confirmed the slice boundaries and allowed paths in 16, and (4) agreed that nothing in this plan authorizes changes to Pi, active configuration, deployment, publication, or remote repository creation.

