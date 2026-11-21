/**
 * Official conformance runner, black-box wrapper (IMPLEMENTATION_PLAN 13.6, FIX-5, G12).
 *
 * The runner is executed only as a subprocess from an explicitly cached local
 * checkout whose git HEAD must equal the documented pin. The executable is the
 * `bin` declared by that checkout's own package.json; nothing is guessed,
 * imported, or downloaded. The CLI contract comes from the pinned README only.
 *
 * Fails closed: `blocked` is a human-readable string whenever any precondition
 * is missing (catalog, CUT, checkout, pin, result schema); `reasons` keeps the
 * individual codes. A scenario passes only when the runner exits 0 and writes
 * exactly one checks.json (declared schema) with >= 1 check and no failing
 * status; exit codes alone are never evidence.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface EligibilityFlags {
  readonly legacy: boolean;
  readonly experimental: boolean;
  readonly extension: boolean;
  readonly disputed: boolean;
}

export interface OfficialScenarioMapping extends Partial<EligibilityFlags> {
  readonly id: string;
  readonly specVersion: string | null;
  readonly requirements: readonly string[];
  readonly reason?: string;
}

/** Declared shape of one scenario's checks file (from a documented contract only). */
export interface ResultSchema {
  readonly source: string;
  /** File name written under the per-scenario output dir. */
  readonly file: string;
  readonly statusField: string;
  readonly passStatus: string;
  readonly failStatuses: readonly string[];
}

export interface OfficialMap {
  readonly runner: {
    readonly repository: string;
    readonly package: string;
    readonly version: string;
    readonly tag: string;
    readonly commit: string;
    readonly source: string;
    readonly checkoutDir: string;
    readonly clientArgs: readonly string[];
    readonly readmeNote?: string;
  };
  readonly targetSpecVersion: string;
  readonly cut: { readonly authorized: boolean; readonly path: string | null; readonly reason: string };
  readonly catalog: { readonly selected: boolean; readonly authorizedBy: string | null; readonly reason: string };
  readonly resultSchema: ResultSchema | null;
  readonly resultSchemaReason?: string;
  readonly eligibility: { readonly specVersion: string; readonly requires: EligibilityFlags; readonly note?: string };
  readonly scenarios: readonly OfficialScenarioMapping[];
  readonly legacy: readonly OfficialScenarioMapping[];
}

export interface OfficialScenarioResult {
  readonly id: string;
  readonly requirements: readonly string[];
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly result: unknown;
  readonly evidence: string;
  readonly error?: string;
}

export interface OfficialResult {
  readonly ok: boolean;
  /** Human-readable blocker; absent when the run was attempted. */
  readonly blocked?: string;
  readonly reasons: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly pin: { readonly tag: string; readonly commit: string };
  readonly targetSpecVersion: string;
  readonly scenarios: readonly OfficialScenarioResult[];
  readonly excluded: readonly { readonly id: string; readonly counted: false; readonly reason: string }[];
}

const MAP_PATH = "packages/conformance/official-map.json";
const EVIDENCE_LIMIT = 2048;
const FLAGS = ["legacy", "experimental", "extension", "disputed"] as const;

export function loadOfficialMap(root: string): OfficialMap {
  return JSON.parse(readFileSync(join(root, MAP_PATH), "utf8")) as OfficialMap;
}

/** Returns null when eligible, otherwise why not. Missing flags are ineligible. */
export function ineligibility(s: OfficialScenarioMapping, map: OfficialMap): string | null {
  if (s.specVersion !== map.eligibility.specVersion) return `specVersion ${String(s.specVersion)} != ${map.eligibility.specVersion}`;
  for (const f of FLAGS) {
    if (typeof s[f] !== "boolean") return `${f} not stated`;
    if (s[f] !== map.eligibility.requires[f]) return `${f}=${String(s[f])}`;
  }
  return null;
}

