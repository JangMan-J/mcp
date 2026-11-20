#!/usr/bin/env node
// Dev tool: verify a Vitest JSON report has a passed test for each wave-3 evidence tag.
import { readFileSync } from "node:fs";

const required = [
  ...Array.from({ length: 14 }, (_, i) => `PICA-${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `PICD-${i + 1}`),
  "CUT-PI-MCP-1",
  "CUT-ROLLBACK-1",
];

const path = process.argv[2];
if (!path) {
  console.error("usage: check-wave3-evidence.mjs <vitest-report.json>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(path, "utf8"));
const tests = [];
for (const file of report.testResults ?? []) {
  for (const t of file.assertionResults ?? []) {
    tests.push({
      title: t.fullName ?? [...(t.ancestorTitles ?? []), t.title].join(" "),
      status: t.status,
      file: file.name,
    });
  }
}

const missing = [];
const notPassed = [];
const counts = {};
for (const tag of required) {
  const hits = tests.filter((t) => t.title.includes(`[${tag}]`));
  const passed = hits.filter((t) => t.status === "passed");
  counts[tag] = passed.length;
  if (hits.length === 0) missing.push(tag);
  else {
    for (const t of hits) if (t.status !== "passed") notPassed.push(`${tag}: ${t.status}: ${t.title}`);
    if (passed.length === 0 && !notPassed.some((l) => l.startsWith(tag + ":"))) notPassed.push(`${tag}: no passing test`);
  }
}
const ok = (tag) => counts[tag] > 0 && !notPassed.some((l) => l.startsWith(tag + ":"));
const good = required.filter(ok).length;
for (const t of missing) console.error(`MISSING [${t}]`);
for (const l of notPassed) console.error(`NOT PASSED ${l}`);
console.log(`wave3 evidence: ${good}/${required.length} tags passed; ${missing.length} missing; ${notPassed.length} non-passing; ${Object.values(counts).reduce((a, b) => a + b, 0)} passing tests`);
process.exit(good === required.length ? 0 : 1);
