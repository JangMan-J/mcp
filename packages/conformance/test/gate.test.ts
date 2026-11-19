import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALL_EXTENSIONS,
  DEFAULT_GATE_ITEM_MAP,
  DEFAULT_GATE_SCENARIOS,
  GATE_ITEM_IDS,
  REQUIRED_SUITES,
  checkRemovalEvidence,
  matchFixture,
  runGate,
  type Exec,
} from "../src/gate.js";

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

  it("default map covers G1-G12 with fixture groups; only existing fixture ids", () => {
    const rows = [
      ...DEFAULT_GATE_SCENARIOS,
      "sub/two-listeners-demux",
      "wire/cancel-read-clean",
      "elic/x",
      "auth/x",
      "cache/x",
      "sub/x",
      "stdio/crash-write-uncertain",
      "http/stream-break-x",
      "ops/x",
      "wire/x",
      "ver/x",
      "ext/cc/x",
    ].map((id) => ({ id, ok: true }));
    const b = base({ "run --json": { code: 0, stdout: JSON.stringify({ ok: true, results: rows }) } });
    const { gateItemMap: _m, requiredScenarios: _s, ...rest } = b.opts;
    const rep = runGate(rest);
    expect(rep.gateItems.filter((g) => g.status !== "pass")).toEqual([]);
    expect(rep.scenarios).toEqual([...DEFAULT_GATE_SCENARIOS]);
    expect(Object.keys(DEFAULT_GATE_ITEM_MAP).sort()).toEqual([...GATE_ITEM_IDS].sort());
    expect(DEFAULT_GATE_ITEM_MAP.G11).toEqual(["no-pi", "wire-scan", "network-scan", "secret-scan"]);
    // every fixture entry names an existing fixture or a glob matching at least one existing fixture
    const exch = fileURLToPath(new URL("../../fixtures/exchanges", import.meta.url));
    const ids = (readdirSync(exch, { recursive: true }) as string[])
      .filter((f) => f.endsWith(".exchange.json"))
      .map((f) => f.replace(/\\/g, "/").replace(/\.exchange\.json$/, ""));
    for (const e of Object.values(DEFAULT_GATE_ITEM_MAP).flat().filter((e) => e.startsWith("fixtures:")))
      expect(ids.some((id) => matchFixture(e.slice(9), id)), e).toBe(true);
    for (const id of DEFAULT_GATE_SCENARIOS) expect(ids).toContain(id);
    // official failure fails G12; bad removal fails G10
    const o = base({ "official --json": { code: 1, stdout: JSON.stringify({ ok: false, total: 0 }) } }, [GOOD_ROWS[0]]);
    const { gateItemMap: _n, ...rest2 } = o.opts;
    const r2 = runGate(rest2);
    expect(r2.gateItems.find((g) => g.id === "G12")?.status).toBe("fail");
    expect(r2.gateItems.find((g) => g.id === "G10")?.status).toBe("fail");
    expect(r2.officialBlockedReason).not.toBeNull();
  });

  it("fixture-group entries: missing with no rows, fail on failing row or failed mutation, pass otherwise", () => {
    expect(matchFixture("wire/cancel*", "wire/cancel-read-clean")).toBe(true);
    expect(matchFixture("wire/cancel*", "wire/x")).toBe(false);
    expect(matchFixture("a.b", "aXb")).toBe(false);
    const rows = [{ id: "wire.a", ok: true }, { id: "ver.b", ok: true }, { id: "g/x", ok: true }, { id: "g/y", ok: false }];
    const b = base({ "run --json": { code: 0, stdout: JSON.stringify({ ok: true, results: rows }) } });
    const map = { ...ALL_MAPPED, G1: ["mutation", "fixtures:wire.a"], G2: ["fixtures:g/*"], G3: "fixtures:none/*", G4: "fixtures:g/x" };
    const rep = runGate({ ...b.opts, gateItemMap: map });
    const st = (id: string) => rep.gateItems.find((g) => g.id === id)!;
    expect(st("G1").status).toBe("pass");
    expect(st("G2").status).toBe("fail");
    expect(st("G2").detail).toContain("g/y");
    expect(st("G3").status).toBe("missing");
    expect(st("G4").status).toBe("pass");
    const m = base({ "run --mutate --json": { code: 1, stdout: JSON.stringify({ ok: false, total: 3, passed: 1 }) } });
    const r2 = runGate({ ...m.opts, gateItemMap: { ...ALL_MAPPED, G4: "fixtures:wire.a" } });
    expect(r2.gateItems.find((g) => g.id === "G4")?.status).toBe("fail");
  });

  it("runs network-scan and secret-scan on the run transcripts; failures block", () => {
    const b = base();
    const rep = runGate(b.opts);
    for (const n of ["network-scan", "secret-scan"]) {
      const c = b.f.calls.find((x) => x[0]!.endsWith(`scripts/${n}.mjs`));
      expect(c?.[1]).toBe(rep.transcriptsDir);
      expect(rep.suites.find((s) => s.name === n)?.ok).toBe(true);
    }
    expect(REQUIRED_SUITES).toContain("network-scan");
    expect(REQUIRED_SUITES).toContain("secret-scan");
    const f = base({ "network-scan.mjs": { code: 1, stdout: "non-loopback" }, "secret-scan.mjs": { code: 1, stdout: "hit" } });
    const r2 = runGate(f.opts);
    expect(r2.blockers.some((x) => x.startsWith("network-scan"))).toBe(true);
    expect(r2.blockers.some((x) => x.startsWith("secret-scan"))).toBe(true);
  });

  it("scenarios: GATE_SCENARIOS env overrides default; explicit option overrides env", () => {
    const b = base();
    const { requiredScenarios: _s, ...rest } = b.opts;
    expect(runGate({ ...rest, env: { ...b.opts.env, GATE_SCENARIOS: "ver.b" } }).scenarios).toEqual(["ver.b"]);
    expect(runGate(rest).scenarios).toEqual([...DEFAULT_GATE_SCENARIOS]);
    expect(runGate({ ...b.opts, env: { ...b.opts.env, GATE_SCENARIOS: "ver.b" } }).scenarios).toEqual(["wire.a"]);
  });

  it("deprecated/excluded rows need pass; unresolved, out-of-scope and optional rows are non-claims", () => {
    const b = base();
    const reqs = [...REQS, { id: "D1", disposition: "deprecated" }, { id: "U1", disposition: "unresolved" }, { id: "O1", disposition: "out-of-scope" }];
    const rep = runGate({ ...b.opts, requirements: reqs });
    expect(rep.blockers.some((x) => x.startsWith("requirements:"))).toBe(true);
    expect(rep.nonClaims.join("\n")).toContain("U1");
    expect(rep.nonClaims.join("\n")).toContain("O1");
    expect(rep.nonClaims.join("\n")).toContain("R2");
    const ok = runGate({ ...b.opts, requirements: [...REQS, { id: "U1", disposition: "unresolved" }, { id: "X", disposition: "excluded" }], fixtures: [...FIX, { id: "ver.b", requirements: ["X"] }] });
    expect(ok.releaseEligible).toBe(true);
  });

  it("network-scan and secret-scan scripts flag offenders and pass clean transcripts", () => {
    const dir = mkdtempSync(join(tmpdir(), "scan-test-"));
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    const run = (script: string, ...args: string[]) => spawnSync(process.execPath, [join(root, "scripts", script), ...args], { encoding: "utf8" });
    const clean = { fixture: "f", mcpEndpoint: "http://127.0.0.1:1/mcp", frames: [{ direction: "client", url: "http://localhost:3/mcp", headers: { authorization: "Bearer tok" }, message: { jsonrpc: "2.0", id: 1, method: "tools/list" } }] };
    writeFileSync(join(dir, "a.json"), JSON.stringify(clean));
    expect(run("network-scan.mjs", dir).status).toBe(0);
    expect(run("secret-scan.mjs", dir).status).toBe(0);
    const bad = { ...clean, frames: [...clean.frames, { direction: "client", url: "https://evil.example.com/x", endpoint: "other", message: { jsonrpc: "2.0", method: "notifications/x", params: { client_secret: "s3cr3t" } } }] };
    writeFileSync(join(dir, "b.json"), JSON.stringify(bad));
    const n = run("network-scan.mjs", dir);
    expect(n.status).toBe(1);
    expect(n.stderr).toContain("evil.example.com");
    const sres = run("secret-scan.mjs", dir);
    expect(sres.status).toBe(1);
    expect(sres.stderr).not.toContain("s3cr3t");
    rmSync(join(dir, "b.json"));
    const log = join(dir, "x.log");
    writeFileSync(log, "-----BEGIN RSA PRIVATE KEY-----\n");
    expect(run("secret-scan.mjs", dir, "--log", log).status).toBe(1);
    writeFileSync(log, "client_secret=***\n");
    expect(run("secret-scan.mjs", dir, "--log", log).status).toBe(0);
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
