# Reconciliation

Procedure `IMPLEMENTATION_PLAN.md` §2.4. Each log line is page, clause, class, action. The class cell is only `same`, `wording-only`, `semantic`, `wiki-only`, or `tag-only`. A semantic row is a non-claim until a decision says otherwise. Pin values live only in [PINS.md](PINS.md).

This pass compared the dated core pages at the tag in [PINS.md](PINS.md) with `~/vaults/JangsWiki/Wiki/mcp/specification/2026-07-28`. Normalization stripped frontmatter, MDX and HTML tags, heading anchors, and link URLs. It kept RFC 2119 sentences, markdown tables, and fenced samples. HTML `<pre>` samples on `schema.md` were compared as samples too, because that page does not use fences. A `Note` or `Warning` label, a glued link label, or a typo that leaves the following obligation intact is `wording-only`.

Lane rows are not rewritten here. A fixture gate names the row whose check must not be encoded from the conflicting sample.

## Log

| Page | Clause | Class | Action |
|---|---|---|---|
| `architecture/index.md`; `basic/authorization/authorization-server-discovery.md`; `basic/authorization/client-registration.md`; `basic/authorization/security-considerations.md`; `basic/patterns/index.md`; `basic/patterns/progress.md`; `basic/transports/index.md`; `basic/transports/stdio.md`; `basic/versioning.md`; `changelog.md`; `client/roots.md`; `deprecated.md`; `index.md`; `server/discover.md`; `server/index.md`; `server/prompts.md`; `server/utilities/caching.md`; `server/utilities/completion.md`; `server/utilities/logging.md`; `server/utilities/pagination.md` | RFC sentences, markdown tables, and fenced samples | same | `pin: tag`. Stdio link labels (`index.md` versus the dated path) disappear once URLs are stripped. The cache-scope table matches, including the different-access-token example |
| `basic/patterns/cancellation.md` | invalid-cancellation SHOULD | wording-only | Wiki leaves the link label `subscriptions.md` on the sentence. The obligation matches |
| `basic/patterns/mrtr.md` | single-use `requestState` | wording-only | Wiki glues the footnote sentence onto the replay list. Both sides say a server that must consume state once enforces that itself |
| `basic/patterns/subscriptions.md` | graceful closure | wording-only | Wiki says "completion result" / "successful" response. Tag says "empty result". The four fenced samples match, including `resultType` `complete` plus `subscriptionId`. `SUB-END-2` follows the sample |
| `basic/transports/streamable-http.md` | version check; `x-mcp-header` | wording-only | Wiki glues `schema.md` and `server/tools.md` link labels into the sentences. Tables (4) and fences (10) match. `HTTP-PARAM-1` stays the transport reading: a chain through `$ref` is invalid and is not dereferenced |
| `client/elicitation.md` | URL-mode security sentences | wording-only | Wiki drops link labels (`MCP Authorization`, token passthrough). The MUST and MUST NOT sentences match. Tables (3) and fences (19) match |
| `client/sampling.md` | capability MUST | wording-only | Wiki drops the link label "feature lifecycle policy". Sampling stays excluded by PLAN N8 |
| `server/resources.md` | resources capability sentence | wording-only | Tag says "Serves" / "or". Wiki says "Servers" / "nor". The following MUST matches. Fences (15) match. `SUB-LIST-4` stays the list-changed reading: resources, not templates |
| `server/tools.md` | "suitable URI scheme" | wording-only | Wiki drops the link label. Separate from the annotations sample below |
| `basic/index.md` | overview feature list | semantic | Wiki marks sampling, roots, and logging deprecated in the component list. The tag lists them as current client features and utilities. `deprecated.md` matches and is the registry. Do not encode a test from the overview blurb. `DEP-*` and PLAN N8 stand |
| `basic/index.md` | subscription id MUST | wording-only | Wiki glues link labels. The MUST matches |
| `architecture/index.md` | sequence diagram, input-required branch | semantic | Wiki sample: `elicitation/create`, "Ask user for input". Tag sample: `sampling/createMessage`, "Forward to AI". Fixture gate: do not encode this diagram. `DEP-SAMPLING-1` and `MRTR-C-8` stay fail-closed for sampling. No architecture row changes |
| `basic/authorization/index.md` | bearer example | semantic | Tag fence is `GET /mcp` plus an `Authorization` header and no body. Wiki fence is `POST /mcp` with `MCP-Protocol-Version`, `Mcp-Method`, and a JSON-RPC body. The "token MUST NOT be in the query" sentence matches. Fixture gate: `HTTP-REQ-1` and `HTTP-NOGET-1` stay on the transport page, which matched. Do not copy this example into `http/post-json-body` or `http/no-get` |
| `server/tools.md` | embedded resource sample | semantic | Wiki puts `annotations` beside `resource`. Tag nests `annotations` inside `resource`. Tag `schema.json` `EmbeddedResource` has `annotations` beside `resource`. `TextResourceContents` has no `annotations`. Fixture gate: `OPS-TOOLS-13` and `OPS-PROMPT-3` must not copy the tag nesting. Pass-through of an unknown content type is not the disputed part |
| `schema.md` | `InvalidParamsError` tools bullet and calculate sample | semantic | Tag typedoc and tag `schema.json`: "Unknown tool name or invalid tool arguments", and the calculate missing-property object is a `-32602` sample. Wiki typedoc: invalid tool arguments are `isError`, and the `-32602` sample is a malformed `arguments` value. `server/tools.md` Error Handling matches on both sides: CallToolRequest schema failure is a protocol error; input validation (date, range) is `isError`. Fixture gate: `OPS-TOOLS-8` and `OPS-TOOLS-9` must not use the calculate sample to choose. Unknown-tool `-32602` is the same sample on both typedocs. `WIRE-ERR-4` is only `code` and `message` |
| `schema.md` | `find_resource` `oneOf` sample; `list_users` array `outputSchema` sample | wiki-only | Not in the tag typedoc. Tag `schema.json` already allows composition keywords on `inputSchema` and any JSON Schema on `outputSchema`. Do not add a row from the samples |
| `schema/2026-07-28/schema.json` | `DiscoverResult` | tag-only | Wiki has no `schema.json`. Required: `cacheScope`, `capabilities`, `resultType`, `supportedVersions`, `ttlMs`. `ttlMs` is integer. `cacheScope` is `private` or `public`. `instructions` is optional |
| `schema/2026-07-28/schema.json` | `-32601`, `-32602` | tag-only | Required `code` and `message` only. `data` is untyped and not required |
| `schema/2026-07-28/schema.json` | `-32022` | tag-only | `data.requested` string and `data.supported` string array are required |
| `schema/2026-07-28/schema.json` | `-32021` | tag-only | `data.requiredCapabilities` required |
| `schema/2026-07-28/schema.json` | `-32020` `HeaderMismatchError` | tag-only | `data` is not required |
| `extensions/auth/oauth-client-credentials` | JWT `aud` | semantic | Tag docs: token endpoint URL. Wiki and the docs commit: issuer identifier as the only value. ext-auth stable spec is silent. `EXT-cc-5` stays unresolved |
| `extensions/auth/oauth-client-credentials` | JWT grant shape | semantic | Tag diagram: JWT-bearer grant and `assertion`. Wiki, docs commit, and ext-auth example: `client_credentials` plus `client_assertion`. `EXT-cc-3` stays unresolved |
| `extensions/auth/oauth-client-credentials` | client secret | semantic | ext-auth text says the secret is in the request content. Metadata rule names `client_secret_basic` or `private_key_jwt`. `EXT-cc-2` and `EXT-cc-6` stay unresolved |
| `extensions/auth/enterprise-managed-authorization` | where the client asks for an ID-JAG | semantic | Tag docs: IdP authorization endpoint. Wiki, docs commit, and ext-auth spec: IdP token endpoint, then the resource AS token endpoint. `EXT-ema-4` stays unresolved |
| `extensions/auth/enterprise-managed-authorization` | "server indicates required" | semantic | Wiki wording is undefined. ext-auth discovery key is `authorization_grant_profiles_supported`. `EXT-ema-2` and `EXT-ema-9` stay unresolved |
| `seps/3415-events-extension.md` | status line | same | Mirror, PR head, and wiki all say Accepted. PLAN N11 still wins: draft-labeled and off. Accepted is not an implementation claim |
| `seps/3415-events-extension.md` | `Custom headers from subscription arguments` | tag-only | Present only at the PR head. Absent from the mirror and the wiki. Not selected. `EXT-events-8`, `EXT-events-9`, and `EXT-events-ERR-1` stay unresolved. Do not add a required row |
| `seps/3415-events-extension.md` | `events/list` pagination | same | `cursor` / `nextCursor` in the mirror, the PR head, and the wiki |
| `seps/3415-events-extension.md` | other normative sentences, wiki versus mirror | wording-only | Docs-site conversion. The SEP file delta against the mirror is the header subsection recorded in [PINS.md](PINS.md) |
| ext-tasks `specification/2026-07-28/tasks.md` versus `specification/draft/tasks.md` | MRTR links | wording-only | Two link targets differ (draft MRTR versus the dated MRTR path). RFC sentences, tables, and normalized fences match. The dated file is the pin |
| ext-tasks `tasks.md` versus `extensions/tasks/overview.md` | status table | wording-only | Guide table names the same five statuses. "not always honored" on `cancelled` is the spec's cooperative-cancel sentence, not a second rule. `EXT-tasks-4` and `EXT-tasks-6` are not reclassified |
| ext-skills `specification/beta/skills.mdx` versus `extensions/skills/overview.md` | guide RFC sentences | wording-only | The guide is not a mirror. All 28 guide RFC sentences restate the pinned spec, including no directory read without `directoryRead`, no prefetch, 512 files, 16 MiB, digest and size, approval binding, and `resultType` / `ttlMs` / `cacheScope` on list and get. None contradicted the spec. `EXT-skills-*` stay as the lane wrote them |
| `seps/2640-skills-extension.md` wiki versus docs mirror mdx | RFC sentences, tables, fences | wording-only | Fences match (12). Tables match (5). Two RFC keys differ only because the wiki dropped the link labels `skills/get` and `skills/list`. The obligations match |
| `seps/2640-skills-extension.md` versus ext-skills beta | host-wiring section | wiki-only | The SEP's registry-assembly prefetch ban, virtual-mount prefetch ban, "surface `directoryRead` to the model", and SDK-affordance SHOULD are not in the beta spec. The beta spec has its own no-prefetch sentence, which the guide uses. Do not encode the SEP host-wiring section. No `EXT-skills-*` row is reclassified |
| `seps/2640-skills-extension.md` versus ext-skills beta | `resultType` on list and directory-read results; request `_meta` | tag-only | In the beta spec, not in those words in the SEP. List and get `resultType` is already `EXT-skills-15` via the guide. Directory-read `resultType` has no lane row. No row is added here. SEP silence is not a deletion |
| `seps/2640-skills-extension.md` versus ext-skills beta | limits table, skill-path table, `directoryRead` settings table | same | Those three tables match. The SEP's extra field table is not a second authority over the beta spec |
| `docs/discovery.md` versus `extensions/overview.md` | stage label | semantic | Discovery doc says draft. Overview says Beta. `EXT-card-10` stays unresolved |
| `docs/discovery.md` versus `seps/2127-mcp-server-cards.md` | prefer live discovery | wording-only | SEP: if they disagree, prefer live `server/discover`. Discovery doc: verify against the live connection and prefer runtime values. `EXT-card-4` stays that reading |
| plan 9.3 versus `resources.md` List Changed Notification | template list invalidation | semantic | Spec and wiki do not name `resources/templates/list` on `resources/list_changed`. `SUB-LIST-4` stays the spec reading |
| plan N8 versus changelog major 5 | `io.modelcontextprotocol/logLevel` | semantic | Registry deprecates Logging. Changelog major 5 still describes that per-request field. `DEP-LOG-1` follows N8. Do not add a logging test from the changelog sentence |
| D5 versus `caching.md` Cache Scope | auth-context id | semantic | Spec example is a different access token. It does not say whether a refresh under the same grant is a new context. `CACHE-AUTH-1` and `AUTH-BEARER-5` stay unresolved. Fixture not authorized |
| D9 versus `elicitation.md` Error Handling | unsupported `requestedSchema` | semantic | Spec names decline, cancel, or failure to process, and does not pick one. `ELIC-FORM-2` stays unresolved. Fixture not authorized |

