#!/usr/bin/env node
/**
 * Release gate. Runs every evidence suite against the current checkout and writes
 * `<GATE_REPORTS_DIR>/<sha>.md` and `<sha>.json`. Fails closed: any missing suite,
 * missing fixture row, missing required scenario, or unparseable output blocks release.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
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
  readonly evidence: RunEvidence;
  readonly nonClaims: readonly string[];
  readonly releaseEligible: boolean;
  readonly blockers: readonly string[];
}

export interface RunEvidence {
  readonly node: string;
  readonly os: string;
  readonly lockfileSha256: string | null;
  readonly pinsSha256: string | null;
  readonly removal: readonly RemovalRow[];
}
export interface RemovalRow {
  readonly ext: string;
  readonly exitCode: number;
  readonly log?: string;
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
  readonly nodeArgs?: readonly string[];
  readonly requirements?: readonly RequirementInput[];
  readonly fixtures?: readonly FixtureInput[];
  /** Mapping of gate items G1..G12 to the suite that evidences them. Unmapped items are missing. */
  readonly gateItemMap?: Readonly<Record<string, string | readonly string[]>>;
  readonly now?: () => Date;
}

export const REQUIRED_SUITES = ["baseline", "mutation", "coverage", "wire-scan", "network-scan", "secret-scan", "no-pi", "official", "removal", "evidence"] as const;
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
/** Env var naming the prereq dir where scripts/gate.sh writes remove-ext.json (dev toolchain stays out of production). */
export const PREREQ_DIR_ENV = "GATE_PREREQ_DIR";
/** Prefix for gate-item entries that name fixture groups instead of suites. */
export const FIXTURE_PREFIX = "fixtures:";
/**
 * Gate items (PLAN §14.3/§14.4) mapped to suites and fixture groups. An item passes only when every entry passes.
 * A `fixtures:<id-or-glob>` entry passes only when >=1 baseline row matches, every matching row passes, and the
 * mutation suite passed. Plan names with no fixture under packages/fixtures/exchanges are omitted:
 * edge/EDGE-1, arch/close-settles-all, stdio/legacy-peer-diagnostic, consent/* (consent fixtures live in elic/, auth/).
 */
export const DEFAULT_GATE_ITEM_MAP: Readonly<Record<string, readonly string[]>> = {
  G1: ["baseline", "mutation", "fixtures:stdio/concurrent-out-of-order", "fixtures:sub/two-listeners-demux*"],
  G2: [
    "fixtures:wire/cancel*",
    "fixtures:http/abort-closes-stream",
    "fixtures:stdio/shutdown-escalation",
    "fixtures:stdio/cancel-inflight",
  ],
  G3: ["fixtures:elic/*"],
  G4: ["fixtures:auth/*"],
  G5: ["fixtures:cache/*"],
  G6: ["fixtures:sub/*"],
  G7: ["fixtures:stdio/crash-*", "fixtures:http/stream-break-*", "fixtures:http/5xx-write-uncertain"],
  G8: ["fixtures:ops/*", "fixtures:wire/*"],
  G9: ["fixtures:ver/*", "fixtures:http/400-modern-error-vs-legacy"],
  G10: ["removal", "fixtures:ext/*"],
  G11: ["no-pi", "wire-scan", "network-scan", "secret-scan"],
  G12: ["official", "evidence"],
};

/** Plan-named fixture ids absent from packages/fixtures/exchanges; listed in the G-item detail. */
export const OMITTED_PLAN_FIXTURES = ["edge/EDGE-1", "arch/close-settles-all", "stdio/legacy-peer-diagnostic", "consent/*"];

/** Default eligible scenarios: the exact (non-glob) fixture ids named by G1-G11, sorted. */
export const DEFAULT_GATE_SCENARIOS: readonly string[] = [
  ...new Set(
    GATE_ITEM_IDS.slice(0, 11)
      .flatMap((g) => DEFAULT_GATE_ITEM_MAP[g] ?? [])
      .filter((e) => e.startsWith(FIXTURE_PREFIX) && !e.includes("*"))
      .map((e) => e.slice(FIXTURE_PREFIX.length)),
  ),
].sort();

/** Match a fixture id against an exact id or a `*` glob. */
export function matchFixture(pattern: string, id: string): boolean {
  if (!pattern.includes("*")) return pattern === id;
  const esc = (p: string): string => p.replace(/[.+?^$()|[\]\\{}]/g, "\\$&");
  return new RegExp("^" + pattern.split("*").map(esc).join(".*") + "$").test(id);
}

