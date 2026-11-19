# Gate status

- Gate SHA: `b11881eddfceb8b9fa537d2d1340d15b37a4e42d`
- Date: 2026-11-19T22:31:43.424Z (from report `generatedAt`)
- Command: `npm run gate` (`bash scripts/gate.sh`), exit 1, `BLOCKED`
- Release eligible: **no**
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
| wire-scan | pass | clean (261 transcripts, 629 client frames); DCR detection depends on endpoint metadata |
| network-scan | pass | clean (261 transcripts, loopback only) |
| secret-scan | pass | clean (261 transcripts, 0 logs) |
| official | **fail** | ok=false total=? (exit 1) |
| removal | pass | 8 extensions removable |
| evidence | pass | lock 86ec5d55e5e5 pins 1bd5c34a5f38 |

## Blockers (verbatim from report)

- `official: ok=false total=? (exit 1)`
- `requirements: 164 required/deprecated/excluded rows not pass (missing/fail)`
- `G12: fail (suite official, evidence)`

## officialBlockedReason

`ok=false total=? (exit 1)`

G12 is blocked by Q16 (official suite deferred) per director decision, option A: the official suite fails closed.

## Removal

All 8 exit 0: ext-apps, ext-client-credentials, ext-enterprise-auth, ext-events, ext-events-webhook, ext-server-cards, ext-skills, ext-tasks.

## Requirement rows

610 rows: 381 pass, 0 fail, 229 missing.

| Disposition | pass | missing |
|---|---|---|
| required | 269 | 147 |
| deprecated | 0 | 6 |
| excluded | 8 | 11 |
| active-optional | 57 | 11 |
| conditional | 46 | 7 |
| unresolved | 0 | 29 |
| out-of-scope | 1 | 18 |

164 required/deprecated/excluded rows lack a pass (all `missing`):