## Not a class

These were checked. They are missing, external, or not a pair of clauses. They are not `same`, `wording-only`, `semantic`, `wiki-only`, or `tag-only`.

- `server/prompts.mdx` has no idempotency sentence. Q8 stays open. Do not call `prompts/get` spec-idempotent.
- No `batch` match under the tagged specification tree. Q7 stays closed as absence, not as a prohibition invented here.
- RFC 9728 was read as an external text, not a wiki diff. s3.3 is the two `resource` identity checks. s7.3 is the TLS certificate check. `AUTH-PRM-3` and `AUTH-PRM-4` stay as the authorization lane wrote them.
- ext-auth EMA draft inputs (ID-JAG draft, CIMD draft, and a CIMD link aimed outside this profile) are not a wiki-versus-tag class. Not selected as a newer core baseline. Q36 stays deferred.
- Tasks guide versus `tasks.md`: 0 RFC sentences in the guide, 58 in the spec, 0 of 39 spec fences equal a guide fence. The three guide fences are commented sketches. Unpaired samples are not classified. Do not encode a fixture from a guide sketch. Coverage is not a missing-spec claim.
- Skills guide versus the beta spec: 9 of 70 spec RFC sentences share a 6-word run with the guide. The rest are not restated. That is coverage. The guide sentences that do exist are the wording-only row above. 0 of 28 spec fences equal a guide fence. Unpaired samples are not classified.
- SEP-2640 at the docs mirror in [PINS.md](PINS.md): both `seps/2640-skills-extension.md` and `docs/seps/2640-skills-extension.mdx` exist. Wiki versus the source markdown adds the rendered status table and matches the fences. That table is site chrome. Versus the beta spec, 85 of 89 SEP RFC sentences share a 6-word run with the spec; 3 of 12 SEP fences equal a beta fence. The other fences were not paired and are not classified. No separate SEP-2640 upstream SHA was pinned. The skills authority remains the ext-skills path in [PINS.md](PINS.md).
- Apps `specification/2026-01-26/apps.mdx` versus `extensions/apps/overview.md` and `extensions/apps/build.md`: neither guide has an RFC 2119 sentence (0 of 37 spec sentences). The build-guide table is install paths, not the spec dimensions table. Fence overlap is 0 (spec 45, overview 1, build 24). The guides are tutorials, not a mirror. Unpaired samples are not classified. `EXT-apps-*` are not reclassified. There is still no `specification/stable/` tree at the pinned apps commit. That path fact is Q19, not a class.
- Server-card `docs/discovery.md` versus the extensions overview and versus SEP-2127: not a mirror. The SEP says the wire format lives in the extension repo and that its snapshot is not current. Discovery has 25 RFC sentences and 7 fences; the SEP has 3 RFC sentences and no fences. Aside from the two class rows above, the sentences were not paired. `EXT-card-9` stays the discovery-doc reading of `extensionsInfo`. `EXT-card-5` cache headers were not re-diffed as a second class.
- Experimental repos: no specification file for interceptors, variants, or triggers. Tool-annotation drafts were not a requested pair. Rows stay as the extensions lane wrote them.
- OTel page and the conformance runner README are observations in [PINS.md](PINS.md), not a spec-page class. `TEL-SPAN-1` stays unresolved. No 2026-07-28 client scenario id is claimed. Q16 stays open.
- D7 is a plan choice about `pi mcp`, not a spec diff. Pi MCP sources were not read.

## Fixture gates from this pass

| Row | What must not be encoded yet |
|---|---|
| `OPS-TOOLS-13`, `OPS-PROMPT-3` | Annotation nesting from the tag embedded-resource sample |
| `OPS-TOOLS-8`, `OPS-TOOLS-9` | The calculate missing-property object as either `-32602` or `isError` |
| `HTTP-REQ-1`, `HTTP-NOGET-1` | Bytes from the authorization bearer example |
| `DEP-SAMPLING-1`, `MRTR-C-8` | The architecture diagram's sampling branch (rows already fail closed; do not invert them) |
| `CACHE-AUTH-1`, `AUTH-BEARER-5`, `ELIC-FORM-2` | D5 and D9 defaults. Unchanged |
| `EXT-cc-2`, `EXT-cc-3`, `EXT-cc-5`, `EXT-cc-6`, `EXT-ema-2`, `EXT-ema-4`, `EXT-ema-9` | Auth extension semantic rows. Unchanged |
| `EXT-events-8`, `EXT-events-9`, `EXT-events-ERR-1` | PR-head custom-header subsection. Unchanged |
| `EXT-card-10` | Draft versus Beta. Unchanged |
