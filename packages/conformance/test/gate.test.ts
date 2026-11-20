import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  SUITE_REQUIREMENT_EVIDENCE,
  checkValidateEvidence,
  checkRemovalEvidence,
  buildRequirementMatrix,
  matchFixture,
  parseVitestEvidence,
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
const GOOD_VALIDATE = ["check:deps-doc", "check:forbidden", "check:deps"].map((script) => ({ script, exitCode: 0, log: `${script}.log` }));
const GOOD_VITEST = { success: true, numTotalTests: 1, numFailedTests: 0, testResults: [] };
function setup(rows: unknown = GOOD_ROWS) {
  const dir = mkdtempSync(join(tmpdir(), "gate-test-"));
  const prereq = join(dir, "prereq");
  mkdirSync(prereq);
  if (rows !== null) writeFileSync(join(prereq, "remove-ext.json"), typeof rows === "string" ? rows : JSON.stringify(rows));
  writeFileSync(join(prereq, "vitest.json"), JSON.stringify(GOOD_VITEST));
  writeFileSync(join(prereq, "validate.json"), JSON.stringify(GOOD_VALIDATE));
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

  it("network-scan excludes frame.message data fields but checks destinations", () => {
    const dir = mkdtempSync(join(tmpdir(), "network-stimulus-"));
    const file = join(dir, "transcript.json");
    const script = fileURLToPath(new URL("../../../scripts/network-scan.mjs", import.meta.url));
    const scan = (doc: unknown) => {
      writeFileSync(file, JSON.stringify(doc));
      return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
    };
    try {
      const stimulusMessage = { params: { nested: ["https://remote.example/path"] } };
      const subscribeMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "events/subscribe",
        params: { delivery: { url: "https://remote.example/webhook" } },
      };
      expect(scan({ mcpEndpoint: "http://localhost/mcp", frames: [{ direction: "server", message: stimulusMessage }] }).status).toBe(0);
      expect(scan({ mcpEndpoint: "http://localhost/mcp", frames: [{ direction: "client", message: subscribeMessage }] }).status).toBe(0);
      for (const doc of [
        { mcpEndpoint: "https://remote.example/mcp", frames: [] },
        { frames: [{ direction: "client", url: "https://remote.example/mcp" }] },
        { frames: [{ direction: "server", url: "https://remote.example" }] },
        { frames: [{ direction: "server", headers: { location: "https://remote.example" } }] },
        { frames: [{ direction: "client", headers: { location: "https://remote.example" } }] },
      ]) {
        const result = scan(doc);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("remote.example");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("parseVitestEvidence: tags from passed/failed tests; skipped and unknown ids ignored", () => {
    const raw = {
      success: false,
      numTotalTests: 4,
      numFailedTests: 1,
      testResults: [
        {
          name: join(process.cwd(), "packages/x/test/a.test.ts"),
          assertionResults: [
            { ancestorTitles: ["[R1] group"], title: "ok one", fullName: "[R1] group ok one", status: "passed" },
            { ancestorTitles: [], title: "[R2] bad", fullName: "[R2] bad", status: "failed" },
            { ancestorTitles: [], title: "[R1] skipped", fullName: "[R1] skipped", status: "skipped" },
            { ancestorTitles: [], title: "[NOPE-1] unknown", fullName: "[NOPE-1] unknown", status: "passed" },
          ],
        },
      ],
    };
    const known = new Set(["R-1", "R1", "R2", "WIRE-DIR-1"]);
    // R1/R2 have no hyphen and are not tags; use hyphenated ids
    const raw2 = JSON.parse(JSON.stringify(raw).replace(/\[R1\]/g, "[WIRE-DIR-1]").replace(/\[R2\]/g, "[R-1]"));
    const v = parseVitestEvidence(raw2, known);
    expect(v.ok).toBe(false);
    expect(v.evidence).toEqual([
      { req: "WIRE-DIR-1", source: "unit:packages/x/test/a.test.ts#[WIRE-DIR-1] group ok one", ok: true },
      { req: "R-1", source: "unit:packages/x/test/a.test.ts#[R-1] bad", ok: false },
    ]);
    expect(parseVitestEvidence({ success: true, numTotalTests: 0, numFailedTests: 0 }, known).ok).toBe(false);
    expect(parseVitestEvidence({ success: true, numTotalTests: 2, numFailedTests: 0, testResults: [] }, known).ok).toBe(true);
    expect(parseVitestEvidence([], known).ok).toBe(false);
  });

  it("unit suite fails closed when vitest.json is missing or unparseable", () => {
    const b = base();
    rmSync(join(b.prereq, "vitest.json"));
    const rep = runGate(b.opts);
    expect(rep.suites.find((s) => s.name === "unit")?.ok).toBe(false);
    expect(rep.blockers.some((x) => x.startsWith("unit") && x.includes("missing"))).toBe(true);
    const c = base();
    writeFileSync(join(c.prereq, "vitest.json"), "{");
    expect(runGate(c.opts).blockers.some((x) => x.startsWith("unit") && x.includes("unparseable"))).toBe(true);
  });

  it("requirement matrix: pass via unit evidence only; failing evidence fails", () => {
    const reqs = [{ id: "A-1", disposition: "required" }];
    expect(buildRequirementMatrix(reqs, [], [], [{ req: "A-1", source: "unit:t#x", ok: true }])[0]).toMatchObject({ status: "pass", evidence: ["unit:t#x"] });
    expect(buildRequirementMatrix(reqs, [], [], [{ req: "A-1", source: "unit:t#x", ok: false }])[0]!.status).toBe("fail");
    expect(buildRequirementMatrix(reqs, [], [])[0]!.status).toBe("missing");
    const b = base();
    writeFileSync(
      join(b.prereq, "vitest.json"),
      JSON.stringify({ ...GOOD_VITEST, testResults: [{ name: "t.ts", assertionResults: [{ ancestorTitles: [], title: "[A-1] works", fullName: "[A-1] works", status: "passed" }] }] }),
    );
    const rep = runGate({ ...b.opts, requirements: [...REQS, ...reqs] });
    expect(rep.requirementMatrix.find((r) => r.id === "A-1")).toMatchObject({ status: "pass", evidence: ["unit:t.ts#[A-1] works"] });
    expect(rep.blockers).toEqual([]);
    expect(readFileSync(join(b.reportsDir, "coverage-matrix.md"), "utf8")).toContain("| A-1 | required | - | pass | unit:t.ts#[A-1] works |");
  });

  it("wave-3 rows are a non-claim and do not block", () => {
    const b = base();
    const rep = runGate({ ...b.opts, requirements: [...REQS, { id: "PICA-1", disposition: "required", condition: "Wave 3 only" }] });
    expect(rep.blockers).toEqual([]);
    expect(rep.nonClaims).toContain("Wave 3 rows (post-gate, PLAN §15; not built before the gate): PICA-1");
    const c = base();
    expect(runGate({ ...c.opts, requirements: [...REQS, { id: "PICA-1", disposition: "required" }] }).blockers.some((x) => x.startsWith("requirements:"))).toBe(true);
  });

  it("validate suite fails closed when validate.json is missing, unparseable, incomplete or any exit != 0", () => {
    expect(REQUIRED_SUITES).toContain("validate");
    const b = base();
    rmSync(join(b.prereq, "validate.json"));
    const rep = runGate(b.opts);
    expect(rep.suites.find((s) => s.name === "validate")?.ok).toBe(false);
    expect(rep.releaseEligible).toBe(false);
    const c = base();
    writeFileSync(join(c.prereq, "validate.json"), "[");
    expect(runGate(c.opts).blockers.some((x) => x.startsWith("validate") && x.includes("unparseable"))).toBe(true);
    const d = base();
    writeFileSync(join(d.prereq, "validate.json"), JSON.stringify(GOOD_VALIDATE.map((r, i) => (i === 1 ? { ...r, exitCode: 1 } : r))));
    expect(runGate(d.opts).blockers.some((x) => x.startsWith("validate") && x.includes("check:forbidden exit 1"))).toBe(true);
    expect(checkValidateEvidence(GOOD_VALIDATE).ok).toBe(true);
    expect(checkValidateEvidence(GOOD_VALIDATE.slice(1)).problems).toContain("missing check:deps-doc");
    expect(checkValidateEvidence([...GOOD_VALIDATE, GOOD_VALIDATE[0]]).problems).toContain("duplicate check:deps-doc");
    expect(checkValidateEvidence([...GOOD_VALIDATE, { script: "check:x", exitCode: 0 }]).ok).toBe(false);
    expect(checkValidateEvidence({}).ok).toBe(false);
  });

  it("suite evidence: a passing mapped suite passes the row; a failing suite fails it", () => {
    expect(SUITE_REQUIREMENT_EVIDENCE["ARCH-DEP-1"]).toEqual(["validate"]);
    const reqs = [...REQS, { id: "ARCH-DEP-2", disposition: "required" }, { id: "GATE-4", disposition: "required" }];
    const b = base();
    const rep = runGate({ ...b.opts, requirements: reqs });
    expect(rep.requirementMatrix.find((r) => r.id === "ARCH-DEP-2")).toMatchObject({ status: "pass", evidence: ["suite:validate"] });
    expect(rep.requirementMatrix.find((r) => r.id === "GATE-4")).toMatchObject({ status: "pass", evidence: ["suite:wire-scan"] });
    expect(rep.blockers).toEqual([]);
    const c = base();
    writeFileSync(join(c.prereq, "validate.json"), JSON.stringify(GOOD_VALIDATE.map((r) => ({ ...r, exitCode: 2 }))));
    const rep2 = runGate({ ...c.opts, requirements: reqs });
    expect(rep2.requirementMatrix.find((r) => r.id === "ARCH-DEP-2")!.status).toBe("fail");
    expect(rep2.requirementMatrix.find((r) => r.id === "GATE-4")!.status).toBe("pass");
  });

  it("[GATE-2] every requirement row appears in the matrix with its disposition", () => {
    const reqs = [{ id: "X-1", disposition: "required" }, { id: "X-2", disposition: "unresolved" }, { id: "X-3", disposition: "out-of-scope" }];
    const m = buildRequirementMatrix(reqs, [], []);
    expect(m.map((r) => [r.id, r.disposition])).toEqual(reqs.map((r) => [r.id, r.disposition]));
    const b = base();
    const rep = runGate({ ...b.opts, requirements: [] });
    expect(rep.blockers).toContain("requirements: requirements.json rows missing");
  });

  it("[GATE-3] an implemented (required) row without a passing check blocks release", () => {
    const b = base();
    const rep = runGate({ ...b.opts, requirements: [...REQS, { id: "X-9", disposition: "required" }] });
    expect(rep.releaseEligible).toBe(false);
    expect(rep.blockers.some((x) => x.startsWith("requirements: 1 "))).toBe(true);
    const c = base();
    const fail = runGate({ ...c.opts, fixtures: [...FIX], exec: fakeExec({ "run --json": { code: 1, stdout: JSON.stringify({ ok: false, results: [{ id: "wire.a", ok: false }, { id: "ver.b", ok: true }] }) } }).exec });
    expect(fail.requirementMatrix.find((r) => r.id === "R1")!.status).toBe("fail");
    expect(fail.releaseEligible).toBe(false);
  });

  it("[GATE-5] official runner result is recorded even when it fails", () => {
    const b = base({ "official --json": { code: 1, stdout: JSON.stringify({ ok: false, total: 0, reason: "no scenarios" }) } });
    const rep = runGate(b.opts);
    expect(rep.officialBlockedReason).toContain("reason=no scenarios");
    expect(rep.suites.find((s) => s.name === "official")).toMatchObject({ ok: false });
    expect(readFileSync(join(b.reportsDir, `gate-${SHA}.md`), "utf8")).toContain("Official blocked reason: ok=false total=0 reason=no scenarios");
    expect(runGate(base().opts).suites.find((s) => s.name === "official")!.detail).toBe("ok total=5");
  });

  it("[GATE-6] unresolved and out-of-scope rows are enumerated as non-claims", () => {
    const b = base();
    const rep = runGate({ ...b.opts, requirements: [...REQS, { id: "U-1", disposition: "unresolved" }, { id: "O-1", disposition: "out-of-scope" }] });
    expect(rep.nonClaims).toContain("Unresolved requirement rows (no claim): U-1");
    expect(rep.nonClaims).toContain("Out-of-scope requirement rows (listed, not checked): O-1");
    const md = readFileSync(join(b.reportsDir, `gate-${SHA}.md`), "utf8");
    expect(md).toContain("- Unresolved requirement rows (no claim): U-1");
  });

  it("[GATE-7] claim text is generated from the requirement matrix and rendered", () => {
    const b = base();
    const rep = runGate(b.opts);
    expect(rep.claim).toBe("Release eligible: 1/2 requirement rows pass (1/1 required/deprecated/excluded; 0 fail, 1 missing); gate items 12/12 pass. Claims are limited to the passing rows.");
    expect(readFileSync(join(b.reportsDir, `gate-${SHA}.md`), "utf8")).toContain(`## Claim\n\n${rep.claim}`);
    const c = base();
    const rep2 = runGate({ ...c.opts, requirements: [...REQS, { id: "X-9", disposition: "required" }] });
    expect(rep2.claim.startsWith("Not release eligible: 1/3 requirement rows pass (1/2 ")).toBe(true);
  });

  it("gate.sh stages from MCP_CONFORMANCE_CHECKOUT offline, isolates child env to staged dest, and .gitignore ignores .cache/", () => {
    const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    expect(gitignore.split(/\r?\n/)).toContain(".cache/");

    const gateSh = readFileSync(join(repoRoot, "scripts/gate.sh"), "utf8");
    expect(gateSh).toContain("runner.checkoutDir");
    expect(gateSh).toContain('runner_src="${MCP_CONFORMANCE_CHECKOUT:-$ROOT/$runner_rel}"');
    expect(gateSh).not.toContain("GATE_OFFICIAL_CHECKOUT");
    const stageFn = gateSh.match(/stage_official_runner\(\)\s*\{[\s\S]*?\n\}/);
    const isolatedFn = gateSh.match(/isolated\(\)\s*\{[\s\S]*?\n\}/);
    expect(stageFn).not.toBeNull();
    expect(isolatedFn).not.toBeNull();

    const tmp = mkdtempSync(join(tmpdir(), "gate-stage-test-"));
    try {
      const origin = join(tmp, "origin");
      const wt = join(tmp, "wt");
      const prod = join(tmp, "prod");
      const runnerRel = ".cache/conformance/checkout";
      const dest = join(prod, runnerRel);
      const git = (args: string[], cwd?: string) => {
        const r = spawnSync("git", args, { cwd, encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      git(["init", "-q", origin]);
      git(["config", "user.email", "test@example.com"], origin);
      git(["config", "user.name", "Test"], origin);
      writeFileSync(join(origin, "package.json"), JSON.stringify({ name: "staging-fixture", version: "0.2.0-alpha.12", bin: "dist/bin.js" }));
      git(["add", "package.json"], origin);
      git(["commit", "-q", "-m", "c1"], origin);
      const c1 = git(["rev-parse", "HEAD"], origin);
      writeFileSync(join(origin, "extra.txt"), "v2\n");
      git(["add", "extra.txt"], origin);
      git(["commit", "-q", "-m", "c2"], origin);
      git(["worktree", "add", "-q", "--detach", wt, c1], origin);

      // Untracked built output and dependencies inside the local runner worktree.
      mkdirSync(join(wt, "dist"), { recursive: true });
      writeFileSync(join(wt, "dist/bin.js"), "#!/usr/bin/env node\nconsole.log('ok');\n");
      mkdirSync(join(wt, "node_modules/dep"), { recursive: true });
      writeFileSync(join(wt, "node_modules/dep/index.js"), "module.exports = 1;\n");

      // 1. Stage via MCP_CONFORMANCE_CHECKOUT and verify isolated subprocess resolves staged dest, not host env.
      const gateHome = join(tmp, "home");
      const gateTmp = join(tmp, "tmp");
      mkdirSync(prod, { recursive: true });
      mkdirSync(gateHome, { recursive: true });
      mkdirSync(gateTmp, { recursive: true });
      const stageAndIsolate = spawnSync(
        "bash",
        [
          "-euo",
          "pipefail",
          "-c",
          [
            stageFn![0],
            isolatedFn![0],
            `ROOT="$1"; PROD="$2"; runner_rel="$3"; NODE_BIN="$4"`,
            `GATE_HOME="$5"; GATE_TMP="$6"; NPM_CACHE=""; child=""`,
            `BASE_PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin"`,
            `runner_src="\${MCP_CONFORMANCE_CHECKOUT:-\$ROOT/\$runner_rel}"`,
            `stage_official_runner "$runner_src" "$PROD/$runner_rel"`,
            `unset MCP_CONFORMANCE_CHECKOUT`,
            `isolated "$PROD" - GATE_RUNTIME_ROOT="$PROD" -- "$NODE_BIN" -e 'const path=require("node:path"); process.stdout.write(JSON.stringify({ env: process.env.MCP_CONFORMANCE_CHECKOUT ?? null, resolved: path.resolve(process.cwd(), process.env.MCP_CONFORMANCE_CHECKOUT || process.argv[1]) }));' "$runner_rel"`,
          ].join("\n"),
          "_",
          join(tmp, "unused-root"),
          prod,
          runnerRel,
          process.execPath,
          gateHome,
          gateTmp,
        ],
        { encoding: "utf8", env: { ...process.env, MCP_CONFORMANCE_CHECKOUT: wt } },
      );
      expect(stageAndIsolate.status, stageAndIsolate.stderr).toBe(0);
      const childReport = JSON.parse(stageAndIsolate.stdout) as { env: string | null; resolved: string };
      expect(childReport.env).toBeNull();
      expect(childReport.resolved).toBe(dest);
      expect(childReport.resolved).not.toBe(wt);
      expect(statSync(join(dest, ".git")).isDirectory()).toBe(true);
      expect(git(["rev-parse", "HEAD"], dest)).toBe(c1);
      expect(existsSync(join(dest, "dist/bin.js"))).toBe(true);
      expect(existsSync(join(dest, "node_modules/dep/index.js"))).toBe(true);

      const runStage = (src: string, dst: string) =>
        spawnSync("bash", ["-euo", "pipefail", "-c", `${stageFn![0]}\nstage_official_runner "$1" "$2"`, "_", src, dst], { encoding: "utf8" });

      // 2. Non-git directory stages contents without aborting gate.sh.
      const plain = join(tmp, "plain");
      const plainDest = join(tmp, "plain-dest");
      mkdirSync(plain, { recursive: true });
      writeFileSync(join(plain, "marker.txt"), "present\n");
      const r2 = runStage(plain, plainDest);
      expect(r2.status, r2.stderr).toBe(0);
      expect(existsSync(join(plainDest, "marker.txt"))).toBe(true);
      expect(existsSync(join(plainDest, ".git"))).toBe(false);

      // 3. Missing source is a no-op.
      const missingDest = join(tmp, "missing-dest");
      const r3 = runStage(join(tmp, "does-not-exist"), missingDest);
      expect(r3.status, r3.stderr).toBe(0);
      expect(existsSync(missingDest)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
