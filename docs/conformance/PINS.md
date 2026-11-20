# Pins

Director pin list for Wave 0. This file records the selected revisions and their scope. Lane files and `requirements.md` point here. A pin is a kind, an id, and an observed-at time. Re-verified 2026-11-19T06:47:10Z from `git ls-remote`, `git cat-file`, `git log`, and `git show` of the named blobs. No MCP implementation, Pi MCP package, Pi adapter, or Pi diff was read.

Selected means this project uses that id as the authority named in the authority column. Observed means the id was read and is not adopted. Missing means no object was found for that name. Unverified means this pass did not open the object.

## Core profile

| Kind | Id | Observed-at | Authority / stage | Use |
|---|---|---|---|---|
| spec revision | `2026-07-28` | 2026-11-19T06:47:10Z | selected primary profile | Every `S/` row |
| spec tag, unpeeled | `5f5440bb26a62e2cf3440b92da5a667efa03b267` | 2026-11-19T06:47:10Z | selected. Commit object. `git rev-parse <tag>^{commit}` is the same SHA. `git ls-remote` refs/tags/2026-07-28 has no `^{}` peel | Authoritative core text and schema |
| spec docs path | `docs/specification/2026-07-28/*.mdx` (31 mdx files at the tag) | 2026-11-19T06:47:10Z | selected path at the tag | `git show <tag>:<path>` |
| spec schema | `schema/2026-07-28/schema.json` at the tag. `schema.ts` and `schema.mdx` are the same tree, not a second authority | 2026-11-19T06:47:10Z | selected field set | Types and error `data` shapes |
| dated-tag RC | `2026-07-28-RC` = `9d700ed62dcf86cb77475c9b81930611a9182f46` | 2026-11-19T06:47:10Z | observed, not selected | Only other `refs/tags/2026-*` tag |
| wiki docs mirror | `de3550c9fea3c5269e42ac95204eef44a2b2cb92` (frontmatter writes `de3550c9` / `docs@de3550c9fea3`) | wiki `fetched: 2026-11-16T17:54:05Z`; commit 2026-11-16 17:32:45 +0000; re-read 2026-11-19T06:47:10Z | observed reading copy. Tag is an ancestor. Docs commit is 482 commits ahead of the tag. Not authoritative over the tag | `~/vaults/JangsWiki/Wiki/mcp` |

Re-verify:

```
git ls-remote https://github.com/modelcontextprotocol/modelcontextprotocol.git 'refs/tags/2026-*'
git cat-file -t 5f5440bb26a62e2cf3440b92da5a667efa03b267
git rev-parse '5f5440bb26a62e2cf3440b92da5a667efa03b267^{commit}'
git ls-tree -r --name-only 5f5440bb26a62e2cf3440b92da5a667efa03b267 | grep -E 'docs/specification/2026-07-28/|schema/2026-07-28/schema.json'
git merge-base --is-ancestor 5f5440bb26a62e2cf3440b92da5a667efa03b267 de3550c9fea3c5269e42ac95204eef44a2b2cb92
```

`git ls-remote` on 2026-11-19 returned only `2026-07-28` and `2026-07-28-RC`. No tag dated 2026-05-19 through 2026-07-27 was listed. That is the lookback observation for D1, not a claim that an untagged revision cannot exist.

## SEP-3415

| Kind | Id | Observed-at | Authority / stage | Use |
|---|---|---|---|---|
| wiki / mirror blob | `4165cc2e580afa795842002f631edbbe17c63757` | commit 2026-11-14 20:22:44 +0000, message `SEP-3415: follow the Server Card rename to extensionsInfo`; wiki fetched 2026-11-16; re-read 2026-11-19T06:47:10Z | observed mirror. Status line `Accepted`. Not selected as a client capability | `seps/3415-events-extension.md` and wiki `seps/3415-events-extension.md` |
| upstream PR head | `60b15c16f2e7265ea34ac51099dc5be62f734692` | commit 2026-11-17 12:35:53 +0000, message `Merge main into SEP-3415 and regenerate SEP docs`; `git ls-remote` refs/pull/3415/head | observed PR head. Status line `Accepted`. Not selected. PLAN.md N11 keeps Events draft-labeled and off | Events text ahead of the mirror |

Commit distance, mirror to PR head: ahead 218, behind 0. That is `git rev-list --count`, not a line diff. The SEP file diff is `seps/3415-events-extension.md` +32/−1 and the generated `docs/seps/3415-events-extension.mdx` +32/−1. The source hunk is one `inputSchema` sentence plus the new subsection `Custom headers from subscription arguments` (x-mcp-header, `Mcp-Param-*`, `HeaderMismatch` / `-32020`). No other SEP hunk was in that diff. The wiki page has no heading `Custom headers from subscription arguments`.

