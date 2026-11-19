import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runGate, type Exec } from "../src/gate.js";

function fakeExec(over: Record<string, { code: number; stdout: string }> = {}): { exec: Exec; calls: string[][]; envs: NodeJS.ProcessEnv[] } {
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const exec: Exec = (_cmd, args, env) => {
    calls.push([...args]);
    envs.push(env);
    const key = args.slice(1).join(" ");
    for (const [k, v] of Object.entries(over)) if (key.startsWith(k)) return { ...v, stderr: "" };
    if (key === "run --json")
      return { code: 0, stdout: JSON.stringify({ ok: true, total: 2, passed: 2, results: [{ id: "wire.a", ok: true }, { id: "ver.b", ok: true }] }), stderr: "" };
    if (key === "run --mutate --json") return { code: 0, stdout: JSON.stringify({ ok: true, total: 3, passed: 3, results: [] }), stderr: "" };
    if (key === "check-coverage") return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
    if (key === "official --json") return { code: 0, stdout: JSON.stringify({ ok: true, total: 5 }), stderr: "" };
    return { code: 0, stdout: "ok", stderr: "" };
  };
  return { exec, calls, envs };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gate-test-"));
  return { root: dir, reportsDir: join(dir, "reports") };
}

describe("gate", () => {
  it("passes with all suites green and writes md+json by sha", () => {
    const { root, reportsDir } = setup();
    const f = fakeExec();
    const rep = runGate({ root, reportsDir, sha: "abc1234", exec: f.exec, env: { PI_X: "1", NODE_PATH: "x" }, requiredScenarios: ["wire.a"], nodeArgs: ["--foo"] });
    expect(rep.releaseEligible).toBe(true);
    expect(rep.matrix).toHaveLength(2);
    const json = JSON.parse(readFileSync(join(reportsDir, "abc1234.json"), "utf8"));
    expect(json.sha).toBe("abc1234");
    const md = readFileSync(join(reportsDir, "abc1234.md"), "utf8");
    expect(md).toContain("wire.a");
    expect(md).toContain("Non-claims");
    expect(f.envs[0]!.MCP_CONFORMANCE_TRANSCRIPTS).toBe(join(reportsDir, "abc1234", "transcripts"));
    expect(f.envs[0]!.PI_X).toBeUndefined();
    expect(f.envs[0]!.NODE_PATH).toBeUndefined();
    expect(f.calls.some((c) => c.includes("--") && c.includes("--foo"))).toBe(true);
    expect(f.calls.some((c) => c[1] === "official" && c[2] === "--json")).toBe(true);
  });

  it("official failure blocks release", () => {
    const { root, reportsDir } = setup();
    const f = fakeExec({ "official --json": { code: 1, stdout: "" } });
    const rep = runGate({ root, reportsDir, sha: "s1", exec: f.exec, env: {} });
    expect(rep.releaseEligible).toBe(false);
    expect(rep.blockers.some((b) => b.startsWith("official"))).toBe(true);
  });

  it("fails closed on missing scenarios and zero rows", () => {
    const { root, reportsDir } = setup();
    const f = fakeExec({ "run --json": { code: 0, stdout: JSON.stringify({ ok: true, total: 0, results: [] }) } });
    const rep = runGate({ root, reportsDir, sha: "s2", exec: f.exec, env: {}, requiredScenarios: ["x.y"] });
    expect(rep.releaseEligible).toBe(false);
    expect(rep.missingScenarios).toEqual(["x.y"]);
    expect(rep.blockers.some((b) => b.startsWith("baseline"))).toBe(true);
  });

  it("honors GATE_SHA and GATE_REPORTS_DIR env", () => {
    const { root, reportsDir } = setup();
    const f = fakeExec();
    const rep = runGate({ root, exec: f.exec, env: { GATE_SHA: "envsha", GATE_REPORTS_DIR: reportsDir } });
    expect(rep.sha).toBe("envsha");
    expect(readFileSync(join(reportsDir, "envsha.json"), "utf8")).toContain("envsha");
  });

  it("derives sha from git when unset", () => {
    const { root, reportsDir } = setup();
    const base = fakeExec();
    const exec: Exec = (cmd, args, env, cwd) =>
      cmd === "git" ? { code: 0, stdout: "deadbeef\n", stderr: "" } : base.exec(cmd, args, env, cwd);
    expect(runGate({ root, reportsDir, exec, env: {} }).sha).toBe("deadbeef");
  });
});
