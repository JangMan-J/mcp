import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_EXTENSIONS, DEFAULT_GATE_ITEM_MAP, GATE_ITEM_IDS, checkRemovalEvidence, runGate, type Exec } from "../src/gate.js";

const SHA = "a".repeat(40);
const ALL_MAPPED = Object.fromEntries(GATE_ITEM_IDS.map((g) => [g, "baseline"]));
const REQS = [{ id: "R1", disposition: "required" }, { id: "R2", disposition: "active-optional" }];
const FIX = [{ id: "wire.a", requirements: ["R1"] }, { id: "ver.b", requirements: ["R1"] }];

type Over = Record<string, { code: number; stdout: string }>;
function fakeExec(over: Over = {}) {
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const exec: Exec = (_cmd, args, env) => {
    calls.push([...args]);
    envs.push(env);
    const dd = args.indexOf("--");
    const cliIdx = args.findIndex((a) => a.endsWith("dist/cli.js"));
    const key = cliIdx >= 0 ? args.slice(cliIdx + 1).join(" ") : args.map((a) => a.split("/").pop()).join(" ");
    for (const [k, v] of Object.entries(over)) if (key.startsWith(k)) return { ...v, stderr: "" };
    if (dd >= 0 && cliIdx < 0) return { code: 0, stdout: "assert-no-pi: ok", stderr: "" };
    if (key === "run --json")
      return { code: 0, stdout: JSON.stringify({ ok: true, results: [{ id: "wire.a", ok: true }, { id: "ver.b", ok: true }] }), stderr: "" };
    if (key === "run --mutate --json") return { code: 0, stdout: JSON.stringify({ ok: true, total: 3, passed: 3 }), stderr: "" };
    if (key === "check-coverage") return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    if (key === "official --json") return { code: 0, stdout: JSON.stringify({ ok: true, total: 5 }), stderr: "" };
    return { code: 0, stdout: "ok", stderr: "" };
  };
  return { exec, calls, envs };
}

const GOOD_ROWS = ALL_EXTENSIONS.map((e) => ({ script: `remove:${e}`, ext: e, exitCode: 0, log: `${e}.log` }));
function setup(rows: unknown = GOOD_ROWS) {
  const dir = mkdtempSync(join(tmpdir(), "gate-test-"));
  const prereq = join(dir, "prereq");
  mkdirSync(prereq);
  if (rows !== null) writeFileSync(join(prereq, "remove-ext.json"), typeof rows === "string" ? rows : JSON.stringify(rows));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  mkdirSync(join(dir, "docs/conformance"), { recursive: true });
  writeFileSync(join(dir, "docs/conformance/PINS.md"), "| pin | value |\n| spec | 2026-07-28 |\n");
  return { root: dir, reportsDir: join(dir, "reports"), prereq };
}

function base(over: Over = {}, rows: unknown = GOOD_ROWS) {
  const s = setup(rows);
  const f = fakeExec(over);
  return {
    ...s,
    f,
    opts: {
      root: s.root,
      reportsDir: s.reportsDir,
      sha: SHA,
      exec: f.exec,
      env: { PI_X: "1", NODE_PATH: "x", GATE_PREREQ_DIR: s.prereq },
      requiredScenarios: ["wire.a"],
      requirements: REQS,
      fixtures: FIX,
      gateItemMap: ALL_MAPPED,
      nodeArgs: ["--foo"],
    },
  };
}