Re-verify: `git ls-remote https://github.com/modelcontextprotocol/modelcontextprotocol.git refs/pull/3415/head` and `git diff --numstat 4165cc2e580afa795842002f631edbbe17c63757 60b15c16f2e7265ea34ac51099dc5be62f734692 -- seps/3415-events-extension.md`.

## Extension repositories

Each id below was `refs/heads/main` and `HEAD` on 2026-11-19T06:47:10Z. None of these repos is the dated spec tag. Stage is the directory that was present, not a guess.

| Kind | Id | Commit time and subject | Authority / stage | Selected path |
|---|---|---|---|---|
| ext-tasks | `cc9aaac1047a9440b07486e38f37060bbebeef4c` | 2026-11-04 14:09:51 -0800 `v0.2.3` | selected for Tasks. No `specification/beta/`. `specification/draft/tasks.md` differs from the dated file by two MRTR links only | `specification/2026-07-28/tasks.md` |
| ext-skills | `649f7aee87d631ac4d1fdd3b12eef0c6264fdb3a` | 2026-10-30 10:37:09 -0700 `Update implementations in docs (#162)` | selected for Skills. Beta file, not a `specification/stable/` path | `specification/beta/skills.mdx` (sibling `skills.md` exists) |
| ext-apps | `ea3e9d0e624a20bc1c51310292f09d9b8ed17161` | 2026-11-10 19:42:59 +0000 `Bump version to 2.1.0 (#854)` | selected for Apps protocol text. No `specification/stable/` tree. `specification/draft/apps.mdx` also exists and is not selected | `specification/2026-01-26/apps.mdx` |
| ext-auth | `15ca394e00a66434520b9ade26294999295a43ae` | 2026-10-23 17:24:05 +0100 `Merge pull request #37 from modelcontextprotocol/paulc/sep3392-alignment` | selected stable trees. No git tags on the repo | `specification/stable/oauth-client-credentials/2026-07-28/oauth-client-credentials.mdx` and `specification/stable/enterprise-managed-authorization/2026-07-28/enterprise-managed-authorization.mdx` |
| ext-server-card | `28db12c9b4a379489d46e49bf1bd4a991f05c9b7` | 2026-11-19 00:11:33 +0000 `feat(schema): add Remote.extensionsInfo for server-level extension information (#55)` | selected HEAD for the discovery doc and schema. `experimental-ext-server-card` `HEAD` is the same SHA. Stage is not settled: see below | `docs/discovery.md`, `schema.json` |
| server-card SEP snapshot | `526201bbc80231daa40ffcdecfc9da4e54e5dc93` | 2026-08-12T07:18:03Z `docs: add Server Card roadmap priorities (#47)` | observed, not HEAD, not selected | history only |

`docs/discovery.md` at the server-card HEAD says `Protocol Revision: draft`. Wiki `extensions/overview.md` lists Server Cards as `Beta, destination not yet stated`. `schema.json` `ServerCard` required members are `$schema`, `description`, `name`, `version`. `Remote` includes `extensionsInfo`. Those are observations. Q20 stays open. They are not a stage decision.

Stable ext-auth files are byte-identical to their `draft/` siblings except the `Protocol Revision` line (`draft` versus `2026-07-28`). The client-credentials spec has no `aud` rule. Its secret method says the secret is transmitted in the request content. Its metadata rule requires `private_key_jwt` or `client_secret_basic`. Examples use `grant_type=client_credentials` with `client_assertion` or `client_secret`. The EMA spec requests the ID-JAG at the IdP token endpoint and redeems it at the resource AS token endpoint. Discovery key is `authorization_grant_profiles_supported` containing `urn:ietf:params:oauth:grant-profile:id-jag`. It cites ID-JAG draft `-04`, CIMD draft `-01`, and a CIMD link under `/specification/2025-11-25/`. Core `basic/authorization/index.mdx` at the dated tag cites CIMD draft `-00`. Those deltas are recorded in `RECONCILIATION.md`. They are not resolved choices.

SEP-2640 in the wiki (`seps/2640-skills-extension.md`) carries the docs mirror id above. No separate SEP-2640 upstream SHA was resolved in this pass. The Skills pin is ext-skills, not that SEP file.

## Experimental inventory (observed, not selected)

