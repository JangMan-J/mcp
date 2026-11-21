import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatOfficialReport } from "../src/cli.js";
import { ALL_EXTENSIONS, GATE_ITEM_IDS, runGate, type Exec } from "../src/gate.js";
import { runOfficial } from "../src/official.js";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SHA = "b".repeat(40);
const ALL_MAPPED = Object.fromEntries(GATE_ITEM_IDS.map((g) => [g, "baseline"]));
const GOOD_ROWS = ALL_EXTENSIONS.map((e) => ({ script: `remove:${e}`, ext: e, exitCode: 0, log: `${e}.log` }));
const GOOD_VALIDATE = ["check:deps-doc", "check:forbidden", "check:deps"].map((script) => ({
  script,
  exitCode: 0,
  log: `${script}.log`,
}));
const GOOD_VITEST = { success: true, numTotalTests: 1, numFailedTests: 0, testResults: [] };

function runGateWithOfficialOutput(officialRes: { code: number; stdout: string; stderr?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "official-gate-"));
  const prereq = join(dir, "prereq");
  mkdirSync(prereq);
  writeFileSync(join(prereq, "remove-ext.json"), JSON.stringify(GOOD_ROWS));
  writeFileSync(join(prereq, "vitest.json"), JSON.stringify(GOOD_VITEST));
  writeFileSync(join(prereq, "validate.json"), JSON.stringify(GOOD_VALIDATE));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  mkdirSync(join(dir, "docs/conformance"), { recursive: true });
  writeFileSync(join(dir, "docs/conformance/PINS.md"), "| pin | value |\n| spec | 2026-07-28 |\n");

  const exec: Exec = (_cmd, args) => {
    const dd = args.indexOf("--");
    const cliIdx = args.findIndex((a) => a.endsWith("dist/cli.js"));
    const key = cliIdx >= 0 ? args.slice(cliIdx + 1).join(" ") : args.map((a) => a.split("/").pop()).join(" ");
    if (dd >= 0 && cliIdx < 0) return { code: 0, stdout: "assert-no-pi: ok", stderr: "" };
    if (key === "run --json") {
      return { code: 0, stdout: JSON.stringify({ ok: true, results: [{ id: "wire.a", ok: true }] }), stderr: "" };
    }
    if (key === "run --mutate --json") {
      return { code: 0, stdout: JSON.stringify({ ok: true, total: 2, passed: 2 }), stderr: "" };
    }
    if (key === "check-coverage") {
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    }
    if (key === "official --json") {
      return { code: officialRes.code, stdout: officialRes.stdout, stderr: officialRes.stderr ?? "" };
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };

  try {
    return runGate({
      root: dir,
      reportsDir: join(dir, "reports"),
      sha: SHA,
      exec,
      env: { GATE_PREREQ_DIR: prereq },
      requiredScenarios: ["wire.a"],
      requirements: [{ id: "R1", disposition: "required" }],
      fixtures: [{ id: "wire.a", requirements: ["R1"] }],
      gateItemMap: ALL_MAPPED,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fake runner body: writes `checks` (a JS expression using `sc`) to <-o dir>/<scenario>-1/checks.json. */
function fakeRunner(checksExpr: string, extra = ""): string {
  return [
    'const fs = require("node:fs"), path = require("node:path");',
    'const a = process.argv, o = a[a.indexOf("-o") + 1], sc = a[a.indexOf("--scenario") + 1];',
    extra,
    'const d = path.join(o, sc.replace(/\\//g, "-") + "-1");',
    "fs.mkdirSync(d, { recursive: true });",
    `fs.writeFileSync(path.join(d, "checks.json"), JSON.stringify(${checksExpr}));`,
  ].join("\n");
}

function makeOfficialFixture(opts: { runnerScript: string; scenarioIds: readonly string[]; pinMismatch?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "official-report-"));
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "dist"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "runner", version: "1" }));
  writeFileSync(join(checkout, "dist/index.js"), opts.runnerScript);
  const git = (...args: string[]) => execFileSync("git", ["-C", checkout, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");

  const map = JSON.parse(readFileSync(join(REPO_ROOT, "packages/conformance/official-map.json"), "utf8"));
  Object.assign(map.runner, {
    package: "runner",
    version: "1",
    commit: opts.pinMismatch ? "0".repeat(40) : commit,
    checkoutDir: "checkout",
  });
  map.catalog = { selected: true, authorizedBy: "test", reason: "" };
  map.cut = { authorized: true, path: "cut.js", reason: "" };
  map.scenarios = opts.scenarioIds.map((id) => ({
    id,
    specVersion: map.eligibility.specVersion,
    requirements: ["REQ-1"],
    ...map.eligibility.requires,
  }));
  mkdirSync(join(root, "packages/conformance"), { recursive: true });
  writeFileSync(join(root, "cut.js"), "");
  writeFileSync(join(root, "packages/conformance/official-map.json"), JSON.stringify(map));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("official --json CLI report alignment with gate.ts", () => {
  it("pass: derives total from observed scenarios only, preserves per-scenario evidence, and passes gate.ts", async () => {
    const fixture = makeOfficialFixture({
      runnerScript: fakeRunner('[{ id: sc, status: "SUCCESS" }, { id: "x", status: "SUCCESS" }]', 'console.log("runner-evidence:" + sc);'),
      scenarioIds: ["alpha", "beta"],
    });
    const prevCheckout = process.env.MCP_CONFORMANCE_CHECKOUT;
    delete process.env.MCP_CONFORMANCE_CHECKOUT;
    try {
      const raw = await runOfficial(fixture.root);
      const formatted = formatOfficialReport(raw);

      expect(formatted.ok).toBe(true);
      expect(formatted.total).toBe(2);
      expect(formatted.reason).toBeUndefined();
      // Excluded legacy scenarios are preserved but never counted in total.
      expect(Array.isArray(formatted.excluded)).toBe(true);
      expect((formatted.excluded as unknown[]).length).toBeGreaterThan(0);
      expect(formatted.scenarios).toHaveLength(2);
      expect(formatted.scenarios[0]).toMatchObject({
        id: "alpha",
        requirements: ["REQ-1"],
        ok: true,
        exitCode: 0,
        result: { checks: 2, passed: 2, failed: 0, statuses: { SUCCESS: 2 } },
      });
      expect((formatted.scenarios[0] as { evidence: string }).evidence).toContain("runner-evidence:alpha");
      expect(formatted.scenarios[1]).toMatchObject({ id: "beta", ok: true });
      expect(formatted.pin).toEqual(raw.pin);
      expect(formatted.evidence).toEqual(raw.evidence);

      const gateRep = runGateWithOfficialOutput({
        code: formatted.ok ? 0 : 1,
        stdout: JSON.stringify(formatted, null, 2),
      });
      expect(gateRep.releaseEligible).toBe(true);
      expect(gateRep.officialBlockedReason).toBeNull();
      expect(gateRep.suites.find((s) => s.name === "official")).toEqual({
        name: "official",
        ok: true,
        detail: "ok total=2",
      });
    } finally {
      if (prevCheckout !== undefined) process.env.MCP_CONFORMANCE_CHECKOUT = prevCheckout;
      fixture.cleanup();
    }
  });

  it("blocked: exposes blocked reason, reports total=0, preserves metadata, and blocks gate.ts", async () => {
    const fixture = makeOfficialFixture({
      runnerScript: fakeRunner('[{ id: "a", status: "SUCCESS" }]'),
      scenarioIds: ["alpha"],
      pinMismatch: true,
    });
    const prevCheckout = process.env.MCP_CONFORMANCE_CHECKOUT;
    delete process.env.MCP_CONFORMANCE_CHECKOUT;
    try {
      const raw = await runOfficial(fixture.root);
      const formatted = formatOfficialReport(raw);

      expect(formatted.ok).toBe(false);
      expect(formatted.total).toBe(0);
      expect(formatted.reason).toBe(raw.blocked);
      expect(formatted.reason).toContain("checkout-pin-mismatch");
      expect(formatted.blocked).toBe(raw.blocked);
      expect(formatted.reasons).toEqual(raw.reasons);
      expect(formatted.scenarios).toEqual([]);
      expect((formatted.excluded as unknown[]).length).toBeGreaterThan(0);

      const gateRep = runGateWithOfficialOutput({
        code: formatted.ok ? 0 : 1,
        stdout: JSON.stringify(formatted, null, 2),
      });
      expect(gateRep.releaseEligible).toBe(false);
      expect(gateRep.suites.find((s) => s.name === "official")?.ok).toBe(false);
      expect(gateRep.officialBlockedReason).toContain("total=0");
      expect(gateRep.officialBlockedReason).toContain("checkout-pin-mismatch");
    } finally {
      if (prevCheckout !== undefined) process.env.MCP_CONFORMANCE_CHECKOUT = prevCheckout;
      fixture.cleanup();
    }
  });

  it("scenario failure: preserves per-scenario evidence and exposes failure reason to gate.ts", async () => {
    const fixture = makeOfficialFixture({
      runnerScript: fakeRunner('[{ id: "a", status: "SUCCESS" }].concat(sc === "bad-one" ? [{ id: "b", status: "FAILURE" }] : [])'),
      scenarioIds: ["good-one", "bad-one"],
    });
    const prevCheckout = process.env.MCP_CONFORMANCE_CHECKOUT;
    delete process.env.MCP_CONFORMANCE_CHECKOUT;
    try {
      const raw = await runOfficial(fixture.root);
      const formatted = formatOfficialReport(raw);

      expect(formatted.ok).toBe(false);
      expect(formatted.total).toBe(2);
      expect(formatted.reason).toContain("scenario-failed: bad-one");
      expect(formatted.scenarios).toHaveLength(2);
      expect(formatted.scenarios[0]).toMatchObject({ id: "good-one", ok: true });
      expect(formatted.scenarios[1]).toMatchObject({
        id: "bad-one",
        ok: false,
        result: { checks: 2, passed: 1, failed: 1, statuses: { SUCCESS: 1, FAILURE: 1 } },
      });

      const gateRep = runGateWithOfficialOutput({
        code: formatted.ok ? 0 : 1,
        stdout: JSON.stringify(formatted, null, 2),
      });
      expect(gateRep.releaseEligible).toBe(false);
      expect(gateRep.officialBlockedReason).toContain("total=2");
      expect(gateRep.officialBlockedReason).toContain("scenario-failed: bad-one");
    } finally {
      if (prevCheckout !== undefined) process.env.MCP_CONFORMANCE_CHECKOUT = prevCheckout;
      fixture.cleanup();
    }
  });

  it("empty and inconsistent output: fails closed, ignores untrusted total, and blocks gate.ts", () => {
    const emptyScenarios = formatOfficialReport({
      ok: true,
      total: 5,
      scenarios: [],
      excluded: [{ id: "initialize", counted: false, reason: "legacy" }],
    });
    expect(emptyScenarios.ok).toBe(false);
    expect(emptyScenarios.total).toBe(0);
    expect(emptyScenarios.reason).toBe("no official scenarios observed");

    // Even if exit code were 0, gate.ts must reject total=0 / ok=false and retain the reason.
    const gateEmptyScenarios = runGateWithOfficialOutput({
      code: 0,
      stdout: JSON.stringify(emptyScenarios, null, 2),
    });
    expect(gateEmptyScenarios.releaseEligible).toBe(false);
    expect(gateEmptyScenarios.officialBlockedReason).toContain("total=0");
    expect(gateEmptyScenarios.officialBlockedReason).toContain("no official scenarios observed");

    // Inconsistent input claiming ok: true while a scenario failed still fails closed.
    const inconsistent = formatOfficialReport({
      ok: true,
      scenarios: [
        { id: "ok-one", ok: true },
        { id: "broken-one", ok: false, error: "bad result" },
      ],
    });
    expect(inconsistent.ok).toBe(false);
    expect(inconsistent.total).toBe(2);
    expect(inconsistent.reason).toContain("broken-one: bad result");

    // Missing / malformed reports fail closed.
    for (const raw of [undefined, null, {} as Record<string, unknown>]) {
      const rep = formatOfficialReport(raw);
      expect(rep.ok).toBe(false);
      expect(rep.total).toBe(0);
      expect(rep.scenarios).toEqual([]);
      expect(typeof rep.reason).toBe("string");
      expect(rep.reason!.length).toBeGreaterThan(0);
    }

    // Completely empty stdout from official --json fails closed in gate.ts.
    const gateEmptyStdout = runGateWithOfficialOutput({ code: 0, stdout: "" });
    expect(gateEmptyStdout.releaseEligible).toBe(false);
    expect(gateEmptyStdout.officialBlockedReason).toContain("no parseable report");
  });

  it("built CLI `official --json` produces gate-compatible JSON when blocked", () => {
    const cli = join(REPO_ROOT, "packages/conformance/dist/cli.js");
    const missingCheckout = join(tmpdir(), `missing-conformance-checkout-${process.pid}`);
    const r = spawnSync(process.execPath, [cli, "official", "--json"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, MCP_CONFORMANCE_CHECKOUT: missingCheckout },
    });

    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout) as {
      ok?: boolean;
      total?: number;
      reason?: string;
      blocked?: string;
      scenarios?: unknown[];
      excluded?: unknown[];
      evidence?: Record<string, unknown>;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.total).toBe(0);
    expect(typeof parsed.reason).toBe("string");
    expect(parsed.reason).toContain("checkout-missing");
    expect(parsed.blocked).toBe(parsed.reason);
    expect(parsed.scenarios).toEqual([]);
    expect(Array.isArray(parsed.excluded)).toBe(true);
    expect(parsed.evidence?.checkoutDir).toBe(missingCheckout);

    const gateRep = runGateWithOfficialOutput({ code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr });
    expect(gateRep.releaseEligible).toBe(false);
    expect(gateRep.officialBlockedReason).toContain("total=0");
    expect(gateRep.officialBlockedReason).toContain("checkout-missing");
  });
});
