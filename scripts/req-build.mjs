#!/usr/bin/env node
/**
 * Builds packages/conformance/requirements.json from docs/conformance/requirements.md.
 * Markdown stays canonical; JSON is derived and checked in.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "docs/conformance/requirements.md");
const OUT = join(ROOT, "packages/conformance/requirements.json");

const HEADER = "| ID | Anchor (page#heading) | Role | Strength | Condition | Default | Disposition | Acceptance check | Open question |";

export function parseRequirementsMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const rows = [];
  const seen = new Set();
  let inFence = false;
  let inReqTable = false;
  let expectSeparator = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (/^```|^~~~/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line === HEADER) {
      inReqTable = true;
      expectSeparator = true;
      continue;
    }
    if (expectSeparator) {
      expectSeparator = false;
      if (!/^\|(\s*-{3,}\s*\|){9}$/.test(line)) {
        throw new Error(`bad separator at line ${i + 1}`);
      }
      continue;
    }
    if (inReqTable) {
      if (!line.startsWith("|")) {
        inReqTable = false;
        continue;
      }
      const cells = line
        .slice(1, line.endsWith("|") ? -1 : undefined)
        .split("|")
        .map((c) => c.trim());
      if (cells.length !== 9) {
        throw new Error(`expected 9 cells at line ${i + 1}, got ${cells.length}`);
      }
      const [id, anchor, role, strength, condition, defaultVal, disposition, acceptanceCheck, openQuestion] = cells;
      if (!id) throw new Error(`blank ID at line ${i + 1}`);
      if (seen.has(id)) throw new Error(`duplicate ID ${id}`);
      seen.add(id);
      rows.push({
        id,
        anchor,
        role,
        strength,
        condition,
        default: defaultVal,
        disposition,
        acceptanceCheck,
        openQuestion: openQuestion || null,
      });
    }
  }
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const md = readFileSync(SRC, "utf8");
  const rows = parseRequirementsMarkdown(md);
  if (rows.length === 0) {
    console.error("req-build: parsed 0 rows");
    process.exit(1);
  }
  writeFileSync(OUT, `${JSON.stringify({ version: 1, count: rows.length, rows }, null, 2)}\n`);
  console.log(`req-build: wrote ${rows.length} requirements -> packages/conformance/requirements.json`);
}