| Kind | Id | Commit time and subject | What was present |
|---|---|---|---|
| experimental-ext-interceptors | `d7f84d8c7759b6b0564071d71228f9b37c0c854d` | 2026-11-17 16:43:16 +0100 `TypeScript SDK: pin vite to 7.x so npm 10 can install vitest 4 (#48)` | no `specification/` tree. `docs/sep.md` present. Not adopted |
| experimental-ext-variants | `cfc05d6f5eb8829f9896d44a6d47360bd15c3b5c` | 2026-05-29 09:17:04 +0100 `fix: merge Extensions in unionCapabilities (#9)` | README and SDK trees. No specification file. Not adopted |
| experimental-ext-tool-annotations | `fecace78a9552f70ba735d750fc3c4b190e20429` | 2026-08-12 09:24:38 +0200 `Merge pull request #8 from modelcontextprotocol/docs/next-spec-priorities` | `specification/draft/action-metadata.mdx` and `specification/draft/trust-annotations.mdx`. Not requested, not adopted |
| experimental-ext-triggers-events | `47d95c979faa73427e1f6e0ac0c1347559d8ea37` | 2026-11-12 13:04:24 -0800 `Point CODEOWNERS at tasks-events-wg (#15)` | README only in the filtered listing. Not a second Events spec |

Re-verify any row with `git ls-remote https://github.com/modelcontextprotocol/<repo>.git HEAD`.

## OpenTelemetry and the conformance runner

| Kind | Id | Observed-at | Authority / stage | Use |
|---|---|---|---|---|
| semantic-conventions-genai | `76e0c19e7fe11dc693fe258642363a438af4d3aa` | 2026-11-19 01:34:29 +0000 `Lock file maintenance (#701)`. Re-read 2026-11-19T06:47:10Z | observed only. Page status Development. `CHANGELOG.md` has an Unreleased section and no release section. `git ls-remote` refs/tags returned no tags | `docs/gen-ai/mcp.md`. Not a baseline |
| conformance release | tag `v0.1.16` = `21a9a2febd7100d7c17ac1021ee7f2ed9f66a1e0` | 2026-03-27 11:29:13 +0000 `chore: bump version to 0.1.16 (#198)`. No `^{}` peel | superseded black-box release pin. README has no `2026-07-28`. Client example is `--scenario initialize` | Do not treat this tag as a 2026-07-28 scenario catalog |
| conformance main | `@modelcontextprotocol/conformance` `0.2.0-alpha.12` at `96a6f9478b7f2e125cf0360a213383cf57533893` | 2026-11-10 17:49:31 +0000 `chore(sep-2640): repoint the requirements at the Skills beta page (#511)` | selected black-box runner for G12; use this commit, not a moving `main` | `requirements/2026-07-28.yaml` lists 32 required client scenarios. The README and `SDK_INTEGRATION.md` describe how to run them |

Span text observed on the OTel page and not adopted: span name SHOULD be `{mcp.method.name} {target}` when a low-cardinality target exists, otherwise `{mcp.method.name}`.

## Pi metadata

Read from the install manifest and `git -C ~/pi` only. The MCP package, its changes, and adapters were not opened.

| Kind | Id | Observed-at | Authority / stage | Use |
|---|---|---|---|---|
| installed build | directory `next-7d80b45f62f8`; `pi --version` prints `1.5.2`; package `@earendil-works/pi-coding-agent` version `1.5.2`; `engines.node` `>=22.19.0` | 2026-11-19T06:47:10Z | selected adapter target once Wave 3 starts. Not a Wave 0 code change | D3 |
| checkout HEAD | `7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec` on branch `next`, subject `Merge branch 'fork/tooling' into next`, 2026-11-19 01:47:24 +0000 | 2026-11-19T06:47:10Z | selected. Same build id as the install | D3 |
| PLAN.md checkout | `e903c27bbd864a81f40941ae1d93b42585b20c6d` | 2026-11-18 19:57:21 +0000 | observed, not selected. Not an ancestor of HEAD. `e903c27bb..HEAD` is 105. `HEAD..e903c27bb` is 94 | Q28 closed by not selecting it |
| Pi extension API names | none | — | unverified. Not read | Q21 |

Local `node --version` at the same time was `v26.13.1`. That is the machine, not a library baseline.

## Not pinned

- The catalog’s `not_scored` client entries (extension and `added-after-release` scenarios) do not count toward core conformance.
- No OTel release tag.
- No ext-auth git tag. The stable directory revision above is the pin.
- SEP-2640 has no upstream SHA beyond the wiki docs mirror.
- Wiki `schema.json` is missing. The tag file is the field set.
- Events custom-header subsection is not a selected requirement.
