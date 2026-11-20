#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoverage } from "./coverage.js";
import { runConformance } from "./run.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EXCHANGES_DIR = join(ROOT, "packages/fixtures/exchanges");
const REQ_JSON = join(ROOT, "packages/conformance/requirements.json");

export interface OfficialScenarioSummary {
  readonly id?: string;
  readonly name?: string;
  readonly ok?: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
}

export interface OfficialRunInput {
  readonly ok?: boolean;
  readonly blocked?: string;
  readonly reason?: string;
  readonly reasons?: readonly unknown[];
  readonly scenarios?: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface OfficialJsonReport {
  readonly ok: boolean;
  readonly total: number;
  readonly reason?: string;
  readonly scenarios: readonly unknown[];
  readonly [key: string]: unknown;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Aligns `runOfficial` output with gate.ts's `{ ok, total, reason }` contract while
 * preserving all per-scenario evidence and metadata. Fails closed when blocked,
 * when any observed scenario did not pass, or when zero scenarios were observed.
 */
export function formatOfficialReport(rep: OfficialRunInput | null | undefined): OfficialJsonReport {
  if (!rep || typeof rep !== "object" || Array.isArray(rep)) {
    return {
      ok: false,
      total: 0,
      reason: "missing official report",
      scenarios: [],
    };
  }

  const scenarios = Array.isArray(rep.scenarios) ? rep.scenarios : [];
  const total = scenarios.length;
  const blocked = nonEmptyString(rep.blocked);
  const failingScenarios = scenarios.filter(
    (s) => !(typeof s === "object" && s !== null && (s as { ok?: unknown }).ok === true),
  );
  const ok = rep.ok === true && !blocked && total > 0 && failingScenarios.length === 0;

  let reason: string | undefined;
  if (!ok) {
    const repReasons = Array.isArray(rep.reasons)
      ? rep.reasons.map(nonEmptyString).filter((r): r is string => r !== undefined)
      : [];
    const repReason = nonEmptyString(rep.reason);
    if (blocked) {
      reason = blocked;
    } else if (repReasons.length > 0) {
      reason = repReasons.join("; ");
    } else if (repReason) {
      reason = repReason;
    } else if (failingScenarios.length > 0) {
      reason = failingScenarios
        .map((s) => {
          const rec = typeof s === "object" && s !== null ? (s as OfficialScenarioSummary) : undefined;
          const label = rec?.id ?? rec?.name ?? "?";
          const err = nonEmptyString(rec?.error) ?? "failed";
          return `${label}: ${err}`;
        })
        .join("; ");
    } else if (total === 0) {
      reason = "no official scenarios observed";
    } else {
      reason = "official conformance failed";
    }
  }

  const { ok: _ok, total: _total, reason: _reason, scenarios: _scenarios, ...rest } = rep;
  return {
    ...rest,
    ok,
    total,
    ...(reason !== undefined ? { reason } : {}),
    scenarios,
  };
}

function flagVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "check-coverage") {
    const rep = checkCoverage(REQ_JSON, EXCHANGES_DIR);
    console.log(JSON.stringify(rep, null, 2));
    return rep.ok ? 0 : 1;
  }

  if (cmd === "run") {
    const tierRaw = flagVal(args, "--tier");
    const tier = tierRaw === "A" || tierRaw === "B" ? tierRaw : undefined;
    const area = flagVal(args, "--area");
    const idGlob = flagVal(args, "--id");
    const mutate = args.includes("--mutate");
    const jsonOut = args.includes("--json");
    const seed = flagVal(args, "--seed") ? Number(flagVal(args, "--seed")) : 1;

    const summary = await runConformance({
      exchangesDir: EXCHANGES_DIR,
      ...(tier ? { tier } : {}),
      ...(area ? { area } : {}),
      ...(idGlob ? { idGlob } : {}),
      mutate,
      seed,
    });

    if (jsonOut) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      for (const r of summary.results) {
        const tag = r.ok ? "PASS" : "FAIL";
        const mut = r.mutant ? ` [mutant:${r.mutant}]` : "";
        const err = r.error ? ` — ${r.error}` : "";
        console.log(`${tag} ${r.id}${mut}${err}`);
      }
      console.log(
        `conformance (${mutate ? "mutate" : "tier"}): ${summary.passed}/${summary.total} passed`,
      );
    }
    return summary.ok ? 0 : 1;
  }

  if (cmd === "official") {
    const jsonOut = args.includes("--json");
    // Lazy, non-literal import so this package builds independently of official.ts.
    const spec = "./official.js";
    const mod = (await import(spec)) as {
      runOfficial(root: string): Promise<OfficialRunInput>;
    };
    const rep = formatOfficialReport(await mod.runOfficial(ROOT));
    if (jsonOut) {
      console.log(JSON.stringify(rep, null, 2));
    } else {
      if (typeof rep.blocked === "string" && rep.blocked) console.log(`BLOCKED — ${rep.blocked}`);
      for (const s of rep.scenarios as OfficialScenarioSummary[]) {
        const tag = s?.ok ? "PASS" : "FAIL";
        console.log(`${tag} ${s?.name ?? s?.id ?? "?"}${s?.error ? ` — ${s.error}` : ""}`);
      }
      const status = rep.ok ? "ok" : rep.blocked ? "blocked" : "failed";
      console.log(`official conformance: ${status}${!rep.ok && rep.reason && !rep.blocked ? ` — ${rep.reason}` : ""}`);
    }
    return rep.ok ? 0 : 1;
  }

  console.error("usage: conformance <run [--tier A|B] [--area A] [--id GLOB] [--mutate] [--json] | official [--json] | check-coverage>");
  return 2;
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
