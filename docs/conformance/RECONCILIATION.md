# Reconciliation

Procedure `IMPLEMENTATION_PLAN.md` §2.4. Each line is page, clause, class, action. Classes are `same`, `wording-only`, `semantic`, `wiki-only`, `tag-only`. A semantic row is a non-claim until a decision says otherwise. Pin values live only in `PINS.md`.

Compared 2026-11-19T06:47:10Z. Wiki root `~/vaults/JangsWiki/Wiki/mcp`. Tag `5f5440bb26a62e2cf3440b92da5a667efa03b267`. Method: strip frontmatter, fenced code, HTML, and markdown link URLs; keep RFC 2119 sentences; compare normalized sentence keys. Fenced code was not given its own pass. Where the only leftover was a `Note` or `Warning` label, a link path, or a typo that leaves the following MUST intact, the class is `wording-only`.

Lane evidence is cited. It is not repeated as a new observation unless this pass saw the same bytes.

## Dated tag against the wiki spec tree

| Page | Clause | Class | Action |
|---|---|---|---|
| `specification/2026-07-28/architecture/index.md` | RFC sentences | same | `pin: tag`. No row change |
| `specification/2026-07-28/basic/authorization/authorization-server-discovery.md` | RFC sentences | same | `pin: tag` |
| `specification/2026-07-28/basic/authorization/client-registration.md` | RFC sentences | same | `pin: tag`. CIMD draft `-00` is in this tree |
| `specification/2026-07-28/basic/authorization/security-considerations.md` | RFC sentences | same | `pin: tag` |
| `specification/2026-07-28/basic/patterns/cancellation.md` | RFC sentences | same | `pin: tag` |
| `specification/2026-07-28/basic/patterns/index.md` | RFC sentences | same | `pin: tag` |
| `specification/2026-07-28/basic/patterns/progress.md` | RFC sentences | same | `pin: tag` |
| `specification/2026-07-28/basic/transports/index.md` | RFC sentences | same | `pin: tag` |
| `specification/2026-07-28/basic/versioning.md` | RFC sentences | same | `pin: tag` |
| `specification/2026-07-28/changelog.md` | RFC sentences | same | `pin: tag`. Registry removals and changelog removals stay distinct, as the operations lane recorded |
| `specification/2026-07-28/deprecated.md` | RFC sentences | same | `pin: tag`. This page, not the overview blurb, is the deprecation registry |
| `specification/2026-07-28/index.md` | RFC sentences | same | `pin: tag` |
| `specification/2026-07-28/server/index.md` | RFC sentences | same | `pin: tag` |
| `basic/patterns/mrtr.md`, `client/roots.md`, `server/discover.md`, `server/prompts.md`, `server/utilities/caching.md`, `server/utilities/completion.md`, `server/utilities/logging.md`, `server/utilities/pagination.md` | prose RFC sentences after fences were removed | same | Fence contents were not diffed. No semantic prose change is claimed. Do not encode a fixture from an unread code sample |
| `basic/patterns/subscriptions.md` | Graceful closure: wiki "completion result"; tag "empty result" | wording-only | Operations lane: the JSON example matches (`resultType` `complete` plus `subscriptionId`). `SUB-END-2` follows the example. Not a semantic gap |
| `basic/transports/stdio.md` | shutdown and cancellation sentences | wording-only | Link text differs (`index.md` versus the dated path). Obligations match |
| `basic/transports/streamable-http.md` | integer header comparison, intermediary errors, protocol-version check | wording-only | Wiki prefixes those sentences with `Note`. Obligations match |
| `client/elicitation.md` | form-mode secret ban | wording-only | Wiki prefixes `Warning`. The MUST NOT matches |
| `client/sampling.md` | human-in-the-loop SHOULD; sampling capability MUST | wording-only | `Warning` label and example spacing. Sampling stays excluded by PLAN N8 |
| `server/resources.md` | capabilities sentence | wording-only | Tag says "Serves" / "or". Wiki says "Servers" / "nor". The following MUST matches. Operations lane `SUB-LIST-4`: List Changed Notification names resources, not `resources/templates/list` |
| `server/tools.md` | human-in-the-loop; tool description; sensitive `x-mcp-header` | wording-only | `Warning` label only in the normalized keys |
| `basic/authorization/index.md` | example of "access tokens MUST NOT" be in the query | wording-only | The example request is `GET` at the tag and `POST` in the wiki. The prohibition is the same. Not a new client requirement |
| `basic/index.md` | overview feature list | semantic | Wiki marks sampling, roots, and logging as deprecated in the component list. The tag lists them as current client features and utilities. The dated `deprecated.md` already matches the wiki and is the registry. Do not encode a test from the wiki overview blurb. `DEP-*` and PLAN N8 stand |
| `basic/index.md` | `clientInfo` / `serverInfo` note | wording-only | Wiki inserts `Note`. No extra obligation |
| `schema.md` (wiki typedoc) versus `schema/2026-07-28/schema.json` | `InvalidParamsError` for tools | semantic | Tag description says unknown tool name or invalid tool arguments. Wiki typedoc says invalid tool arguments are `isError`, not this code. Non-claim. No fixture chooses between them. Wire lane already refused that test |
| `schema/2026-07-28/schema.json` | `DiscoverResult` | tag-only field set | Wiki has no `schema.json`. Required: `cacheScope`, `capabilities`, `resultType`, `supportedVersions`, `ttlMs`. `ttlMs` is integer. `cacheScope` is `private` or `public`. `instructions` is optional. Operations lane said `ttlMs` is a number; the schema type is integer |
| `schema/2026-07-28/schema.json` | `-32601`, `-32602` | tag-only | Required `code` and `message` only. `data` is untyped and not required |
| `schema/2026-07-28/schema.json` | `-32022` | tag-only | `data.requested` string and `data.supported` string array are required |
| `schema/2026-07-28/schema.json` | `-32021` | tag-only | `data.requiredCapabilities` required |
| `schema/2026-07-28/schema.json` | `-32020` `HeaderMismatchError` | tag-only | `data` is not required |
| tag spec tree | word `batch` | tag-only absence | `git grep -i batch` under `docs/specification/2026-07-28` at the tag found no match. Q7 closed as absence, not as a prohibition invented here |
| `server/prompts.mdx` | `prompts/get` idempotency | missing | No `idempoten` match in that file. Q8 stays open. Do not call `prompts/get` spec-idempotent |
| `streamable-http.mdx` | `x-mcp-header` and `$ref` | same obligation at the tag | The chain MUST NOT pass through `$ref`. An annotation elsewhere makes the tool definition invalid. Q25 closed. This does not adopt the Events-only subsection |

