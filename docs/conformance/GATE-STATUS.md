# Gate status

## M3 integrated verification

**Not release eligible.** `npm run gate` exited 1 (`BLOCKED`) at commit `6b9f8217d031c1c4a44805998c39b8bef131d742`. The report (`reports/gate-6b9f8217d031c1c4a44805998c39b8bef131d742.json`, generated 2026-11-19T23:35:16.618Z, not committed) records 520/610 requirement rows passing, 0 failing and 90 missing. G1–G11 passed. G12 was blocked on the official suite; its evidence suite passed.

`npm run build`, `npm test`, `npm run req:build`, `npm run check:deps`, `npm run check:forbidden`, `npm run check:deps-doc`, and `npm run check:coverage` all exited 0. Vitest passed 977 tests in 83 files. Coverage checked 610 requirements and 265 fixtures with no errors. `check:deps` reported no violations but warned that dependency-cruiser may miss dependencies with TypeScript 7.0.

**Official scenarios: not run.** The local wrapper (`node packages/conformance/dist/cli.js official --json`) exited 1 with `checkout-missing` and an empty `scenarios` array. `MCP_CONFORMANCE_CHECKOUT` was unset and `.cache/conformance/checkout` was absent. This is a missing prerequisite, not a failed scenario. To run the official suite, provide a clean local checkout at `96a6f9478b7f2e125cf0360a213383cf57533893` with its built executable and dependencies, at that path or via `MCP_CONFORMANCE_CHECKOUT`. No upstream source was fetched or inspected for this verification.

At this commit the gate records `official: ok=false total=? (exit 1)` rather than the wrapper’s diagnosis: it expects `total` and `reason`, but the wrapper returns `scenarios`, `blocked`, and `reasons`. Providing the checkout alone does not correct this reporting mismatch.

## Historical gate report (`3aca8af`)

- Gate SHA: `3aca8afc05a5e20bcf2fcd49a2c1d422f482b271`
- Date: 2026-11-19T23:15:51.296Z (from report `generatedAt`)
- Command: `npm run gate` (`bash scripts/gate.sh`), exit 1, `BLOCKED`
- Report: `reports/gate-3aca8afc05a5e20bcf2fcd49a2c1d422f482b271.json` (not committed)
- Release eligible: **no**
- Claim (verbatim): "Not release eligible: 520/610 requirement rows pass (416/441 required/deprecated/excluded; 0 fail, 90 missing); gate items 11/12 pass. Claims are limited to the passing rows."
- Env: node v26.13.1, linux 6.18.60-2-cachyos-lts x64; lockfile sha256 86ec5d55e5e5…, pins sha256 1bd5c34a5f38…

### Gate items