describe("gate", () => {
  it("eligible only when everything passes; writes gate-<sha>.{md,json} and coverage-matrix.md", () => {
    const b = base();
    const rep = runGate(b.opts);
    expect(rep.blockers).toEqual([]);
    expect(rep.releaseEligible).toBe(true);
    expect(JSON.parse(readFileSync(join(b.reportsDir, `gate-${SHA}.json`), "utf8")).sha).toBe(SHA);
    expect(readFileSync(join(b.reportsDir, `gate-${SHA}.md`), "utf8")).toContain("Non-claims");
    const cov = readFileSync(join(b.reportsDir, "coverage-matrix.md"), "utf8");
    expect(cov).toContain("| R1 | required | wire.a, ver.b | pass |");
    expect(cov).toContain("| R2 | active-optional | - | missing |");
  });

  it("runs built CLI inside the no-Pi wrapper, wire-scan on fresh transcripts, never runs removal in production", () => {
    const b = base();
    const rep = runGate(b.opts);
    const cliCalls = b.f.calls.filter((c) => c.some((a) => a.endsWith("dist/cli.js")));
    expect(cliCalls.length).toBeGreaterThanOrEqual(4);
    for (const c of cliCalls) {
      expect(c[0]!.endsWith("scripts/assert-no-pi.mjs")).toBe(true);
      expect(c[1]).toBe("--");
      expect(c[2]).toBe("--foo");
    }
    const ws = b.f.calls.find((c) => c[0]!.endsWith("scripts/wire-scan.mjs"));
    expect(ws?.[1]).toBe(rep.transcriptsDir);
    expect(existsSync(rep.transcriptsDir)).toBe(true);
    expect(rep.transcriptsDir.startsWith(join(b.reportsDir, `gate-${SHA}-transcripts-`))).toBe(true);
    for (const e of b.f.envs) {
      expect(e.PI_X).toBeUndefined();
      expect(e.NODE_PATH).toBeUndefined();
      expect(e.MCP_CONFORMANCE_TRANSCRIPTS).toBe(rep.transcriptsDir);
    }
    expect(b.f.calls.some((c) => c.some((a) => a.includes("check-remove-ext")))).toBe(false);
    expect(ALL_EXTENSIONS).toHaveLength(8);
    expect(rep.evidence.removal.map((r) => r.ext)).toEqual(ALL_EXTENSIONS);
    // a second run gets a fresh transcript dir
    expect(runGate(b.opts).transcriptsDir).not.toBe(rep.transcriptsDir);
  });

  it("official failure blocks and retains reason", () => {
    const b = base({ "official --json": { code: 1, stdout: JSON.stringify({ ok: false, total: 0, reason: "not wired" }) } });
    const rep = runGate(b.opts);
    expect(rep.releaseEligible).toBe(false);
    expect(rep.officialBlockedReason).toContain("not wired");
    expect(readFileSync(join(b.reportsDir, `gate-${SHA}.md`), "utf8")).toContain("not wired");
  });

  it("blocks without explicit scenarios, on missing scenarios, and on zero rows", () => {
    const b = base();
    expect(runGate({ ...b.opts, requiredScenarios: [] }).blockers).toContain("scenarios: no explicit eligible scenarios given");
    expect(runGate({ ...b.opts, requiredScenarios: ["x.y"] }).missingScenarios).toEqual(["x.y"]);
    const z = base({ "run --json": { code: 0, stdout: JSON.stringify({ ok: true, results: [] }) } });
    const rep = runGate(z.opts);
    expect(rep.releaseEligible).toBe(false);
    expect(rep.blockers.some((x) => x.startsWith("baseline"))).toBe(true);
  });

  it("required rows with partial evidence are missing and block", () => {
    const b = base({ "run --json": { code: 0, stdout: JSON.stringify({ ok: true, results: [{ id: "wire.a", ok: true }] }) } });
    const rep = runGate(b.opts);
    expect(rep.requirementMatrix.find((r) => r.id === "R1")?.status).toBe("missing");
    expect(rep.releaseEligible).toBe(false);
  });

  it("reports unmapped G1-G12 as missing and blocks", () => {
    const b = base();
    const rep = runGate({ ...b.opts, gateItemMap: { G1: "baseline" } });
    expect(rep.gateItems.find((g) => g.id === "G1")?.status).toBe("pass");
    expect(rep.gateItems.filter((g) => g.status === "missing").map((g) => g.id)).toEqual(GATE_ITEM_IDS.slice(1));
    expect(rep.releaseEligible).toBe(false);
  });

  it("unset prereq dir blocks removal", () => {
    const b = base();
    const rep = runGate({ ...b.opts, env: {} });
    expect(rep.blockers.some((x) => x.startsWith("removal") && x.includes("GATE_PREREQ_DIR"))).toBe(true);
  });

  const removalBlock = (rows: unknown, needle: string) => {
    const b = base({}, rows);
    const rep = runGate(b.opts);
    const r = rep.suites.find((s) => s.name === "removal")!;
    expect(r.ok).toBe(false);
    expect(r.detail).toContain(needle);
    expect(rep.releaseEligible).toBe(false);
    expect(rep.gateItems.find((g) => g.id === "G1")?.status).toBe("pass");
  };
  it("removal: missing file, unparseable, incomplete, duplicate, nonzero, unknown rows block", () => {
    removalBlock(null, "missing");
    removalBlock("[{", "unparseable");
    removalBlock(GOOD_ROWS.slice(0, 4), "missing ext-events");
    removalBlock([...GOOD_ROWS.slice(0, 7), GOOD_ROWS[0]], "duplicate ext-apps");
    removalBlock(GOOD_ROWS.map((r, i) => (i === 2 ? { ...r, exitCode: 1 } : r)), `${ALL_EXTENSIONS[2]} exit 1`);
    removalBlock([...GOOD_ROWS, { ext: "ext-bogus", exitCode: 0 }], "unknown extension ext-bogus");
    removalBlock([...GOOD_ROWS.slice(1), { ext: "ext-apps" }], "malformed");
    expect(checkRemovalEvidence({}).ok).toBe(false);
    expect(checkRemovalEvidence(GOOD_ROWS).ok).toBe(true);
  });

  it("records Node/OS/lockfile/PINS evidence; missing or partial pins block", () => {
    const b = base();
    const rep = runGate(b.opts);
    expect(rep.evidence.node).toBe(process.version);
    expect(rep.evidence.os).toMatch(/\S+ \S+ \S+/);
    expect(rep.evidence.lockfileSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rep.evidence.pinsSha256).toMatch(/^[0-9a-f]{64}$/);
    const md = readFileSync(join(b.reportsDir, `gate-${SHA}.md`), "utf8");
    expect(md).toContain(`PINS.md sha256: ${rep.evidence.pinsSha256}`);
    writeFileSync(join(b.root, "docs/conformance/PINS.md"), "| spec | TBD |\n");
    expect(runGate(b.opts).blockers).toContain("evidence: PINS.md partial");
    const c = base();
    rmSync(join(c.root, "package-lock.json"));
    expect(runGate(c.opts).blockers.some((x) => x.startsWith("evidence") && x.includes("package-lock.json missing"))).toBe(true);
  });

  it("default map: G10 from removal, G11 missing without network/secret scans, G12 needs official and evidence", () => {
    const b = base();
    const { gateItemMap: _m, ...rest } = b.opts;
    const rep = runGate(rest);
    const st = (id: string) => rep.gateItems.find((g) => g.id === id)?.status;
    expect(st("G10")).toBe("pass");
    expect(st("G11")).toBe("missing");
    expect(st("G12")).toBe("pass");
    expect(st("G1")).toBe("missing");
    expect(DEFAULT_GATE_ITEM_MAP.G11).toContain("wire-scan");
    const o = base({ "official --json": { code: 1, stdout: JSON.stringify({ ok: false, total: 0 }) } }, [GOOD_ROWS[0]]);
    const { gateItemMap: _n, ...rest2 } = o.opts;
    const r2 = runGate(rest2);
    expect(r2.gateItems.find((g) => g.id === "G12")?.status).toBe("fail");
    expect(r2.gateItems.find((g) => g.id === "G10")?.status).toBe("fail");
  });

  it("validates sha from option, GATE_SHA and git", () => {
    const b = base();
    expect(() => runGate({ ...b.opts, sha: "abc" })).toThrow(/invalid sha/);
    const { sha: _s, ...noSha } = b.opts;
    expect(() => runGate({ ...noSha, env: { GATE_SHA: "zz" } })).toThrow(/invalid sha/);
    expect(runGate({ ...noSha, env: { GATE_SHA: SHA } }).sha).toBe(SHA);
    const exec: Exec = (cmd, args, env, cwd) =>
      cmd === "git" ? { code: 0, stdout: `${"b".repeat(40)}\n`, stderr: "" } : b.f.exec(cmd, args, env, cwd);
    expect(runGate({ ...noSha, exec, env: {} }).sha).toBe("b".repeat(40));
  });

  it("honors GATE_REPORTS_DIR", () => {
    const b = base();
    const { reportsDir: _r, ...rest } = b.opts;
    const dir = join(b.root, "envreports");
    runGate({ ...rest, env: { ...b.opts.env, GATE_REPORTS_DIR: dir } });
    expect(existsSync(join(dir, `gate-${SHA}.json`))).toBe(true);
  });
});