function clip(s: string): string {
  return s.length > EVIDENCE_LIMIT ? `${s.slice(0, EVIDENCE_LIMIT)}...[truncated]` : s;
}

function fill(args: readonly string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m));
}

interface Checkout {
  readonly head?: string | undefined;
  readonly bin?: string | undefined;
  readonly problems: string[];
}

function inspectCheckout(dir: string, map: OfficialMap): Checkout {
  const problems: string[] = [];
  if (!existsSync(dir)) return { problems: [`checkout-missing: ${dir} absent (explicit local checkout required; no runtime download)`] };
  const git = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" });
  const head = git.status === 0 ? git.stdout.trim() : undefined;
  if (!head) problems.push(`checkout-head-unknown: git rev-parse HEAD failed in ${dir}`);
  else if (head !== map.runner.commit) problems.push(`checkout-pin-mismatch: HEAD ${head} != pin ${map.runner.commit} (${map.runner.tag})`);
  if (!/^[0-9a-f]{40}$/.test(map.runner.commit)) problems.push("checkout-pin-invalid: expected full commit hash");
  const dirty = spawnSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" });
  if (dirty.status !== 0 || dirty.stdout.trim()) problems.push("checkout-dirty: tracked checkout files modified or status unavailable");
  let bin: string | undefined;
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) {
    problems.push(`checkout-manifest-missing: ${manifestPath}`);
  } else {
    let m: { name?: string; version?: string } = {};
    try { m = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { problems.push("checkout-manifest-invalid: invalid package.json"); }
    if (m.name !== map.runner.package) problems.push(`checkout-name-mismatch: ${String(m.name)} != ${map.runner.package}`);
    if (m.version !== map.runner.version) problems.push(`checkout-version-mismatch: ${String(m.version)} != ${map.runner.version}`);
    bin = join(dir, "dist/index.js");
    if (!existsSync(bin)) problems.push(`checkout-bin-not-built: ${bin} absent`);
  }
  return { head, bin, problems };
}

function validSchema(rs: ResultSchema | null): rs is ResultSchema {
  return !!rs && !!rs.source && rs.file === "checks.json" && !!rs.statusField && !!rs.passStatus &&
    Array.isArray(rs.failStatuses) && rs.failStatuses.length > 0 && !rs.failStatuses.includes(rs.passStatus);
}

interface ChecksSummary {
  readonly checks: number;
  readonly passed: number;
  readonly failed: number;
  readonly statuses: Record<string, number>;
}

/** Reads the single checks file under `dir`; returns an error string when the contract is not met. */
function readChecks(dir: string, schema: ResultSchema): { summary?: ChecksSummary; error?: string } {
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.split(/[\\/]/).pop() === schema.file);
  if (files.length !== 1) return { error: `expected exactly one ${schema.file}, found ${files.length}` };
  let checks: unknown;
  try { checks = JSON.parse(readFileSync(join(dir, files[0]!), "utf8")); } catch { return { error: `${schema.file} is not valid JSON` }; }
  if (!Array.isArray(checks)) return { error: `${schema.file} is not an array` };
  const statuses: Record<string, number> = {};
  for (const c of checks) {
    const st = c && typeof c === "object" ? (c as Record<string, unknown>)[schema.statusField] : undefined;
    const key = typeof st === "string" ? st : "<missing>";
    statuses[key] = (statuses[key] ?? 0) + 1;
  }
  const passed = statuses[schema.passStatus] ?? 0;
  const failed = schema.failStatuses.reduce((n, f) => n + (statuses[f] ?? 0), 0) + (statuses["<missing>"] ?? 0);
  const summary = { checks: checks.length, passed, failed, statuses };
  if (checks.length === 0) return { summary, error: `${schema.file} has no checks` };
  if (failed > 0) return { summary, error: `${failed} failing check(s)` };
  return { summary };
}

