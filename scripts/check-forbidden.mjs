#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deny = JSON.parse(readFileSync(join(ROOT, "packages/conformance/deny-pi.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));

const checkName = (name, where) => {
  for (const exact of deny.packages) {
    if (name === exact) {
      console.error(`check-forbidden: denied package '${name}' found in ${where}`);
      process.exit(1);
    }
  }
  for (const pref of deny.prefixes) {
    if (name.startsWith(pref)) {
      console.error(`check-forbidden: denied prefix '${name}' found in ${where}`);
      process.exit(1);
    }
  }
  for (const sub of deny.substrings) {
    if (name.includes(sub)) {
      console.error(`check-forbidden: denied substring '${name}' found in ${where}`);
      process.exit(1);
    }
  }
};

for (const pkgPath of Object.keys(lock.packages ?? {})) {
  if (!pkgPath) continue;
  const nmIdx = pkgPath.lastIndexOf("node_modules/");
  const pkgName = nmIdx >= 0 ? pkgPath.slice(nmIdx + "node_modules/".length) : pkgPath;
  checkName(pkgName, "package-lock.json");
}

function walkTs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walkTs(p));
    else if (p.endsWith(".ts") || p.endsWith(".js") || p.endsWith(".mjs")) out.push(p);
  }
  return out;
}

for (const file of walkTs(join(ROOT, "packages"))) {
  const txt = readFileSync(file, "utf8");
  for (const pat of [...deny.packages, ...deny.substrings]) {
    if (txt.includes(pat) && !file.endsWith("deny-pi.json")) {
      console.error(`check-forbidden: denied reference '${pat}' in ${file}`);
      process.exit(1);
    }
  }
}

// Also verify fixtures package.json is private with no bin/shipped server
const fixPkg = JSON.parse(readFileSync(join(ROOT, "packages/fixtures/package.json"), "utf8"));
if (fixPkg.private !== true || fixPkg.bin) {
  console.error("check-forbidden: packages/fixtures/package.json must be private with no bin");
  process.exit(1);
}

console.log("check-forbidden: ok");
