/**
 * Official conformance runner, black-box wrapper (IMPLEMENTATION_PLAN 13.6, FIX-5, G12).
 *
 * The runner is executed only as a subprocess from a locally cached, pinned
 * checkout. It is never imported, never downloaded at runtime, and never read
 * for design. Its CLI contract is taken from the pinned tag README only.
 *
 * Fails closed: with no selected 2026-07-28 client scenario catalog, or no
 * cached runner, the result is `{ ok: false, blocked: true }` with evidence.
 * Legacy scenarios are listed for the record and never counted.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface OfficialRunnerPin {
  readonly repository: string;
  readonly package: string;
  readonly tag: string;
  readonly commit: string;
  readonly source: string;
  readonly cacheDir: string;
  readonly entry: string;
  readonly clientArgs: readonly string[];
  readonly readmeNote?: string;
}

export interface OfficialScenarioMapping {
  readonly id: string;
  readonly requirements: readonly string[];
  readonly disputed?: boolean;
}

export interface OfficialMap {
  readonly runner: OfficialRunnerPin;
  readonly targetSpecVersion: string;
  readonly cut: string;
  readonly catalog: { readonly selected: boolean; readonly reason: string };
  readonly scenarios: readonly OfficialScenarioMapping[];
  readonly legacy: readonly { readonly id: string; readonly reason: string }[];
}

export interface OfficialScenarioResult {
  readonly id: string;
  readonly requirements: readonly string[];
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly evidence: string;
}

export interface OfficialResult {
  readonly ok: boolean;
  readonly blocked?: boolean;
  readonly reasons: readonly string[];
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly pin: { readonly tag: string; readonly commit: string };
  readonly targetSpecVersion: string;
  readonly scenarios: readonly OfficialScenarioResult[];
  readonly legacy: readonly { readonly id: string; readonly counted: false; readonly reason: string }[];
}

const MAP_PATH = "packages/conformance/official-map.json";
const EVIDENCE_LIMIT = 2048;

export function loadOfficialMap(root: string): OfficialMap {
  return JSON.parse(readFileSync(join(root, MAP_PATH), "utf8")) as OfficialMap;
}

function fill(args: readonly string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m));
}

function clip(s: string): string {
  return s.length > EVIDENCE_LIMIT ? `${s.slice(0, EVIDENCE_LIMIT)}...[truncated]` : s;
}

export async function runOfficial(root: string): Promise<OfficialResult> {
  const absRoot = resolve(root);
  const map = loadOfficialMap(absRoot);
  const pin = { tag: map.runner.tag, commit: map.runner.commit };
  const legacy = map.legacy.map((l) => ({ id: l.id, counted: false as const, reason: l.reason }));
  const cacheDir = join(absRoot, map.runner.cacheDir);
  const entry = join(cacheDir, map.runner.entry);
  const cut = join(absRoot, map.cut);
  const legacyIds = new Set(map.legacy.map((l) => l.id));
  const applicable = map.scenarios.filter((s) => !s.disputed && !legacyIds.has(s.id));

  const reasons: string[] = [];
  if (!map.catalog.selected) reasons.push(`catalog-not-selected: ${map.catalog.reason}`);
  if (applicable.length === 0) {
    reasons.push(`no-applicable-scenarios: 0 non-legacy, non-disputed ${map.targetSpecVersion} client scenarios mapped at ${pin.tag}`);
  }
  if (!existsSync(entry)) reasons.push(`runner-not-cached: ${entry} absent (no runtime download)`);
  if (!existsSync(cut)) reasons.push(`cut-missing: ${cut} absent`);

  const evidence: Record<string, unknown> = {
    source: map.runner.source,
    repository: map.runner.repository,
    package: map.runner.package,
    cacheDir,
    runnerCached: existsSync(entry),
    cutPresent: existsSync(cut),
    catalogSelected: map.catalog.selected,
    mappedScenarios: map.scenarios.length,
    applicableScenarios: applicable.length,
    readmeNote: map.runner.readmeNote,
  };

  if (reasons.length > 0) {
    return { ok: false, blocked: true, reasons, evidence, pin, targetSpecVersion: map.targetSpecVersion, scenarios: [], legacy };
  }

  const scenarios: OfficialScenarioResult[] = applicable.map((s) => {
    const args = fill(map.runner.clientArgs, { cut: `${process.execPath} ${cut}`, scenario: s.id });
    const r = spawnSync(process.execPath, [entry, ...args], {
      cwd: cacheDir,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, npm_config_offline: "true" },
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`;
    return { id: s.id, requirements: s.requirements, ok: r.status === 0, exitCode: r.status, evidence: clip(out) };
  });

  const failed = scenarios.filter((s) => !s.ok).map((s) => `scenario-failed: ${s.id}`);
  return {
    ok: failed.length === 0,
    reasons: failed,
    evidence,
    pin,
    targetSpecVersion: map.targetSpecVersion,
    scenarios,
    legacy,
  };
}