/** Dispositions that block release unless their row passes. */
export const BLOCKING_DISPOSITIONS = ["required", "deprecated", "excluded"];

/** Parse and validate shell removal evidence: exactly the eight known extensions, unique, all exit 0. */
export function checkRemovalEvidence(raw: unknown): { ok: boolean; rows: RemovalRow[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(raw)) return { ok: false, rows: [], problems: ["remove-ext.json is not an array"] };
  const rows: RemovalRow[] = [];
  const seen = new Set<string>();
  for (const r of raw as Array<Record<string, unknown>>) {
    const ext = typeof r?.ext === "string" ? r.ext : undefined;
    const code = typeof r?.exitCode === "number" ? r.exitCode : undefined;
    if (!ext || code === undefined) {
      problems.push(`malformed row ${JSON.stringify(r)}`);
      continue;
    }
    rows.push({ ext, exitCode: code, ...(typeof r.log === "string" ? { log: r.log } : {}) });
    if (!ALL_EXTENSIONS.includes(ext)) problems.push(`unknown extension ${ext}`);
    if (seen.has(ext)) problems.push(`duplicate ${ext}`);
    seen.add(ext);
    if (code !== 0) problems.push(`${ext} exit ${code}`);
  }
  for (const e of ALL_EXTENSIONS) if (!seen.has(e)) problems.push(`missing ${e}`);
  return { ok: problems.length === 0, rows, problems };
}

