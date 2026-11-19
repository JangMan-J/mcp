#!/usr/bin/env node
/**
 * Release gate. Runs every evidence suite against the current checkout and writes
 * `<GATE_REPORTS_DIR>/<sha>.md` and `<sha>.json`. Fails closed: any missing suite,
 * missing fixture row, missing required scenario, or unparseable output blocks release.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { loadExchangeFiles } from "@mcp-client/fixtures";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type Exec = (cmd: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) => ExecResult;

export interface SuiteResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
export interface MatrixRow {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
}
export type Evidence = "pass" | "fail" | "missing";
export interface RequirementMatrixRow {
  readonly id: string;
  readonly disposition: string;
  readonly fixtures: readonly string[];
  readonly status: Evidence;
}
export interface GateItem {
  readonly id: string;
  readonly status: Evidence;
  readonly detail: string;
}
export interface GateReport {
  readonly sha: string;
  readonly generatedAt: string;
  readonly transcriptsDir: string;
  readonly suites: readonly SuiteResult[];
  readonly matrix: readonly MatrixRow[];
  readonly requirementMatrix: readonly RequirementMatrixRow[];
  readonly gateItems: readonly GateItem[];
  readonly scenarios: readonly string[];
  readonly missingScenarios: readonly string[];
  readonly officialBlockedReason: string | null;
  readonly nonClaims: readonly string[];
  readonly releaseEligible: boolean;
  readonly blockers: readonly string[];
}

export interface RequirementInput {
  readonly id: string;
  readonly disposition: string;
}
export interface FixtureInput {
  readonly id: string;
  readonly requirements: readonly string[];
}

export interface GateOptions {
  readonly root: string;
  readonly reportsDir?: string;
  readonly sha?: string;
  readonly exec?: Exec;
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit eligible scenarios; must be nonempty and all present as passing fixture rows. */
  readonly requiredScenarios?: readonly string[];
  readonly removalExts?: readonly string[];
  readonly nodeArgs?: readonly string[];
  readonly requirements?: readonly RequirementInput[];
  readonly fixtures?: readonly FixtureInput[];
  /** Mapping of gate items G1..G12 to the suite that evidences them. Unmapped items are missing. */
  readonly gateItemMap?: Readonly<Record<string, string>>;
  readonly now?: () => Date;
}

export const REQUIRED_SUITES = ["baseline", "mutation", "coverage", "wire-scan", "no-pi", "official", "removal"] as const;
export const ALL_EXTENSIONS = [
  "ext-apps",
  "ext-client-credentials",
  "ext-enterprise-auth",
  "ext-events",
  "ext-events-webhook",
  "ext-server-cards",
  "ext-skills",
  "ext-tasks",
];
export const GATE_ITEM_IDS = Array.from({ length: 12 }, (_, i) => `G${i + 1}`);
/** Env var naming the development workspace in which removal checks run (agreed with shell card). */
export const DEV_WORKSPACE_ENV = "GATE_DEV_WORKSPACE";
export const NON_CLAIMS = [
  "No claim of conformance beyond the requirement rows marked pass in the coverage matrix.",
  "No claim about Pi runtime integration; the gate runs with Pi excluded.",
  "No claim of interoperability with servers not exercised by the official suite.",
  "No claim for a gate item (G1-G12) reported missing.",
  "No performance, load, or security-audit claims.",
];

