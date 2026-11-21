import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const doc = readFileSync(join(root, "docs/cutover.md"), "utf8");
const lower = doc.toLowerCase();

function contains(re: RegExp, msg?: string): void {
  expect(doc, msg ?? String(re)).toMatch(re);
}
function notContains(re: RegExp, msg?: string): void {
  expect(doc, msg ?? `should not contain ${re}`).not.toMatch(re);
}

describe("[CUT-PI-MCP-1] standalone pi mcp direction", () => {
  it("[CUT-PI-MCP-1] direction is A: leave on old stack, with D7 and R15", () => {
    contains(/CUT-PI-MCP-1/);
    contains(/D7/);
    contains(/\bA for the first adapter\b/);
    contains(/Leave `pi mcp` on the old implementation/);
    // consequence: two stacks coexist
    contains(/two MCP stacks coexist/i);
    // option C as optional bin, B only later
    contains(/adapters\/pi-coding-agent\/bin\/mcp-cli/);
    contains(/B only as a later,\s*\n?separate cutover/i);
    // Pi mechanism for separation
    contains(/-builtin:mcp/);
    contains(/package-manager\.ts:1075/);
    contains(/main\.ts:659-663/);
    contains(/R15/);
    // self-check: alternative directions not selected
    notContains(/\bDecision.*:\s*B\b.*first adapter/i);
  });

  it("[CUT-PI-MCP-1] scope: extension does not block adapter, docs are coexisted not switched", () => {
    contains(/does\s+not block it/i);
    contains(/kept separate by the `-builtin:mcp` mechanism/i);
    contains(/namespaced session state/i);
  });
});