function sha256File(p: string): string | null {
  return existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null;
}
/** A pin table counts only when present and free of placeholder markers. */
function pinsPartial(p: string): boolean {
  return !existsSync(p) || /\b(TBD|TODO|unpinned|partial)\b/i.test(readFileSync(p, "utf8"));
}
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
  for (const name of ["network-scan", "secret-scan"]) {
    const r = exec(node, [join(root, `scripts/${name}.mjs`), transcriptsDir], gateEnv, root);
    add(name, r.code === 0, `exit ${r.code} ${tail(r.stdout + r.stderr)}`);
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
  // removal: shell prereq evidence (dev toolchain ran outside this production runtime)
  let removalRows: RemovalRow[] = [];
  {
    const dir = env[PREREQ_DIR_ENV] ? resolve(env[PREREQ_DIR_ENV]!) : undefined;
    const file = dir ? join(dir, "remove-ext.json") : undefined;
    if (!file) add("removal", false, `${PREREQ_DIR_ENV} unset; removal evidence missing`);
    else if (!existsSync(file)) add("removal", false, `${file} missing`);
    else {
      const raw = parseJson(readFileSync(file, "utf8"));
      if (raw === undefined) add("removal", false, `${file} unparseable`);
      else {
        const c = checkRemovalEvidence(raw);
        removalRows = c.rows;
        add("removal", c.ok, c.ok ? `${ALL_EXTENSIONS.length} extensions removable` : c.problems.join("; "));
      }
    }
  }
  // evidence: environment, lockfile and pin table hashes
  const pinsPath = join(root, "docs/conformance/PINS.md");
  const evidence: RunEvidence = {
    node: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    lockfileSha256: sha256File(join(root, "package-lock.json")),
    pinsSha256: sha256File(pinsPath),
    removal: removalRows,
  };
  {
    const gaps: string[] = [];
    if (!evidence.lockfileSha256) gaps.push("package-lock.json missing");
    if (!evidence.pinsSha256) gaps.push("PINS.md missing");
    else if (pinsPartial(pinsPath)) gaps.push("PINS.md partial");
    add("evidence", gaps.length === 0, gaps.length ? gaps.join("; ") : `lock ${evidence.lockfileSha256!.slice(0, 12)} pins ${evidence.pinsSha256!.slice(0, 12)}`);
  }
  for (const s of REQUIRED_SUITES) if (!suites.some((x) => x.name === s)) add(s, false, "suite missing");

  // Scenarios: explicit, nonempty, each an actual passing row.
  // Default: DEFAULT_GATE_SCENARIOS when neither the option nor GATE_SCENARIOS is set.
  const envScenarios = env.GATE_SCENARIOS !== undefined ? env.GATE_SCENARIOS.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const scenarios = [...(opts.requiredScenarios ?? envScenarios ?? DEFAULT_GATE_SCENARIOS)];
  if (scenarios.length === 0) blockers.push("scenarios: no explicit eligible scenarios given");
  const passing = new Set(matrix.filter((m) => m.ok).map((m) => m.id));
  const missingScenarios = scenarios.filter((s) => !passing.has(s));
  for (const s of missingScenarios) blockers.push(`scenario missing or not passing: ${s}`);

  // Requirement-row matrix
  const reqs = opts.requirements ?? loadRequirements(root);
  const fixtures = opts.fixtures ?? loadFixtures(root);
  const requirementMatrix = buildRequirementMatrix(reqs, fixtures, matrix);
  if (reqs.length === 0) blockers.push("requirements: requirements.json rows missing");
  const reqGap = requirementMatrix.filter((r) => BLOCKING_DISPOSITIONS.includes(r.disposition) && r.status !== "pass");
  if (reqGap.length) blockers.push(`requirements: ${reqGap.length} required/deprecated/excluded rows not pass (missing/fail)`);
  const nonClaims = [...NON_CLAIMS];
  const unresolved = requirementMatrix.filter((r) => r.disposition === "unresolved");
  if (unresolved.length) nonClaims.push(`Unresolved requirement rows (no claim): ${unresolved.map((r) => r.id).join(", ")}`);
  const oos = requirementMatrix.filter((r) => r.disposition.startsWith("out-of-scope"));
  if (oos.length) nonClaims.push(`Out-of-scope requirement rows (listed, not checked): ${oos.map((r) => r.id).join(", ")}`);
  const otherNotPass = requirementMatrix.filter(
    (r) => !BLOCKING_DISPOSITIONS.includes(r.disposition) && r.disposition !== "unresolved" && !r.disposition.startsWith("out-of-scope") && r.status !== "pass",
  );
  if (otherNotPass.length) nonClaims.push(`Non-required requirement rows without passing evidence (no claim): ${otherNotPass.map((r) => r.id).join(", ")}`);

  // Gate items G1..G12: pass only when every mapped suite / fixture group passes.
  const map = opts.gateItemMap ?? DEFAULT_GATE_ITEM_MAP;
  const mutationOk = suites.find((x) => x.name === "mutation")?.ok === true;
  const fixtureEntry = (pattern: string): { status: Evidence; detail: string } => {
    const rows = matrix.filter((m) => matchFixture(pattern, m.id));
    if (rows.length === 0) return { status: "missing", detail: `fixtures ${pattern}: no matching rows` };
    const bad = rows.filter((m) => !m.ok).map((m) => m.id);
    if (bad.length) return { status: "fail", detail: `fixtures ${pattern}: failing ${bad.join(", ")}` };
    if (!mutationOk) return { status: "fail", detail: `fixtures ${pattern}: mutation suite not passing` };
    return { status: "pass", detail: `fixtures ${pattern}: ${rows.length} pass` };
  };
  const gateItems: GateItem[] = GATE_ITEM_IDS.map((id) => {
    const m = map[id];
    const names = m === undefined ? [] : typeof m === "string" ? [m] : [...m];
    if (names.length === 0) return { id, status: "missing", detail: "not mapped" };
    const suiteNames = names.filter((n) => !n.startsWith(FIXTURE_PREFIX));
    const found = suiteNames.map((n) => suites.find((x) => x.name === n));
    const absent = suiteNames.filter((_, i) => !found[i]);
    if (absent.length) return { id, status: "missing", detail: `suite ${absent.join(", ")} absent` };
    const fx = names.filter((n) => n.startsWith(FIXTURE_PREFIX)).map((n) => fixtureEntry(n.slice(FIXTURE_PREFIX.length)));
    const details = [...(suiteNames.length ? [`suite ${suiteNames.join(", ")}`] : []), ...fx.map((f) => f.detail)];
    if (id === "G2" || id === "G1") details.push(`omitted (no fixture): ${OMITTED_PLAN_FIXTURES.join(", ")}`);
    const statuses: Evidence[] = [...found.map((s) => (s!.ok ? "pass" : "fail") as Evidence), ...fx.map((f) => f.status)];
    const status: Evidence = statuses.includes("fail") ? "fail" : statuses.includes("missing") ? "missing" : "pass";
    return { id, status, detail: details.join("; ") };
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
    evidence,
    nonClaims,
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
  l.push("", "## Evidence", "", `- Node: ${r.evidence.node}`, `- OS: ${r.evidence.os}`, `- SHA: ${r.sha}`);
  l.push(`- package-lock.json sha256: ${r.evidence.lockfileSha256 ?? "missing"}`, `- PINS.md sha256: ${r.evidence.pinsSha256 ?? "missing"}`);
  for (const x of r.evidence.removal) l.push(`- remove ${x.ext}: exit ${x.exitCode}${x.log ? ` (${x.log})` : ""}`);
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