No wiki spec page in `specification/2026-07-28` lacked a tag `.mdx`, and no tag `.mdx` in that directory lacked a wiki `.md`, except `schema.md` / `schema.mdx` which are typedoc mirrors rather than the JSON file.

## Authorization extension pages (not the dated core)

Tag path `docs/extensions/auth/*.mdx` versus docs commit `de3550c9fea3c5269e42ac95204eef44a2b2cb92` and the wiki pages. Authorization lane evidence E1–E2 matches what this pass read.

| Page | Clause | Class | Action |
|---|---|---|---|
| `extensions/auth/oauth-client-credentials` | JWT `aud` | semantic | Tag docs: token endpoint URL. Wiki and docs commit: issuer identifier as the only value, citing RFC 10070. ext-auth stable spec is silent on `aud`. Non-claim. `EXT-cc-5` stays unresolved (Q33) |
| `extensions/auth/oauth-client-credentials` | JWT grant shape | semantic | Tag diagram: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer` and `assertion`. Wiki, docs commit, and ext-auth spec example: `grant_type=client_credentials` plus `client_assertion`. Non-claim. `EXT-cc-3` stays unresolved (Q34) |
| `extensions/auth/oauth-client-credentials` | client secret | semantic | ext-auth text says "in the request content". Metadata rule names `client_secret_basic` or `private_key_jwt`. Non-claim. `EXT-cc-2` and `EXT-cc-6` stay unresolved (Q34) |
| `extensions/auth/enterprise-managed-authorization` | where the client asks for an ID-JAG | semantic | Tag docs: IdP authorization endpoint. Wiki, docs commit, and ext-auth spec: IdP token endpoint, then redeem at the resource AS token endpoint. Non-claim. `EXT-ema-4` stays unresolved (Q36) |
| `extensions/auth/enterprise-managed-authorization` | "server indicates required" | semantic | Wiki wording is undefined. ext-auth discovery is `authorization_grant_profiles_supported`. Non-claim. `EXT-ema-2` and `EXT-ema-9` stay unresolved (Q35) |
| ext-auth EMA spec | draft inputs | observed, not a class of wiki-versus-tag | ID-JAG draft `-04`, CIMD draft `-01`, CIMD link aimed at `2025-11-25`. Core tag text cites CIMD `-00`. Non-claim (Q36). Not selected as a newer core baseline |
| RFC 9728 | `resource` check | external, not a wiki diff | s3.3: well-known retrieval must echo the identifier the suffix was inserted into; `WWW-Authenticate` retrieval must echo the URL used for the resource request. s7.3 is Impersonation Attacks and requires TLS certificate checking (RFC 9525). It does not repeat the s3.3 sentence. `AUTH-PRM-3` and `AUTH-PRM-4` stay as the authorization lane wrote them. Q12's source question is answered |

## SEP-3415 and other extensions

| Page | Clause | Class | Action |
|---|---|---|---|
| `seps/3415-events-extension.md` mirror versus PR head | status line | same | Both say `Accepted`. Wiki shows Accepted. PLAN.md N11 still wins: draft-labeled and off. Accepted is not an implementation claim. D4 records planning only |
| `seps/3415-events-extension.md` | `Custom headers from subscription arguments` | semantic | Present only at the PR head (+32/−1 on that file). Absent from the mirror and the wiki. Not adopted. `EXT-events-8`, `EXT-events-9`, and `EXT-events-ERR-1` stay unresolved |
| `seps/3415-events-extension.md` | `events/list` pagination | same | `cursor` / `nextCursor` in the mirror, the PR head, and the wiki. Q18 closed |
| wiki versus mirror SEP body | other normative sentences | wording-only | Docs-site conversion. No extra normative sentence found by the extensions lane; this pass confirmed the file diff against the mirror is only the header subsection |
| ext-tasks `specification/2026-07-28/tasks.md` versus `specification/draft/tasks.md` | MRTR links | wording-only | Two link targets differ. Dated file is the pin. Full RFC diff against the wiki tasks guide was not run |
| ext-skills `specification/beta/skills.mdx` | no-prefetch, 512 files, 16 MiB, digest, approval binding | observed in the pinned file | Not fully sentence-diffed against the wiki overview. Lane said the wiki MUSTs match with shorter wording. That full diff is pending. No row is reclassified from it |
| ext-apps `specification/2026-01-26/apps.mdx` | `ui/*` path | wiki-only gap versus a stable directory | There is no `specification/stable/` tree at the pinned apps commit. Q19 closed as a path fact. Full diff against the wiki apps guide is pending |
| ext-server-card `docs/discovery.md` versus wiki extensions overview | stage label | semantic | Discovery doc says draft. Overview says Beta. SEP snapshot `526201bb…` is not HEAD. Q20 stays open. `EXT-card-10` stays unresolved |
| experimental repos | specification files | wiki-only or missing | Interceptors: no `specification/`. Variants: no specification file. Triggers: no specification file. Tool annotations: draft files exist and were not requested. Rows stay excluded or unresolved as the extensions lane wrote them |
| OTel `docs/gen-ai/mcp.md` | span name | observed, not a spec class | Development, no tags, changelog Unreleased. Span name on that page disagrees with the plan default `mcp.client <method>`. Not adopted. `TEL-SPAN-1` stays unresolved (Q10) |
| conformance README | 2026-07-28 client scenarios | missing on the selected release | `v0.1.16` README does not mention `2026-07-28` and its client example is `--scenario initialize`. Main README documents `--spec-version` and `--requirements 2026-07-28` and is not the selected pin. No scenario id is claimed. Q16 stays open |

## Plan versus spec (not a second source pin)

| Page | Clause | Class | Action |
|---|---|---|---|
| plan 9.3 versus `resources.md` List Changed Notification | template list invalidation | semantic | Spec and wiki do not name `resources/templates/list` on `resources/list_changed`. Plan 9.3 also drops templates. Not encoded. `SUB-LIST-4` stays the spec reading |
| plan N8 versus changelog major 5 | `io.modelcontextprotocol/logLevel` | semantic | `deprecated.md` and the changelog match across wiki and tag. The registry deprecates Logging. Changelog major 5 still describes that per-request field. `DEP-LOG-1` follows N8 and does not send it. Do not add a logging test that treats the changelog sentence as a client MUST |
| D5 versus `caching.md` Cache Scope | auth-context id | semantic | Spec example is a different access token. It does not say whether a refresh under the same grant is a new context. Default recorded in `DECISIONS.md`. Rows `CACHE-AUTH-1` and `AUTH-BEARER-5` stay unresolved. Fixture not authorized yet |
| D9 versus `elicitation.md` Error Handling | unsupported `requestedSchema` | semantic | Spec names decline, cancel, or the client failing to process, and does not pick one. Default recorded. `ELIC-FORM-2` stays unresolved. Fixture not authorized yet |
| D7 versus standalone `pi mcp` | cutover | plan decision | Default A recorded: leave `pi mcp` on the old stack. Not implemented in Wave 0. Pi MCP sources were not re-read |

## Pending

- Code-fence equality for the eight pages listed above.
- Full RFC-sentence diff of pinned `tasks.md`, `skills.mdx`, `apps.mdx`, and `docs/discovery.md` against the wiki guides.
- SEP-2640 body against ext-skills. No separate SEP SHA was pinned.
- Official runner scenario ids on a release that actually lists 2026-07-28 client scenarios.
- Pi extension API names (Q21). Not read.