export async function runOfficial(root: string): Promise<OfficialResult> {
  const absRoot = resolve(root);
  const map = loadOfficialMap(absRoot);
  const pin = { tag: map.runner.tag, commit: map.runner.commit };
  const excluded: { id: string; counted: false; reason: string }[] = [];
  for (const l of map.legacy) excluded.push({ id: l.id, counted: false, reason: l.reason ?? ineligibility(l, map) ?? "listed as legacy" });
  const applicable: OfficialScenarioMapping[] = [];
  for (const s of map.scenarios) {
    const why = ineligibility(s, map);
    if (why) excluded.push({ id: s.id, counted: false, reason: why });
    else applicable.push(s);
  }

  const checkoutDir = process.env.MCP_CONFORMANCE_CHECKOUT ? resolve(process.env.MCP_CONFORMANCE_CHECKOUT) : resolve(absRoot, map.runner.checkoutDir);
  const checkout = inspectCheckout(checkoutDir, map);
  const cutPath = map.cut.authorized && map.cut.path ? join(absRoot, map.cut.path) : undefined;

  const reasons: string[] = [];
  if (!map.catalog.selected || !map.catalog.authorizedBy) reasons.push(`catalog-not-selected: ${map.catalog.reason}`);
  if (applicable.length === 0) {
    reasons.push(`no-eligible-scenarios: 0 ${map.targetSpecVersion} client scenarios that are non-legacy, non-experimental, non-extension, non-disputed at ${pin.tag}`);
  }
  if (!cutPath) reasons.push(`cut-not-authorized: ${map.cut.reason}`);
  else if (!existsSync(cutPath)) reasons.push(`cut-missing: ${cutPath} absent`);
  if (!validSchema(map.resultSchema)) reasons.push(`result-schema-unavailable: ${map.resultSchemaReason ?? "no documented result JSON schema"}`);
  reasons.push(...checkout.problems);

  const evidence: Record<string, unknown> = {
    source: map.runner.source,
    repository: map.runner.repository,
    package: map.runner.package,
    checkoutDir,
    checkoutHead: checkout.head ?? null,
    runnerBin: checkout.bin ?? null,
    cut: cutPath ?? null,
    catalogSelected: map.catalog.selected,
    catalogAuthorizedBy: map.catalog.authorizedBy,
    resultSchema: map.resultSchema,
    mappedScenarios: map.scenarios.length,
    eligibleScenarios: applicable.length,
    readmeNote: map.runner.readmeNote,
  };

  if (reasons.length > 0) {
    const blocked = `official runner blocked at ${pin.tag} (${pin.commit.slice(0, 12)}): ${reasons.map((r) => r.split(":")[0]).join(", ")}`;
    return { ok: false, blocked, reasons, evidence, pin, targetSpecVersion: map.targetSpecVersion, scenarios: [], excluded };
  }

  const schema = map.resultSchema!;
  const bin = checkout.bin!;
  const scenarios: OfficialScenarioResult[] = applicable.map((s) => {
    const outputDir = mkdtempSync(join(tmpdir(), "mcp-official-"));
    try {
      const args = fill(map.runner.clientArgs, { cut: `${process.execPath} ${cutPath!}`, scenario: s.id, outputDir });
      const r = spawnSync(process.execPath, [bin, ...args], {
        cwd: checkoutDir,
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, npm_config_offline: "true" },
      });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`;
      const { summary, error: checksError } = readChecks(outputDir, schema);
      const error = checksError ?? (r.status !== 0 ? `exit ${String(r.status)} despite passing checks` : undefined);
      return { id: s.id, requirements: s.requirements, ok: !error, exitCode: r.status, result: summary ?? null, evidence: clip(out), ...(error ? { error } : {}) };
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  const failed = scenarios.filter((s) => !s.ok).map((s) => `scenario-failed: ${s.id}: ${s.error ?? ""}`);
  return { ok: failed.length === 0, reasons: failed, evidence, pin, targetSpecVersion: map.targetSpecVersion, scenarios, excluded };
}
