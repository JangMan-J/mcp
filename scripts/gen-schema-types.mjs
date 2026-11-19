#!/usr/bin/env node
/**
 * Generates packages/core/src/schema/types.ts from the pinned 2026-07-28 schema.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_PATH = join(ROOT, "packages/core/src/schema/schema.json");
const OUT_PATH = join(ROOT, "packages/core/src/schema/types.ts");

const raw = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
// json-schema-to-typescript traverses $defs when referenced from properties or top-level schema.
const defs = raw.$defs ?? {};
const syntheticRoot = {
  $schema: raw.$schema,
  title: "McpSchema20260728",
  type: "object",
  additionalProperties: false,
  $defs: defs,
  definitions: defs,
  properties: Object.fromEntries(
    Object.keys(defs).map((name) => [name, { $ref: `#/$defs/${name}` }])
  ),
};

const generated = await compile(syntheticRoot, "McpSchema20260728", {
  bannerComment:
    "/* eslint-disable */\n/**\n * AUTO-GENERATED from packages/core/src/schema/schema.json (MCP 2026-07-28, tag 5f5440bb).\n * Do not edit manually; regenerate with `npm run gen:schema`.\n */",
  unreachableDefinitions: true,
  strictIndexSignatures: true,
});

writeFileSync(OUT_PATH, generated);
console.log(`gen-schema-types: generated ${Object.keys(defs).length} schema definitions -> packages/core/src/schema/types.ts`);