- WIRE-DIR-1 (required, missing)
- WIRE-DIR-2 (required, missing)
- WIRE-META-4 (required, missing)
- WIRE-META-5 (required, missing)
- WIRE-ERR-2 (required, missing)
- WIRE-CANCEL-1 (required, missing)
- WIRE-TO-2 (required, missing)
- WIRE-STATE-1 (required, missing)
- WIRE-STATE-2 (required, missing)
- HTTP-SSEOLD-1 (excluded, missing)
- HTTP-CASE-1 (required, missing)
- HTTP-PARAM-5 (required, missing)
- HTTP-NOTIF-1 (required, missing)
- HTTP-RESP-3 (required, missing)
- HTTP-RESP-4 (required, missing)
- HTTP-ERR-2 (required, missing)
- HTTP-ERR-5 (required, missing)
- HTTP-ERR-6 (required, missing)
- HTTP-ERR-7 (required, missing)
- HTTP-SSE-2 (required, missing)
- HTTP-SSE-6 (required, missing)
- HTTP-SSE-7 (required, missing)
- HTTP-SSE-8 (required, missing)
- HTTP-AMBIG-3 (required, missing)
- HTTP-AMBIG-4 (required, missing)
- HTTP-AMBIG-5 (required, missing)
- HTTP-LIMIT-1 (required, missing)
- HTTP-LIMIT-2 (required, missing)
- HTTP-LIMIT-3 (required, missing)
- API-OUT-1 (required, missing)
- LIM-CONC-1 (required, missing)
- LIM-SUB-1 (required, missing)
- LIM-SUB-2 (required, missing)
- LIM-PROG-1 (required, missing)
- LIM-DIAG-1 (required, missing)
- EDGE-2 (required, missing)
- EDGE-3 (required, missing)
- EDGE-4 (required, missing)
- EDGE-5 (required, missing)
- EDGE-7 (required, missing)
- EDGE-10 (required, missing)
- EDGE-11 (required, missing)
- EDGE-12 (required, missing)
- EDGE-13 (required, missing)
- EDGE-14 (required, missing)
- EDGE-15 (required, missing)
- EDGE-16 (required, missing)
- EDGE-17 (required, missing)
- EDGE-18 (required, missing)
- EDGE-19 (required, missing)
- EDGE-20 (required, missing)
- EDGE-21 (required, missing)
- EDGE-22 (required, missing)
- EDGE-23 (required, missing)
- EDGE-24 (required, missing)
- EDGE-25 (required, missing)
- EDGE-26 (required, missing)
- EDGE-27 (required, missing)
- EDGE-28 (required, missing)
- EDGE-29 (required, missing)
- EDGE-30 (required, missing)
- EDGE-31 (required, missing)
- EDGE-34 (required, missing)
- EDGE-35 (excluded, missing)
- EDGE-36 (required, missing)
- EDGE-37 (required, missing)
- EDGE-38 (required, missing)
- EDGE-39 (required, missing)
- EDGE-40 (required, missing)
- DISC-1 (required, missing)
- OPS-TOOLS-4 (required, missing)
- OPS-TOOLS-6 (required, missing)
- OPS-TOOLS-15 (required, missing)
- OPS-TOOLS-16 (required, missing)
- OPS-RES-5 (required, missing)
- DEP-CONFIRM-1 (required, missing)
- DEP-ROOTS-1 (deprecated, missing)
- DEP-SAMPLING-1 (deprecated, missing)
- DEP-INCLUDECTX-1 (deprecated, missing)
- DEP-LOG-1 (deprecated, missing)
- DEP-DCR-1 (deprecated, missing)
- DEP-HTTPSSE-1 (deprecated, missing)
- MRTR-LOOP-2 (required, missing)
- ELIC-REM-1 (excluded, missing)
- SUB-CHANGE-1 (required, missing)
- SUB-END-3 (required, missing)
- SUB-OLD-1 (excluded, missing)
- CACHE-SF-1 (required, missing)
- CACHE-LIMIT-1 (required, missing)
- CACHE-STORE-1 (required, missing)
- CACHE-OBS-1 (required, missing)
- AUTH-PRM-4 (required, missing)
- AUTH-THEFT-1 (required, missing)
- AUTH-401-1 (required, missing)
- AUTH-401-2 (required, missing)
- AUTH-SSRF-3 (required, missing)
- AUTH-SSRF-4 (required, missing)
- AUTH-SSRF-5 (required, missing)
- AUTH-SSRF-6 (required, missing)
- AUTH-URL-2 (required, missing)
- AUTH-SEP-1 (required, missing)
- CONSENT-5 (required, missing)
- CONSENT-7 (required, missing)
- EXT-REG-1 (required, missing)
- EXT-STREAM-1 (required, missing)
- EXT-PIN-1 (required, missing)
- EXT-STAGE-1 (required, missing)
- EXT-STAGE-2 (required, missing)
- EXT-PORT-1 (required, missing)
- EXT-apps-BRIDGE (excluded, missing)
- EXT-EXP-INTERCEPT (excluded, missing)
- EXT-EXP-TOOLANN (excluded, missing)
- EXT-EXP-TRIGGERS (excluded, missing)
- EXT-EXP-FUTURE (excluded, missing)
- ARCH-REQ-1 (required, missing)
- ARCH-REQ-2 (required, missing)
- ARCH-REQ-3 (required, missing)
- ARCH-LIFE-1 (required, missing)
- ARCH-STATE-1 (required, missing)
- ARCH-SF-1 (required, missing)
- ARCH-DEP-1 (required, missing)
- ARCH-DEP-2 (required, missing)
- ARCH-DEP-3 (required, missing)
- FIX-1 (required, missing)
- FIX-2 (required, missing)
- FIX-3 (required, missing)
- FIX-4 (required, missing)
- FIX-5 (required, missing)
- GATE-1 (required, missing)
- GATE-2 (required, missing)
- GATE-3 (required, missing)
- GATE-4 (required, missing)
- GATE-5 (required, missing)
- GATE-6 (required, missing)
- GATE-7 (required, missing)
- PICA-1 (required, missing)
- PICA-2 (required, missing)
- PICA-3 (required, missing)
- PICA-4 (required, missing)
- PICA-5 (required, missing)
- PICA-6 (required, missing)
- PICA-7 (required, missing)
- PICA-8 (required, missing)
- PICA-9 (required, missing)
- PICA-10 (required, missing)
- PICA-11 (required, missing)
- PICA-12 (required, missing)
- PICA-13 (required, missing)
- PICA-14 (required, missing)
- PICD-1 (required, missing)
- PICD-2 (required, missing)
- PICD-3 (required, missing)
- PICD-4 (required, missing)
- PICD-5 (required, missing)
- PICD-6 (required, missing)
- PICD-7 (required, missing)
- PICD-8 (required, missing)
- PICD-9 (required, missing)
- CUT-PI-MCP-1 (required, missing)
- CUT-ROLLBACK-1 (required, missing)
- LIFE-1 (excluded, missing)
- LIFE-2 (excluded, missing)
- LIFE-3 (required, missing)
- SEC-LOG-1 (required, missing)