| Item | Status | Detail |
|---|---|---|
| G1 | pass | suite baseline, mutation; stdio/concurrent-out-of-order 1 pass; sub/two-listeners-demux* 3 pass; omitted (no fixture): edge/EDGE-1, arch/close-settles-all, stdio/legacy-peer-diagnostic, consent/* |
| G2 | pass | wire/cancel* 3 pass; http/abort-closes-stream 1; stdio/shutdown-escalation 1; stdio/cancel-inflight 1; same omitted list as G1 |
| G3 | pass | elic/* 5 pass |
| G4 | pass | auth/* 64 pass |
| G5 | pass | cache/* 16 pass |
| G6 | pass | sub/* 17 pass |
| G7 | pass | stdio/crash-* 1; http/stream-break-* 2; http/5xx-write-uncertain 1 |
| G8 | pass | ops/* 38 pass; wire/* 14 pass |
| G9 | pass | ver/* 8 pass; http/400-modern-error-vs-legacy 1 |
| G10 | pass | suite removal; ext/* 39 pass |
| G11 | pass | suites no-pi, wire-scan, network-scan, secret-scan |
| G12 | **fail** | suites official, evidence (only official failed) |

### Suites

| Suite | Result | Detail |
|---|---|---|
| no-pi | pass | exit 0 (assert-no-pi: ok) |
| baseline | pass | 265/265 passed |
| mutation | pass | 342/342 killed |
| coverage | pass | ok=true |
| wire-scan | pass | clean (261 transcripts, 629 client frames); DCR detection relies on `endpoint:'registration'` metadata |
| network-scan | pass | clean (261 transcripts, loopback only) |
| secret-scan | pass | clean (261 transcripts, 0 logs) |
| official | **fail** | ok=false total=? (exit 1) |
| removal | pass | 8 extensions removable |
| unit | pass | success=true tests=975 failed=0 tagged=163 |
| validate | pass | check:deps-doc, check:forbidden, check:deps exit 0 |
| evidence | pass | lock 86ec5d55e5e5 pins 1bd5c34a5f38 |

The `npm test` race seen in the previous run (`req-ext.test.ts` enumerated `packages/` with `readdir` and picked up a transient `packages/ext-dummy` created by the removal check) is fixed in `3aca8af`: the test now uses the explicit `ALL_EXTENSIONS` list from `packages/conformance/src/gate.ts`.

### Blockers (verbatim from report)

- `official: ok=false total=? (exit 1)`
- `G12: fail (suite official, evidence)`

The previous `requirements: … rows not pass` blocker is gone: the only required/deprecated/excluded rows without a pass are the Wave 3 non-claims below, which the gate does not count as blockers.

### officialBlockedReason

`ok=false total=? (exit 1)`

G12 is blocked by Q16 (official suite deferred) per director decision, option A: the official suite fails closed.

### Removal

All 8 exit 0: ext-apps, ext-client-credentials, ext-enterprise-auth, ext-events, ext-events-webhook, ext-server-cards, ext-skills, ext-tasks.

### Requirement rows

610 rows: 520 pass, 0 fail, 90 missing.

| Disposition | pass | missing |
|---|---|---|
| required | 391 | 25 |
| deprecated | 6 | 0 |
| excluded | 19 | 0 |
| active-optional | 57 | 11 |
| conditional | 46 | 7 |
| unresolved | 0 | 29 |
| out-of-scope | 1 | 18 |

Required/deprecated/excluded: 416/441 pass. The 25 without a pass are all `required`, all `missing`, and are exactly the Wave 3 non-claims (post-gate, PLAN §15; not built before the gate):

PICA-1 … PICA-14, PICD-1 … PICD-9, CUT-PI-MCP-1, CUT-ROLLBACK-1.

### Non-claims (from report)

- Unresolved rows (no claim): STDIO-SHUT-2, STDIO-ENV-1, HTTP-NOTIF-2, HTTP-LIMIT-4, TEL-SPAN-1, ELIC-FORM-2, SUB-CAP-1, SUB-AUTH-1, CACHE-AUTH-1, AUTH-CONT-1, AUTH-BEARER-5, EXT-cc-PIN, EXT-cc-1, EXT-cc-2, EXT-cc-3, EXT-cc-5, EXT-cc-6, EXT-ema-PIN, EXT-ema-1, EXT-ema-2, EXT-ema-4, EXT-ema-7, EXT-ema-8, EXT-ema-9, EXT-card-10, EXT-events-8, EXT-events-9, EXT-events-ERR-1, EXT-EXP-VARIANTS.
- Out-of-scope rows (listed, not checked): HTTP-SRV-ORIGIN-1, HTTP-SRV-BIND-1, HTTP-SRV-AUTH-1, HTTP-SRV-NOTIF-1, HTTP-SRV-SSE-1, HTTP-SRV-ACCEL-1, HTTP-SRV-FWD-1, HTTP-SRV-VAL-1, HTTP-SRV-GET-1, HTTP-SRV-SESS-1, HTTP-SRV-RESUME-1, AUTH-SRV-1 … AUTH-SRV-7, EXT-ema-10.
- Non-required rows without passing evidence: WIRE-TO-3, HTTP-PARAM-3, OPS-TOOLS-17, OPS-COMP-3, OPS-SCHEMA-5, ELIC-URL-8, ELIC-SEC-1, CACHE-POLL-1, AUTH-REG-6, AUTH-SSRF-7, CONSENT-8, EXT-events-28, SEC-ICON-1 … SEC-ICON-5, SEC-ARGS-1.
- No Pi runtime integration claim (gate runs with Pi excluded); no interoperability claim beyond the official suite; no performance, load, or security-audit claims.

### Evidence notes

- How rows pass: exchange fixtures; Vitest tests whose title carries `[REQ-ID]` (read from the gate's `unit` suite, vitest JSON written in the prereq stage; passed only, skipped ignored); suite-backed rows via `SUITE_REQUIREMENT_EVIDENCE` in `packages/conformance/src/gate.ts` (FIX-1 coverage, FIX-2 mutation, GATE-1 no-pi, GATE-2 coverage, GATE-4 wire-scan, ARCH-DEP-1..3 validate).
- Implemented in this change: HTTP-AMBIG-3/4 (`RequestOptions.acceptDuplicate`/`retryOf`, `UncertainWrite.taskHandle`); EDGE-27 (`MrtrOptions.transportClosed`: nothing in the library passes it yet, so a host or adapter must wire transport close to it); LIM-CONC-1 (FIFO admission queue over 256 in flight); LIM-PROG-1 (50 callbacks per 1000 ms sliding window, coalesced, last value flushed before settlement; not strict 20 ms spacing, which would break fixture `prog/non-monotonic`); LIM-SUB-1 (cap 8 listen streams; `change()` at the cap throws because it opens the new listener before closing the old).
- Weaker evidence: EXT-STAGE-1/2 are static checks only; EXT-STREAM-1 allows ext-tasks to import `elicit` from `@mcp-client/mrtr-cache` (open question whether that counts as core-only); EDGE-5 tests cancel-after-settle on a fake transport; EDGE-38 holds because waiters with different abort signals take separate flights; HTTP-SSE-7 second-response diagnostic in `handleSse` is unreachable (test asserts first response wins); HTTP-LIMIT-2 a single unterminated SSE data line buffers until complete; AUTH-SEP-1 uses a stub auth provider; DEP-CONFIRM-1 wire-scan has no explicit HTTP+SSE rule (absence covered by DEP-HTTPSSE-1 test).
