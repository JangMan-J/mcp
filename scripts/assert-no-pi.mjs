#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deny = JSON.parse(readFileSync(join(ROOT, "packages/conformance/deny-pi.json"), "utf8"));

for (const key of Object.keys(process.env)) {
  if (key.startsWith("PI_") && process.env[key]) {
    console.error(`assert-no-pi: PI_* environment variable set in gate process: ${key}`);
    process.exit(1);
  }
}
if (process.env.NODE_PATH) {
  console.error("assert-no-pi: NODE_PATH must be unset in gate process");
  process.exit(1);
}
if (deny.packages.length === 0) {
  console.error("assert-no-pi: deny-pi.json is empty");
  process.exit(1);
}
console.log("assert-no-pi: ok");
