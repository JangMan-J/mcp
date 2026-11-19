#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const depsDoc = readFileSync(join(ROOT, "docs/deps.md"), "utf8");

const allDeps = {
  ...(rootPkg.dependencies ?? {}),
  ...(rootPkg.devDependencies ?? {}),
};

for (const [name, ver] of Object.entries(allDeps)) {
  if (/^[~^><=*]|latest/i.test(ver)) {
    console.error(`check-deps-doc: dependency ${name}@${ver} must be exact-pinned`);
    process.exit(1);
  }
  if (!depsDoc.includes(`\`${name}\``) || !depsDoc.includes(`\`${ver}\``) ) {
    console.error(`check-deps-doc: missing docs/deps.md row for ${name}@${ver}`);
    process.exit(1);
  }
}

console.log(`check-deps-doc: ok (${Object.keys(allDeps).length} pinned dependencies documented)`);
