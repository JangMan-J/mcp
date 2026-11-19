#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCoverage } from "./coverage.js";
import { runConformance } from "./run.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const EXCHANGES_DIR = join(ROOT, "packages/fixtures/exchanges");
const REQ_JSON = join(ROOT, "packages/conformance/requirements.json");

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

  console.error("usage: conformance <run [--tier A|B] [--area A] [--id GLOB] [--mutate] [--json] | check-coverage>");
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