describe("[CUT-ROLLBACK-1] one-edit rollback ordering and isolated credentials", () => {
  it("[CUT-ROLLBACK-1] rollback is a single settings edit removing both entries in that order", () => {
    contains(/rollback.*single settings edit/i);
    contains(/single edit/i);
    // ordering: step 1 is remove adapter entry and -builtin:mcp together, step 2 is start Pi
    const idxSingle = lower.indexOf("single edit");
    const idxRemove = doc.indexOf("Remove the adapter entry and `-builtin:mcp`");
    const idxStart = doc.indexOf("Start Pi; confirm the built-in MCP stack comes back");
    expect(idxRemove, "remove step present").toBeGreaterThan(-1);
    expect(idxStart, "start Pi step present").toBeGreaterThan(-1);
    expect(idxRemove).toBeLessThan(idxStart);
    // cutover enables with -builtin:mcp, rollback removes it — ordering is symmetric
    contains(/Enable the adapter in the active config with `-builtin:mcp`/);
  });

  it("[CUT-ROLLBACK-1] side-by-side uses scratch dir and -builtin:mcp only in scratch", () => {
    contains(/scratch.*Pi agent directory/i);
    contains(/never the active\s*\n?config/i);
    contains(/scratch settings only/);
    contains(/active config keeps its built-in stack/);
    contains(/name clash\s*`mcp__\*/);
  });

  it("[CUT-ROLLBACK-1] isolated credential path: separate store, mcp-auth.json untouched", () => {
    contains(/Isolated credentials/i);
    contains(/its own credential store file/i);
    contains(/mcp-auth\.json/);
    contains(/not read, modified, or copied/i);
    contains(/sign-ins[\s\S]*unaffected/i);
    // also in rollback drill
    contains(/was never touched, so the old\s*\n?stack's tokens are intact/i);
    // must not claim shared store
    notContains(/shares? the same credential/i);
    notContains(/copies? mcp-auth\.json into the adapter/i);
  });

  it("[CUT-ROLLBACK-1] no residue: namespaced session entries ignored", () => {
    contains(/no residue/i);
    contains(/namespaced/);
    contains(/ignored by the old stack/);
    contains(/indistinguishable from one that never had the adapter/i);
  });
});

describe("[CUT-ROLLBACK-1] required abort conditions", () => {
  const ABORTS = [
    /uncertain-write.*rendering bug/i,
    /credential material in logs/i,
    /unbounded memory growth/i,
  ];
  it("[CUT-ROLLBACK-1] all three abort conditions present verbatim", () => {
    for (const re of ABORTS) contains(re, `missing abort condition ${re}`);
  });
  it("[CUT-ROLLBACK-1] abort triggers immediate rollback via single edit", () => {
    contains(/Roll back immediately/);
    contains(/Rollback is the single settings edit above/i);
    contains(/there is no data migration to undo/i);
  });
  it("[CUT-ROLLBACK-1] self-check: missing abort is flagged", () => {
    const stub = "uncertain-write rendering bug, credential material in logs";
    for (const re of ABORTS) {
      const hit = re.test(stub);
      // unbounded memory growth missing should be false
      if (re.source.includes("unbounded")) expect(hit).toBe(false);
      else expect(hit).toBe(true);
    }
  });
});

describe("avoid claims of live drill", () => {
  it("states the scratch trial and scratch rollback drill ran at the pin", () => {
    contains(/side-by-side trial and\s+the rollback drill ran in a disposable scratch directory at the pinned Pi\s+revision/i);
    contains(/Side-by-side trial and rollback drill record \(scratch, 2026-11-21\)/);
    contains(/scripts\/pi-trial/);
    contains(/7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec/);
    contains(/never modified/i);
    contains(/nothing changes the Pi fork/i);
    contains(/Each remaining step\s+becomes executable only when its pre-conditions are met and the director\s+authorizes it/i);
  });
  it("states cutover, active-config rollback and observation window are not done", () => {
    contains(/cutover, a rollback in the active config, and the\s+observation window have not been executed/i);
    contains(/Not done: cutover in the active config, rollback in the active config, and the\s+observation window/i);
    contains(/Pre-condition 1 \(gate report for SHA X\) is not yet met/i);
  });
  it("does not claim a live or active-config cutover, rollback, or observation window", () => {
    notContains(/cutover was performed/i);
    notContains(/rollback was executed in the active config/i);
    notContains(/active config was switched/i);
    notContains(/observation window (was|has been) (run|executed|completed|observed)/i);
    notContains(/drill was run in the active/i);
    notContains(/trial was successful/i);
  });
  it("[CUT-ROLLBACK-1] record shows the one-edit rollback drill passed in scratch", () => {
    contains(/Rollback drill: one edit of scratch `settings\.json` removing both entries; the new session has `builtin:mcp` back and the adapter gone \| pass/);
    contains(/Rollback drill \(rehearsed in scratch on 2026-11-21; not run in the active config\)/);
    contains(/No `mcp-auth\.json` was created \| pass/);
  });
});

describe("legacy schema compatibility table (pinned source shape)", () => {
  it("has heading with pinned revision and source files", () => {
    contains(/Schema compatibility.*pinned source/i);
    contains(/packages\/mcp\/src\/config\.ts/);
    contains(/packages\/coding-agent\/src\/core\/mcp-servers\.ts/);
    contains(/7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec/);
    contains(/validateMcpServerConfig/);
    contains(/Unknown fields are kept unchecked/i);
  });

  it("table contains every parser-validated field row", () => {
    const requiredRows = [
      "`command`",
      "`args`",
      "`env`",
      "`cwd`",
      "`url`",
      "`headers`",
      "`type`",
      "`enabled`",
      "`description`",
      "`timeout`",
      "`oauth.clientId`",
      "`oauth.clientSecret`",
      "`oauth.callbackPort`",
      "`oauth.callbackUrl`",
      "`oauth.scope`",
      "`oauth.clientName`",
      "`oauth.clientRegistration`",
      "`oauth.authServerMetadataUrl`",
      "`exposure`",
      "`toolExposure`",
      "`auth.provider`",
      "unknown fields",
      "override entry",
    ];
    for (const row of requiredRows) {
      expect(doc, `missing schema row ${row}`).toContain(row);
    }
    // verify it's a markdown table with Field | Adapter reads | Legacy handling | Parser rule
    contains(/\| Field \| Adapter reads \| Legacy handling \| Parser rule \|/);
    // count rows: at least requiredRows + header
    const tableLines = doc.split("\n").filter((l) => l.startsWith("| `") || l.startsWith("| unknown") || l.startsWith("| override"));
    expect(tableLines.length).toBeGreaterThanOrEqual(requiredRows.length);
  });

  it("does not speculate about unsupported features", () => {
    // parser rejects sse — must be documented as rejected, not as supported
    contains(/legacy `sse` rejected/i);
    notContains(/`sse`\s+is\s+supported/i);
    notContains(/supports SSE transport/i);
    // must not claim a field parser does not validate like plain top-level `auth` without provider
    // table should state auth.provider requires https or loopback — not invent other auth fields
    notContains(/`auth\.token`/i);
    // must mention type streamable-http accepted as http — not invented as separate
    contains(/`streamable-http` accepted as `http`/i);
  });

  it("self-check: stub table missing a row is flagged", () => {
    const fake = "| Field | Adapter reads |\n| `command` | yes |\n";
    expect(fake.includes("`url`")).toBe(false);
    expect(fake.includes("`command`")).toBe(true);
  });
});

describe("docs/cutover.md references pinned Pi target", () => {
  it("references docs/decisions/pi-target.md and §15.5 pre-conditions", () => {
    contains(/docs\/decisions\/pi-target\.md/);
    contains(/§15\.5 item 1/);
    contains(/Gate report exists for commit SHA X/);
    contains(/Backup of the active Pi config/);
  });
});
