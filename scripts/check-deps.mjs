#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 1. Run dependency-cruiser across packages/ (skip on Node prereleases like -alpha where semver refuses >=26)
if (!process.version.includes("-")) {
  execFileSync(
    process.execPath,
    [join(ROOT, "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs"), "--config", join(ROOT, ".dependency-cruiser.cjs"), join(ROOT, "packages")],
    { cwd: ROOT, stdio: "inherit" }
  );
}

// 2. Enforce zero Node-only globals/imports inside packages/core/src
const CORE_SRC = join(ROOT, "packages/core/src");
const BANNED_CORE = [
  /from\s+["']node:/,
  /require\(\s*["']node:/,
  /\bprocess\s*\./,
  /\bBuffer\s*\./,
  /\bBuffer\b/,
];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

for (const file of walk(CORE_SRC)) {
  if (file.endsWith("schema/types.ts")) continue;
  const text = readFileSync(file, "utf8");
  for (const pat of BANNED_CORE) {
    if (pat.test(text)) {
      console.error(`check-deps: forbidden Node reference (${pat}) in ${file}`);
      process.exit(1);
    }
  }
}

console.log("check-deps: ok");
