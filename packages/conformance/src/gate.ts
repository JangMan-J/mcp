#!/usr/bin/env node
/**
 * Release gate. Runs every evidence suite against the current checkout and writes
 * `<GATE_REPORTS_DIR>/<sha>.md` and `<sha>.json`. Fails closed: any missing suite,
 * missing fixture row, missing required scenario, or unparseable output blocks release.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
export interface GateReport {
  readonly sha: string;
  readonly generatedAt: string;
  readonly transcriptsDir: string;
  readonly suites: readonly SuiteResult[];
  readonly matrix: readonly MatrixRow[];
  readonly missingScenarios: readonly string[];
  readonly nonClaims: readonly string[];
  readonly releaseEligible: boolean;
  readonly blockers: readonly string[];
}

export interface GateOptions {
  readonly root: string;
  readonly reportsDir?: string;
  readonly sha?: string;
  readonly exec?: Exec;
  readonly env?: NodeJS.ProcessEnv;
  readonly requiredScenarios?: readonly string[];
  readonly removalExts?: readonly string[];
  readonly nodeArgs?: readonly string[];
  readonly now?: () => Date;
}

export const REQUIRED_SUITES = ["baseline", "mutation", "coverage", "wire-scan", "no-pi", "official", "removal"] as const;
export const DEFAULT_REMOVAL_EXTS = ["ext-client-credentials", "ext-enterprise-auth", "ext-tasks", "ext-skills"];
export const NON_CLAIMS = [
  "No claim of conformance beyond the fixtures listed in the matrix.",
  "No claim about Pi runtime integration; the gate runs with Pi excluded.",
  "No claim of interoperability with servers not exercised by the official suite.",
  "No performance, load, or security-audit claims.",
];

export const defaultExec: Exec = (cmd, args, env, cwd) => {
  const r = spawnSync(cmd, [...args], { env, cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { code: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.error ? String(r.error) : (r.stderr ?? "") };
};

export function deriveSha(root: string, exec: Exec, env: NodeJS.ProcessEnv): string {
  if (env.GATE_SHA) return env.GATE_SHA;
  const r = exec("git", ["rev-parse", "HEAD"], env, root);
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{7,64}$/.test(sha)) throw new Error(`gate: cannot derive git sha: ${r.stderr.trim()}`);
  return sha;
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

export function runGate(opts: GateOptions): GateReport {
  const exec = opts.exec ?? defaultExec;
  const env = opts.env ?? process.env;
  const root = opts.root;
  const sha = opts.sha ?? deriveSha(root, exec, env);
  const reportsDir = resolve(root, opts.reportsDir ?? env.GATE_REPORTS_DIR ?? "reports/gate");
  const transcriptsDir = join(reportsDir, sha, "transcripts");
  mkdirSync(transcriptsDir, { recursive: true });
  const node = process.execPath;
  const cli = join(root, "packages/conformance/dist/cli.js");
  const gateEnv: NodeJS.ProcessEnv = { ...stripPi(env), MCP_CONFORMANCE_TRANSCRIPTS: transcriptsDir };
  const suites: SuiteResult[] = [];
  const blockers: string[] = [];
  let matrix: MatrixRow[] = [];

  const add = (name: string, ok: boolean, detail: string): void => {
    suites.push({ name, ok, detail });
    if (!ok) blockers.push(`${name}: ${detail}`);
  };

  // baseline
  {
    const r = exec(node, [cli, "run", "--json"], gateEnv, root);
    const j = parseJson(r.stdout) as { ok?: boolean; total?: number; results?: MatrixRow[] } | undefined;
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
    const r = exec(node, [cli, "run", "--mutate", "--json"], gateEnv, root);
    const j = parseJson(r.stdout) as { ok?: boolean; total?: number; passed?: number } | undefined;
    if (!j || typeof j.total !== "number") add("mutation", false, `no parseable results (exit ${r.code}) ${tail(r.stderr)}`);
    else if (j.total === 0) add("mutation", false, "zero mutants");
    else add("mutation", r.code === 0 && j.ok === true, `${j.passed}/${j.total} killed`);
  }
  // coverage
  {
    const r = exec(node, [cli, "check-coverage"], gateEnv, root);
    const j = parseJson(r.stdout) as { ok?: boolean } | undefined;
    add("coverage", r.code === 0 && j?.ok === true, j ? `ok=${j.ok}` : `no parseable report (exit ${r.code}) ${tail(r.stderr)}`);
  }
  // wire-scan
  {
    const r = exec(node, [join(root, "scripts/check-forbidden.mjs")], gateEnv, root);
    add("wire-scan", r.code === 0, `exit ${r.code} ${tail(r.stdout + r.stderr)}`);
  }
  // no-pi runtime wrapper
  {
    const r = exec(node, [join(root, "scripts/assert-no-pi.mjs"), "--", ...(opts.nodeArgs ?? [])], gateEnv, root);
    add("no-pi", r.code === 0, `exit ${r.code} ${tail(r.stdout + r.stderr)}`);
  }
  // official: confirmed blocking
  {
    const r = exec(node, [cli, "official", "--json"], gateEnv, root);
    const j = parseJson(r.stdout) as { ok?: boolean; total?: number } | undefined;
    if (!j) add("official", false, `no parseable report (exit ${r.code}) ${tail(r.stderr)}`);
    else add("official", r.code === 0 && j.ok === true && (j.total ?? 1) > 0, `ok=${j.ok} total=${j.total ?? "?"}`);
  }
  // removal
  {
    const exts = opts.removalExts ?? DEFAULT_REMOVAL_EXTS;
    if (exts.length === 0) add("removal", false, "no extensions checked");
    else {
      const bad: string[] = [];
      for (const e of exts) {
        const r = exec(node, [join(root, "scripts/check-remove-ext.mjs"), e], gateEnv, root);
        if (r.code !== 0) bad.push(`${e} (exit ${r.code})`);
      }
      add("removal", bad.length === 0, bad.length ? `failed: ${bad.join(", ")}` : `${exts.length} extensions removable`);
    }
  }

  for (const s of REQUIRED_SUITES) if (!suites.some((x) => x.name === s)) add(s, false, "suite missing");
  const ids = new Set(matrix.map((m) => m.id));
  const missingScenarios = (opts.requiredScenarios ?? []).filter((s) => !ids.has(s));
  for (const s of missingScenarios) blockers.push(`scenario missing: ${s}`);

  const report: GateReport = {
    sha,
    generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    transcriptsDir,
    suites,
    matrix,
    missingScenarios,
    nonClaims: NON_CLAIMS,
    releaseEligible: blockers.length === 0,
    blockers,
  };
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, `${sha}.json`), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(reportsDir, `${sha}.md`), renderMarkdown(report));
  return report;
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
