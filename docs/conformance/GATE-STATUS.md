# Gate status

- Gate SHA: `3aca8afc05a5e20bcf2fcd49a2c1d422f482b271`
- Date: 2026-11-19T23:15:51.296Z (from report `generatedAt`)
- Command: `npm run gate` (`bash scripts/gate.sh`), exit 1, `BLOCKED`
- Report: `reports/gate-3aca8afc05a5e20bcf2fcd49a2c1d422f482b271.json` (not committed)
- Release eligible: **no**
- Claim (verbatim): "Not release eligible: 520/610 requirement rows pass (416/441 required/deprecated/excluded; 0 fail, 90 missing); gate items 11/12 pass. Claims are limited to the passing rows."
- Env: node v26.13.1, linux 6.18.60-2-cachyos-lts x64; lockfile sha256 86ec5d55e5e5…, pins sha256 1bd5c34a5f38…

## Gate items

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

## Suites

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

## Blockers (verbatim from report)

- `official: ok=false total=? (exit 1)`
- `G12: fail (suite official, evidence)`

The previous `requirements: … rows not pass` blocker is gone: the only required/deprecated/excluded rows without a pass are the Wave 3 non-claims below, which the gate does not count as blockers.

## officialBlockedReason

`ok=false total=? (exit 1)`

G12 is blocked by Q16 (official suite deferred) per director decision, option A: the official suite fails closed.

## Removal

All 8 exit 0: ext-apps, ext-client-credentials, ext-enterprise-auth, ext-events, ext-events-webhook, ext-server-cards, ext-skills, ext-tasks.

## Requirement rows

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

## Non-claims (from report)

- Unresolved rows (no claim): STDIO-SHUT-2, STDIO-ENV-1, HTTP-NOTIF-2, HTTP-LIMIT-4, TEL-SPAN-1, ELIC-FORM-2, SUB-CAP-1, SUB-AUTH-1, CACHE-AUTH-1, AUTH-CONT-1, AUTH-BEARER-5, EXT-cc-PIN, EXT-cc-1, EXT-cc-2, EXT-cc-3, EXT-cc-5, EXT-cc-6, EXT-ema-PIN, EXT-ema-1, EXT-ema-2, EXT-ema-4, EXT-ema-7, EXT-ema-8, EXT-ema-9, EXT-card-10, EXT-events-8, EXT-events-9, EXT-events-ERR-1, EXT-EXP-VARIANTS.
- Out-of-scope rows (listed, not checked): HTTP-SRV-ORIGIN-1, HTTP-SRV-BIND-1, HTTP-SRV-AUTH-1, HTTP-SRV-NOTIF-1, HTTP-SRV-SSE-1, HTTP-SRV-ACCEL-1, HTTP-SRV-FWD-1, HTTP-SRV-VAL-1, HTTP-SRV-GET-1, HTTP-SRV-SESS-1, HTTP-SRV-RESUME-1, AUTH-SRV-1 … AUTH-SRV-7, EXT-ema-10.
- Non-required rows without passing evidence: WIRE-TO-3, HTTP-PARAM-3, OPS-TOOLS-17, OPS-COMP-3, OPS-SCHEMA-5, ELIC-URL-8, ELIC-SEC-1, CACHE-POLL-1, AUTH-REG-6, AUTH-SSRF-7, CONSENT-8, EXT-events-28, SEC-ICON-1 … SEC-ICON-5, SEC-ARGS-1.
- No Pi runtime integration claim (gate runs with Pi excluded); no interoperability claim beyond the official suite; no performance, load, or security-audit claims.