export const defaultExec: Exec = (cmd, args, env, cwd) => {
  const r = spawnSync(cmd, [...args], { env, cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { code: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.error ? String(r.error) : (r.stderr ?? "") };
};

const SHA_RE = /^[0-9a-f]{40}$/;
export function validateSha(sha: string): string {
  if (!SHA_RE.test(sha)) throw new Error(`gate: invalid sha '${sha}' (need 40 lowercase hex)`);
  return sha;
}

export function deriveSha(root: string, exec: Exec, env: NodeJS.ProcessEnv): string {
  if (env.GATE_SHA) return validateSha(env.GATE_SHA);
  const r = exec("git", ["rev-parse", "HEAD"], env, root);
  if (r.code !== 0) throw new Error(`gate: cannot derive git sha: ${r.stderr.trim()}`);
  return validateSha(r.stdout.trim());
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function tail(s: string): string {
  return s.trim().split("\n").slice(-5).join(" | ").slice(0, 500);
}

function stripPi(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("PI_") && k !== "NODE_PATH") out[k] = v;
  return out;
}

function loadRequirements(root: string): RequirementInput[] {
  const p = join(root, "packages/conformance/requirements.json");
  if (!existsSync(p)) return [];
  const doc = JSON.parse(readFileSync(p, "utf8")) as { rows?: RequirementInput[] };
  return (doc.rows ?? []).map((r) => ({ id: r.id, disposition: r.disposition }));
}

function loadFixtures(root: string): FixtureInput[] {
  const dir = join(root, "packages/fixtures/exchanges");
  if (!existsSync(dir)) return [];
  return loadExchangeFiles(dir).map((f) => ({ id: f.id, requirements: f.requirements }));
}

export function buildRequirementMatrix(
  reqs: readonly RequirementInput[],
  fixtures: readonly FixtureInput[],
  results: readonly MatrixRow[],
): RequirementMatrixRow[] {
  const byReq = new Map<string, string[]>();
  for (const f of fixtures) for (const r of f.requirements) byReq.set(r, [...(byReq.get(r) ?? []), f.id]);
  const res = new Map<string, boolean[]>();
  for (const r of results) res.set(r.id, [...(res.get(r.id) ?? []), r.ok]);
  return reqs.map((r) => {
    const fx = byReq.get(r.id) ?? [];
    const oks = fx.flatMap((f) => res.get(f) ?? []);
    const withResult = fx.filter((f) => res.has(f));
    let status: Evidence;
    if (fx.length === 0 || withResult.length < fx.length) status = oks.includes(false) ? "fail" : "missing";
    else status = oks.every(Boolean) ? "pass" : "fail";
    return { id: r.id, disposition: r.disposition, fixtures: fx, status };
  });
}

export function runGate(opts: GateOptions): GateReport {
  const exec = opts.exec ?? defaultExec;
  const env = opts.env ?? process.env;
  const root = opts.root;
  const sha = opts.sha !== undefined ? validateSha(opts.sha) : deriveSha(root, exec, env);
  const reportsDir = resolve(root, opts.reportsDir ?? env.GATE_REPORTS_DIR ?? "reports");
  mkdirSync(reportsDir, { recursive: true });
  // Fresh per-run transcript directory.
  const transcriptsDir = mkdtempSync(join(reportsDir, `gate-${sha}-transcripts-`));
  const node = process.execPath;
  const cli = join(root, "packages/conformance/dist/cli.js");
  const noPi = join(root, "scripts/assert-no-pi.mjs");
  const gateEnv: NodeJS.ProcessEnv = { ...stripPi(env), MCP_CONFORMANCE_TRANSCRIPTS: transcriptsDir };
  const suites: SuiteResult[] = [];
  const blockers: string[] = [];
  let matrix: MatrixRow[] = [];
  let officialBlockedReason: string | null = null;

  const add = (name: string, ok: boolean, detail: string): void => {
    suites.push({ name, ok, detail });
    if (!ok) blockers.push(`${name}: ${detail}`);
  };
  // Built CLI runs only inside the no-Pi wrapper: node assert-no-pi.mjs -- <node-args> cli.js ...
  const wrapped = (...cliArgs: string[]): ExecResult =>
    exec(node, [noPi, "--", ...(opts.nodeArgs ?? []), cli, ...cliArgs], gateEnv, root);

  // no-pi: wrapper self-check
  {
    const r = exec(node, [noPi, "--", ...(opts.nodeArgs ?? []), "-e", ""], gateEnv, root);
    add("no-pi", r.code === 0, `exit ${r.code} ${tail(r.stdout + r.stderr)}`);
  }
  // baseline
  {
    const r = wrapped("run", "--json");
    const j = parseJson(r.stdout) as { ok?: boolean; results?: MatrixRow[] } | undefined;
    if (!j || !Array.isArray(j.results)) add("baseline", false, `no parseable results (exit ${r.code}) ${tail(r.stderr)}`);
    else {
      matrix = j.results.map((x) => ({ id: x.id, ok: x.ok === true, ...(x.error ? { error: x.error } : {}) }));
      const failed = matrix.filter((m) => !m.ok).length;
      if (matrix.length === 0) add("baseline", false, "zero fixture rows");
      else add("baseline", r.code === 0 && j.ok === true && failed === 0, `${matrix.length - failed}/${matrix.length} passed`);
    }
  }
  // mutation
  {
    const r = wrapped("run", "--mutate", "--json");
    const j = parseJson(r.stdout) as { ok?: boolean; total?: number; passed?: number } | undefined;
    if (!j || typeof j.total !== "number") add("mutation", false, `no parseable results (exit ${r.code}) ${tail(r.stderr)}`);
    else if (j.total === 0) add("mutation", false, "zero mutants");
    else add("mutation", r.code === 0 && j.ok === true, `${j.passed}/${j.total} killed`);
  }
  // coverage
  {
    const r = wrapped("check-coverage");
    const j = parseJson(r.stdout) as { ok?: boolean } | undefined;
    add("coverage", r.code === 0 && j?.ok === true, j ? `ok=${j.ok}` : `no parseable report (exit ${r.code}) ${tail(r.stderr)}`);
  }
  // wire-scan over this run's transcripts
  {
    const script = join(root, "scripts/wire-scan.mjs");
    const r = exec(node, [script, transcriptsDir], gateEnv, root);
    add("wire-scan", r.code === 0, `exit ${r.code} ${tail(r.stdout + r.stderr)}`);
  }
  // official: blocking; reason retained
  {
    const r = wrapped("official", "--json");
    const j = parseJson(r.stdout) as { ok?: boolean; total?: number; reason?: string } | undefined;
    const ok = r.code === 0 && j?.ok === true && typeof j.total === "number" && j.total > 0;
    if (!ok) {
      officialBlockedReason = j
        ? `ok=${j.ok} total=${j.total ?? "?"}${j.reason ? ` reason=${j.reason}` : ""} (exit ${r.code})`
        : `no parseable report (exit ${r.code}) ${tail(r.stdout + r.stderr)}`;
    }
    add("official", ok, ok ? `ok total=${j!.total}` : officialBlockedReason!);
  }
  // removal: all eight extensions, from the development workspace
  {
    const ws = env[DEV_WORKSPACE_ENV] ? resolve(env[DEV_WORKSPACE_ENV]!) : undefined;
    const exts = opts.removalExts ?? ALL_EXTENSIONS;
    if (!ws) add("removal", false, `${DEV_WORKSPACE_ENV} unset; removal evidence missing`);
    else if (exts.length === 0) add("removal", false, "no extensions checked");
    else {
      const bad: string[] = [];
      for (const e of exts) {
        const r = exec(node, [join(ws, "scripts/check-remove-ext.mjs"), e], gateEnv, ws);
        if (r.code !== 0) bad.push(`${e} (exit ${r.code})`);
      }
      add("removal", bad.length === 0, bad.length ? `failed: ${bad.join(", ")}` : `${exts.length} extensions removable`);
    }
  }
  for (const s of REQUIRED_SUITES) if (!suites.some((x) => x.name === s)) add(s, false, "suite missing");

  // Scenarios: explicit, nonempty, each an actual passing row.
  const scenarios = [...(opts.requiredScenarios ?? (env.GATE_SCENARIOS ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (scenarios.length === 0) blockers.push("scenarios: no explicit eligible scenarios given");
  const passing = new Set(matrix.filter((m) => m.ok).map((m) => m.id));
  const missingScenarios = scenarios.filter((s) => !passing.has(s));
  for (const s of missingScenarios) blockers.push(`scenario missing or not passing: ${s}`);

  // Requirement-row matrix
  const reqs = opts.requirements ?? loadRequirements(root);
  const fixtures = opts.fixtures ?? loadFixtures(root);
  const requirementMatrix = buildRequirementMatrix(reqs, fixtures, matrix);
  if (reqs.length === 0) blockers.push("requirements: requirements.json rows missing");
  const reqGap = requirementMatrix.filter((r) => r.disposition === "required" && r.status !== "pass");
  if (reqGap.length) blockers.push(`requirements: ${reqGap.length} required rows not pass (missing/fail)`);

  // Gate items G1..G12: pass only when mapped to a passing suite.
  const map = opts.gateItemMap ?? {};
  const gateItems: GateItem[] = GATE_ITEM_IDS.map((id) => {
    const suite = map[id];
    if (!suite) return { id, status: "missing", detail: "not mapped" };
    const s = suites.find((x) => x.name === suite);
    if (!s) return { id, status: "missing", detail: `suite ${suite} absent` };
    return { id, status: s.ok ? "pass" : "fail", detail: `suite ${suite}` };
  });
  for (const g of gateItems) if (g.status !== "pass") blockers.push(`${g.id}: ${g.status} (${g.detail})`);

  const report: GateReport = {
    sha,
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    transcriptsDir,
    suites,
    matrix,
    requirementMatrix,
    gateItems,
    scenarios,
    missingScenarios,
    officialBlockedReason,
    nonClaims: NON_CLAIMS,
    releaseEligible: blockers.length === 0,
    blockers,
  };
  writeFileSync(join(reportsDir, `gate-${sha}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(reportsDir, `gate-${sha}.md`), renderMarkdown(report));
  writeFileSync(join(reportsDir, "coverage-matrix.md"), renderCoverageMatrix(report));
  return report;
}

export function renderCoverageMatrix(r: GateReport): string {
  const l = [`# Coverage matrix ${r.sha}`, "", "| Requirement | Disposition | Fixtures | Status |", "|---|---|---|---|"];
  for (const m of r.requirementMatrix) l.push(`| ${m.id} | ${m.disposition} | ${m.fixtures.join(", ") || "-"} | ${m.status} |`);
  if (r.requirementMatrix.length === 0) l.push("| (none) | - | - | missing |");
  return l.join("\n") + "\n";
}

export function renderMarkdown(r: GateReport): string {
  const l: string[] = [];
  l.push(`# Release gate ${r.sha}`, "", `Generated: ${r.generatedAt}`, "");
  l.push(`**Release eligible: ${r.releaseEligible ? "yes" : "no"}**`, "");
  l.push("## Suites", "", "| Suite | Result | Detail |", "|---|---|---|");
  for (const s of r.suites) l.push(`| ${s.name} | ${s.ok ? "PASS" : "FAIL"} | ${s.detail.replace(/\|/g, "\\|")} |`);
  l.push("", "## Fixture matrix", "", "| Fixture | Result | Error |", "|---|---|---|");
  for (const m of r.matrix) l.push(`| ${m.id} | ${m.ok ? "PASS" : "FAIL"} | ${(m.error ?? "").replace(/\|/g, "\\|")} |`);
  if (r.matrix.length === 0) l.push("| (none) | FAIL | no rows |");
  l.push("", "## Gate items", "", "| Item | Status | Detail |", "|---|---|---|");
  for (const g of r.gateItems) l.push(`| ${g.id} | ${g.status} | ${g.detail} |`);
  const counts = { pass: 0, fail: 0, missing: 0 };
  for (const m of r.requirementMatrix) counts[m.status]++;
  l.push("", `Requirement rows: ${counts.pass} pass, ${counts.fail} fail, ${counts.missing} missing (see coverage-matrix.md)`);
  l.push("", `Official blocked reason: ${r.officialBlockedReason ?? "none"}`);
  l.push("", "## Non-claims", "", ...r.nonClaims.map((n) => `- ${n}`));
  l.push("", "## Blockers", "", ...(r.blockers.length ? r.blockers.map((b) => `- ${b}`) : ["- none"]), "");
  return l.join("\n");
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const dd = process.argv.indexOf("--");
  const nodeArgs = dd >= 0 ? process.argv.slice(dd + 1) : [];
  try {
    const rep = runGate({ root, nodeArgs });
    console.log(`gate ${rep.sha}: ${rep.releaseEligible ? "ELIGIBLE" : "BLOCKED"}`);
    for (const b of rep.blockers) console.log(`  - ${b}`);
    process.exit(rep.releaseEligible ? 0 : 1);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}
