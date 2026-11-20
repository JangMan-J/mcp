# Pi adapter target pin (D3)

Wave 3 slice S3.0 record. This file fixes the exact Pi fork revision the Coding
Agent adapter and the durable adapter are built and accepted against. It is a
decision record, not a build: nothing here changes Pi, the active config, or
any package. Sources: `docs/conformance/PINS.md` ("Pi metadata") and
`docs/conformance/DECISIONS.md` (D3, Q21, Q28), salvaged at commit
`1d30a252739e3c1be36ed394043b7456621a7bc3`. Observations were taken
2026-11-19T06:47:10Z from the install manifest and `git -C ~/pi` only; the MCP
package, its changes, and adapters were not opened.

## Selected pin

| Kind | Id | Notes |
|---|---|---|
| Installed build | directory `next-7d80b45f62f8` | `pi --version` prints `1.5.2`; package `@earendil-works/pi-coding-agent` version `1.5.2`; `engines.node` `>=22.19.0` |
| Checkout HEAD | `7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec` on branch `next` | subject `Merge branch 'fork/tooling' into next`, 2026-11-19 01:47:24 +0000. Same build id as the install |

Decision (D3, answered): the adapter target is the checkout HEAD above. It
matches the installed build recorded in PINS.md, so acceptance runs against the
pinned revision exercise the same code the user runs.

Local `node --version` at observation time was `v26.13.1`. That is the machine,
not a library baseline; D2's floor is Node >= 22.

## Rejected candidate

| Kind | Id | Why rejected |
|---|---|---|
| PLAN.md checkout | `e903c27bbd864a81f40941ae1d93b42585b20c6d` (2026-11-18 19:57:21 +0000) | Divergent line, not an ancestor of HEAD: `e903c27bb..HEAD` is 105 commits, `HEAD..e903c27bb` is 94. Observed, not selected. Q28 is closed by not selecting it |

## Open verification before adapter code (Q21, deferred)

The Pi extension API names were not re-read in the pin pass. Before any adapter
code is written, verify against the pinned checkout only:

- exact extension API names/types (`ToolDefinition.exposure`, `reachesTools`
  signature, `registerToolRenderer`),
- how a replacement extension declares it replaces `builtin:mcp`,
- whether `pi mcp` can be served by an extension at all (see
  `docs/cutover.md`: it cannot, per `main.ts:659-663`),
- the durable `ToolTask` lifecycle hooks an MCP bridge needs.

Requirement rows `PICA-1, -2, -5, -6, -7, -9, -10` stay blocked on this read.

## Re-verify

```
git -C ~/pi rev-parse HEAD                      # expect 7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec
git -C ~/pi log -1 --format='%ci %s' HEAD
git -C ~/pi merge-base --is-ancestor e903c27bbd864a81f40941ae1d93b42585b20c6d HEAD; echo $?
git -C ~/pi rev-list --count e903c27bbd864a81f40941ae1d93b42585b20c6d..HEAD   # 105 at pin time
git -C ~/pi rev-list --count HEAD..e903c27bbd864a81f40941ae1d93b42585b20c6d   # 94 at pin time
pi --version                                    # expect 1.5.2 from next-7d80b45f62f8
```

If HEAD has moved when Wave 3 starts, the pin is still
`7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec`: check out that revision for
acceptance, or re-run the pin pass and record a new decision row. Do not
retarget silently.
