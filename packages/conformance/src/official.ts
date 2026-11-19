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
 * individual codes. A scenario passes only when its parsed result JSON says so
 * under a declared schema; exit codes alone are never evidence.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/** Declared shape of one scenario's result JSON (from a documented contract only). */
export interface ResultSchema {
  readonly source: string;
  readonly idField: string;
  readonly statusField: string;
  readonly passValue: string | boolean;
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
  let bin: string | undefined;
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) {
    problems.push(`checkout-manifest-missing: ${manifestPath}`);
  } else {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string; version?: string; bin?: string | Record<string, string> };
    if (m.name !== map.runner.package) problems.push(`checkout-name-mismatch: ${String(m.name)} != ${map.runner.package}`);
    if (m.version !== map.runner.version) problems.push(`checkout-version-mismatch: ${String(m.version)} != ${map.runner.version}`);
    const rel = typeof m.bin === "string" ? m.bin : m.bin && Object.values(m.bin).length === 1 ? Object.values(m.bin)[0] : undefined;
    if (!rel) problems.push("checkout-bin-ambiguous: package.json must declare exactly one bin");
    else {
      bin = join(dir, rel);
      if (!existsSync(bin)) problems.push(`checkout-bin-not-built: ${bin} absent`);
    }
  }
  return { head, bin, problems };
}

function lastJsonObject(text: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.startsWith("{")) continue;
    try {
      const v: unknown = JSON.parse(l);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
  }
  return undefined;
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

  const checkoutDir = join(absRoot, map.runner.checkoutDir);
  const checkout = inspectCheckout(checkoutDir, map);
  const cutPath = map.cut.authorized && map.cut.path ? join(absRoot, map.cut.path) : undefined;

  const reasons: string[] = [];
  if (!map.catalog.selected || !map.catalog.authorizedBy) reasons.push(`catalog-not-selected: ${map.catalog.reason}`);
  if (applicable.length === 0) {
    reasons.push(`no-eligible-scenarios: 0 ${map.targetSpecVersion} client scenarios that are non-legacy, non-experimental, non-extension, non-disputed at ${pin.tag}`);
  }
  if (!cutPath) reasons.push(`cut-not-authorized: ${map.cut.reason}`);
  else if (!existsSync(cutPath)) reasons.push(`cut-missing: ${cutPath} absent`);
  if (!map.resultSchema) reasons.push(`result-schema-unavailable: ${map.resultSchemaReason ?? "no documented result JSON schema"}`);
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
    const args = fill(map.runner.clientArgs, { cut: `${process.execPath} ${cutPath!}`, scenario: s.id });
    const r = spawnSync(process.execPath, [bin, ...args], {
      cwd: checkoutDir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, npm_config_offline: "true" },
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`;
    const parsed = lastJsonObject(r.stdout ?? "");
    let error: string | undefined;
    if (!parsed) error = "no result JSON in stdout";
    else if (parsed[schema.idField] !== s.id) error = `result ${schema.idField}=${String(parsed[schema.idField])} != ${s.id}`;
    else if (parsed[schema.statusField] !== schema.passValue) error = `result ${schema.statusField}=${String(parsed[schema.statusField])}`;
    else if (r.status !== 0) error = `exit ${String(r.status)} despite passing result`;
    return { id: s.id, requirements: s.requirements, ok: !error, exitCode: r.status, result: parsed ?? null, evidence: clip(out), ...(error ? { error } : {}) };
  });

  const failed = scenarios.filter((s) => !s.ok).map((s) => `scenario-failed: ${s.id}: ${s.error ?? ""}`);
  return { ok: failed.length === 0, reasons: failed, evidence, pin, targetSpecVersion: map.targetSpecVersion, scenarios, excluded };
}
