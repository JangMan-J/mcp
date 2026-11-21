# Decisions

Wave 0 ledger. D1–D12 record the §17.2 defaults and later amendments unless a row says the default was narrowed by an observation. Q1–Q30 are the §17.3 ledger. Q31–Q38 are the supplemental ids the operations and authorization lanes already used. Answered means a choice or a sourced fact is recorded. Deferred means a fixture or a symbol is still blocked. Recording a default does not move an `unresolved` lane row to `required`. Pin values are in `PINS.md`. Semantic gaps are in `RECONCILIATION.md`.

Events: the explicit request is planning, not enabling. D4 does not implement Events and does not turn it on. PLAN.md N11 wins over an Accepted label.

## D1–D12

| Id | Status | Recorded choice | Row impact | Next evidence |
|---|---|---|---|---|
| D1 | answered | Lookback set is the primary profile only. The tag list in [PINS.md](PINS.md) has no other tag dated inside the lookback window | `VER-*` stay as the wire lane wrote them. No initialize-era fallback | An upstream tag created later would reopen this |
| D2 | answered | Node >= 22 for transports and auth. `core` stays runtime-neutral. No browser or edge target. The installed engine field and this machine's node are in [PINS.md](PINS.md) | Package metadata later. No row change now | Wave 1 engine field |
| D3 | answered | Adapter pin is the checkout in [PINS.md](PINS.md). It matches the installed build recorded there. The PLAN.md checkout recorded there is not selected | Wave 3 only. Nothing in Pi changes now | Q21 before any adapter code |
| D4 | answered, not enabled | Events are planned and stay draft-labeled and off. Webhook delivery stays a separate package in the plan. No Events code in Wave 0 | `EXT-events-*` dispositions stay as the extensions lane wrote them. PR-head header rows stay unresolved | A later explicit request to implement, after the header subsection is adopted or rejected |
| D5 | answered, fixture gated | Cache auth context id is the grant. Public sharing stays off. A configured bearer has no grant, so that id is a hash of the token, as the authorization lane described | `CACHE-AUTH-1` and `AUTH-BEARER-5` stay `unresolved`. The spec example is a different access token and does not define refresh | A fixture may be written only after this gate is lifted in a later slice |
| D6 | answered | Block private, loopback, and link-local ranges on discovery fetches by default. Host may override. Pin DNS with a custom dispatcher. Browser authorization URLs require HTTPS by default. Only explicit `allowInsecureDev: true` permits HTTP, and only for loopback hosts (2026-11-20: amended for the official conformance suite's loopback mock AS). | `AUTH-SSRF-*`, `AUTH-URL-1`, `EXT-ema-12` stay as written. Q32 is closed by this default | Implementation slice S2.1 |
| D7 | answered | Standalone `pi mcp` stays on the old stack (option A). No fork change. Option C is not started | `CUT-PI-MCP-1` records A. Not built in Wave 0 | Wave 3 cutover doc |
| D8 | answered | Ajv behind a `SchemaValidator` port. Bounds are size and depth only (depth 64, 10000 subschemas, 1 MiB), already on `OPS-SCHEMA-6`. No time budget | Q26 closed. The row stays `required` with that proposal. The numbers are plan bounds, not spec numbers | Swap the validator only through the port |
| D9 | answered, fixture gated | Unsupported form `requestedSchema`: fail the round with `protocol-violation` and do not send `decline` | `ELIC-FORM-2` stays `unresolved`. The spec lists decline, cancel, or failure to process and does not pick one | Same gate as D5: do not encode the fixture until a later slice lifts it |
| D10 | answered | Auto-retry after ambiguous failure is on for the read-only list and off for everything else. `prompts/get` stays on that list only as a host-overridable default | `STDIO-RECOVER-1` and `HTTP-RETRY-1` stay as the wire lane wrote them. Q8 is not closed | A spec sentence, or a test that the host can take `prompts/get` off the list |
| D11 | answered | No publication, remote repository, or deployment in any wave covered by this plan | No package is created here | A separate plan if that changes |
| D12 | answered | 2026-11-21: Ring 1 / user approved option B. Dynamic Client Registration (RFC 7591) is an explicit host opt-in (`OAuthOptions.dynamicRegistration = { clientName, softwareId? }`), default off, for back-compat only. With it off, `registration_endpoint` is read but never POSTed. With it on, register once per issuer after pre-registration and CIMD and before the consent client-info prompt; send `application_type` native/web (SEP-837) and select `token_endpoint_auth_method` from the AS list. Rationale: 20 of the 32 required official 2026-07-28 client scenarios use DCR against the runner's mock AS. This amends N8 for DCR only; Roots, Sampling, Logging, and HTTP+SSE are unchanged. The separate D6 loopback amendment exists and is unchanged. | `AUTH-DCR-1` and `AUTH-DCR-2` become `conditional`; `DEP-DCR-1` stays `deprecated`; the conformance CUT enables the opt-in | `auth/dcr-never-called`; unit [AUTH-DCR-1] and [AUTH-DCR-2] |

## Q1–Q30

| Id | Status | What was decided or seen | Rows | Next evidence |
|---|---|---|---|---|
| Q1 | answered | Same observation as D1 | `VER-*` | A new upstream tag |
| Q2 | answered | Same as D2. The Pi engine field in [PINS.md](PINS.md) is host metadata, not a `core` import | none in the tables | Engine field in Wave 1 |
| Q3 | answered | Tag docs path and schema path are in [PINS.md](PINS.md). Both exist at the unpeeled tag | operations and wire notes | none |
| Q4 | answered | The dated tag is a commit, not an annotated tag. Peel equals the tag id in [PINS.md](PINS.md). `ls-remote` printed no `^{}` line | none | none |
| Q5 | answered | `DiscoverResult` requires `ttlMs` (integer), `cacheScope` (`public` or `private`), `capabilities`, `resultType`, `supportedVersions`. `instructions` optional | `DISC-1` and the wire schema notes | none for field presence |
| Q6 | answered | `-32601` and `-32602` require only `code` and `message`. `data` is optional and untyped | `WIRE-ERR-4` | The calculate-sample disagreement is a fixture gate in [RECONCILIATION.md](RECONCILIATION.md), not this question |
| Q7 | answered | No `batch` match in the tagged specification tree | wire non-claim | none |
| Q8 | deferred | No idempotency sentence for `prompts/get` in `server/prompts.mdx`. D10 does not invent one | `STDIO-RECOVER-1` | Spec text or a host override test |
| Q9 | answered | Upstream heads are in `PINS.md` for tasks, skills, apps, auth, and server cards. SEP-2640 has only the wiki docs mirror, no separate SHA | `EXT-cc-PIN`, `EXT-ema-PIN`, `EXT-cc-1`, `EXT-ema-1` stay `unresolved`. The pin record does not promote them | Implementation slices after the non-claims are explicitly closed |
| Q10 | deferred | OTel page was read. Status Development, no tags, changelog Unreleased. Span name there is the method plus an optional low-cardinality target. Not adopted. Plan default `mcp.client <method>` remains the local note on `TEL-SPAN-1` | `TEL-SPAN-1` | A released semconv revision, or a later decision to adopt this page |
| Q11 | answered | Trace Context: at most 32 tracestate list-members; vendors SHOULD propagate at least 512 characters. Baggage: propagate up to 64 list-members and 8192 bytes. The plan's single 512/32 figure is not the baggage limit | wire telemetry notes. No row change | none |
| Q12 | answered | RFC 9728 s3.3 has the two `resource` identity checks. s7.3 is the TLS certificate check, not a second copy of s3.3 | `AUTH-PRM-3`, `AUTH-PRM-4` | none for the source question |
| Q13 | answered | Wiki and tag List Changed Notification name the resource list only. No templates notification in that clause. Plan 9.3's extra invalidation is not encoded | `SUB-LIST-4` | A decision to encode the plan sentence would be a new reconciliation line |
| Q14 | deferred | No server maximum in the subscription prose or on `SubscriptionFilter.resourceSubscriptions` | `SUB-CAP-1` | A spec cap, or a decision that the client cap is local policy |
| Q15 | deferred | No mid-stream token-expiry clause in `subscriptions.md` | `SUB-AUTH-1`, `AUTH-CONT-1` | Spec text or an explicit non-claim that stays |
| Q16 | answered | G12 uses `@modelcontextprotocol/conformance` `0.2.0-alpha.12` at the commit in [PINS.md](PINS.md). Run the `client` command with `--spec-version 2026-07-28`. The profile’s requirements YAML lists 32 required client scenarios; `not_scored` entries are outside the core claim | `GATE-5` records the runner result | Scenario results, not the pin, determine whether G12 passes |
| Q17 | answered as observation, not adopted | Mirror and PR head both say Accepted. The file delta is in [PINS.md](PINS.md). Project label stays draft and off | `EXT-events-8`, `EXT-events-9`, `EXT-events-ERR-1` stay unresolved | A decision to adopt or drop that subsection |
| Q18 | answered | `events/list` is paginated in the mirror, at the PR head, and in the wiki | extensions notes. No open row | none |
| Q19 | answered | Apps `ui/*` text is `specification/2026-01-26/apps.mdx` on ext-apps `main`. There is no `specification/stable/` tree at that commit | extensions notes | A later stable path would be a new pin |
| Q20 | deferred | Discovery doc at server-card HEAD says draft. Wiki extensions page says Beta. Both were read. The stage is not chosen | `EXT-card-10` | A director choice of one label, or an upstream edit that removes the conflict |
| Q21 | deferred | Pi extension API names were not re-read. MCP package, changes, and adapters were out of scope for this pass | `PICA-1`, `PICA-2`, `PICA-5`, `PICA-6`, `PICA-7`, `PICA-9`, `PICA-10` | Wave 3 read of the pinned checkout only |
| Q22 | deferred | Windows termination mechanism is not chosen | `STDIO-SHUT-2` | A mechanism choice |
| Q23 | deferred | No listen-idle duration in the spec | `HTTP-LIMIT-4` | A chosen number, or a decision to leave it unset |
| Q24 | deferred | Child environment inheritance is host policy | `STDIO-ENV-1` | A host policy |
| Q25 | answered | An `x-mcp-header` reached through `$ref` makes the tool definition invalid. It is not dereferenced | `HTTP-PARAM-1` | none |
| Q26 | answered | No schema time budget (D8). Depth, count, and byte caps stay the plan proposal | `OPS-SCHEMA-6` | none unless a budget is added later |
| Q27 | deferred | RFC 6570 is the template language. No expander library is pinned. In-tree expander is the unimplemented default | `OPS-RES-2` | A dependency row, or confirmation that in-tree is the pin |
| Q28 | answered | Checkout drift is the pair recorded in [PINS.md](PINS.md). D3 selects HEAD | Wave 3 pin | none |
| Q29 | deferred | Notification POST header requirements for extension notifications are not in this revision | `HTTP-NOTIF-2` | Spec text |
| Q30 | deferred | Wiki client matrix does not name Pi. Hosts on the first rows include Claude, VS Code GitHub Copilot, Microsoft 365 Copilot, Goose, and Postman. No resemblance was chosen. The matrix is not a wire reference | no requirement row | A later comparison if an adapter needs one |

## Q31–Q38

These ids are not in §17.3. The lanes already referenced them. They are registered here.

| Id | Status | What was decided or seen | Rows | Next evidence |
|---|---|---|---|---|
| Q31 | answered, fixture gated | This is D5. Grant id, public sharing off | `CACHE-AUTH-1`, `AUTH-BEARER-5` stay unresolved | Lift the fixture gate before a test asserts the grant id |
| Q32 | answered | This is D6. Block by default, host override, DNS pinning, browser URL HTTPS by default (see D6 for the loopback exception) | `AUTH-SSRF-1` through `AUTH-SSRF-4`, `AUTH-SSRF-7`, `AUTH-URL-1`, `EXT-ema-12` | S2.1 |
| Q33 | deferred | `aud` is the token endpoint URL at the tag docs page, the issuer only in the wiki, and absent from the ext-auth spec | `EXT-cc-5` | One chosen source. Until then, no fixture |
| Q34 | deferred | Secret-in-body versus `client_secret_basic`, and JWT `grant_type` shape, disagree across the tag page and the ext-auth spec | `EXT-cc-2`, `EXT-cc-3`, `EXT-cc-6` | One chosen source |
| Q35 | deferred | "Server indicates enterprise-managed auth is required" is not defined on the wiki page. The stable spec detects `authorization_grant_profiles_supported` | `EXT-ema-2`, `EXT-ema-9` | A chosen detection rule |
| Q36 | deferred | EMA draft inputs were read (ID-JAG `-04`, CIMD `-01`, link to `2025-11-25`) and are not adopted as core | `EXT-ema-4`, `EXT-ema-7`, `EXT-ema-8` | A chosen draft set inside the lookback |
| Q37 | deferred | Spec says pre-registered credentials that no longer match the AS SHOULD surface an error, and CIMD client ids are portable. The plan's "discard and redo" is not adopted | `AUTH-BIND-1`, `AUTH-BIND-2` | A decision if the plan sentence is dropped or kept as a stricter local error |
| Q38 | answered, fixture gated | This is D9. Fail with `protocol-violation`. Do not send `decline` | `ELIC-FORM-2` stays unresolved | Lift the fixture gate before encoding it |

## What this ledger does not do

- It does not enable Events, Tasks, Skills, Apps, Server Cards, client credentials, or enterprise-managed authorization.
- It does not change Pi, the active config, or any package.
- It does not treat an `unresolved` row as implemented because a default is written here.
