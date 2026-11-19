import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_EXTENSIONS, GATE_ITEM_IDS, runGate, type Exec } from "../src/gate.js";

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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gate-test-"));
  return { root: dir, reportsDir: join(dir, "reports"), ws: join(dir, "dev") };
}

function base(over: Over = {}) {
  const s = setup();
  const f = fakeExec(over);
  return {
    ...s,
    f,
    opts: {
      root: s.root,
      reportsDir: s.reportsDir,
      sha: SHA,
      exec: f.exec,
      env: { PI_X: "1", NODE_PATH: "x", GATE_DEV_WORKSPACE: s.ws },
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

  it("runs built CLI inside the no-Pi wrapper, wire-scan on fresh transcripts, removal for all eight in dev workspace", () => {
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
    const removals = b.f.calls.filter((c) => c[0] === join(b.ws, "scripts/check-remove-ext.mjs")).map((c) => c[1]);
    expect(removals).toEqual(ALL_EXTENSIONS);
    expect(ALL_EXTENSIONS).toHaveLength(8);
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

  it("missing dev workspace blocks removal", () => {
    const b = base();
    const rep = runGate({ ...b.opts, env: {} });
    expect(rep.blockers.some((x) => x.startsWith("removal") && x.includes("GATE_DEV_WORKSPACE"))).toBe(true);
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
