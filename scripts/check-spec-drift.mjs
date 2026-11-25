#!/usr/bin/env node
/**
 * Spec drift watcher: compares the vendored 2026-07-28 schema and the recorded
 * spec-prose hashes against upstream. Exits 1 and prints a report when drifted.
 *
 *   node scripts/check-spec-drift.mjs           # check (CI)
 *   node scripts/check-spec-drift.mjs --update  # re-record after an intentional sync
 *
 * Upstream sources:
 *   schema: modelcontextprotocol/specification  schema/2026-07-28/schema.json
 *   prose:  modelcontextprotocol/modelcontextprotocol  docs/specification/2026-07-28/**.mdx
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = join(ROOT, "spec-drift.json");
const UPDATE = process.argv.includes("--update");

const SCHEMA_REPO = "modelcontextprotocol/specification";
const SCHEMA_PATH = "schema/2026-07-28/schema.json";
const PROSE_REPO = "modelcontextprotocol/modelcontextprotocol";
const PROSE_BASE = "docs/specification/2026-07-28";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${path}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "mcp-client-spec-drift" },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return res.json();
}

async function raw(repo, ref, path) {
  const res = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/${path}`);
  if (!res.ok) throw new Error(`raw ${res.status} for ${repo}/${ref}/${path}`);
  return res.text();
}

const report = [];
const drift = [];

// 1. Schema: latest upstream commit touching the path, content compare, banner tag compare.
const commits = await gh(`${SCHEMA_REPO}/commits?path=${SCHEMA_PATH}&per_page=1`);
const upstreamSha = commits[0]?.sha;
if (!upstreamSha) throw new Error("no upstream commit found for schema");
const upstreamSchema = await raw(SCHEMA_REPO, upstreamSha, SCHEMA_PATH);
const vendored = readFileSync(join(ROOT, "packages/core/src/schema/schema.json"), "utf8");
const schemaDrift = sha256(upstreamSchema) !== sha256(vendored);
const banner = /tag ([0-9a-f]{8})/.exec(readFileSync(join(ROOT, "scripts/gen-schema-types.mjs"), "utf8"))?.[1];
const bannerDrift = !upstreamSha.startsWith(banner ?? "");
if (schemaDrift) drift.push(`schema.json content differs from upstream ${upstreamSha.slice(0, 8)}`);
if (bannerDrift) drift.push(`gen-schema-types.mjs banner tag '${banner}' != upstream '${upstreamSha.slice(0, 8)}'`);
report.push(`schema: upstream ${upstreamSha.slice(0, 8)} (${commits[0].commit.committer.date}), banner ${banner}, content ${schemaDrift ? "DRIFT" : "match"}`);

// 2. Prose: hash every .mdx under the spec directory.
const tree = await gh(`${PROSE_REPO}/git/trees/main?recursive=1`);
const prosePaths = tree.tree
  .filter((t) => t.type === "blob" && t.path.startsWith(`${PROSE_BASE}/`) && t.path.endsWith(".mdx"))
  .map((t) => t.path)
  .sort();
const prose = {};
for (const p of prosePaths) {
  prose[p] = sha256(await raw(PROSE_REPO, "main", p));
}

const previous = JSON.parse(readFileSync(RECORD, "utf8"));
const prevProse = previous.proseSha256 ?? {};
const changed = prosePaths.filter((p) => prevProse[p] && prevProse[p] !== prose[p]);
const added = prosePaths.filter((p) => !prevProse[p]);
const removed = Object.keys(prevProse).filter((p) => !prose[p]);
if (changed.length) drift.push(`spec prose changed: ${changed.join(", ")}`);
if (added.length) drift.push(`spec prose added: ${added.join(", ")}`);
if (removed.length) drift.push(`spec prose removed: ${removed.join(", ")}`);
report.push(`prose: ${prosePaths.length} files, ${changed.length} changed, ${added.length} added, ${removed.length} removed`);

const record = {
  schemaRepo: SCHEMA_REPO,
  schemaPath: SCHEMA_PATH,
  schemaUpstreamSha: upstreamSha,
  schemaSha256: sha256(vendored),
  proseRepo: PROSE_REPO,
  proseBase: PROSE_BASE,
  proseSha256: prose,
};

if (UPDATE) {
  // Record the vendored schema as current only when it matches upstream.
  if (schemaDrift || bannerDrift) {
    console.error("check-spec-drift: --update refused: vendored schema does not match upstream; sync schema first");
    process.exit(1);
  }
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
  console.log("check-spec-drift: recorded current upstream state");
} else {
  for (const line of report) console.log(line);
  if (drift.length > 0) {
    console.error("\nspec drift detected:");
    for (const d of drift) console.error(`  - ${d}`);
    process.exit(1);
  }
  console.log("check-spec-drift: no drift");
}
