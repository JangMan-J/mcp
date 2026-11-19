#!/usr/bin/env node
// wire-scan: GATE-4 / G11. Scans recorded wire transcripts for forbidden client constructs (PLAN N7/N8).
// Input: JSON files {fixture: string, frames: [{direction: "client"|"server", message?, method?, headers?, url?}]}.
// Usage: node scripts/wire-scan.mjs <file-or-dir>...
// Only client frames are judged; server frames are deliberate stimuli and never flagged.
// Header values are never printed, only header names.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_METHODS = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "logging/setLevel",
  "notifications/message",
  "roots/list",
  "notifications/roots/list_changed",
  "sampling/createMessage",
  "resources/subscribe",
  "resources/unsubscribe",
  "notifications/elicitation/complete",
]);
export const FORBIDDEN_HEADERS = new Set(["mcp-session-id", "last-event-id"]);
export const ALLOWED_HTTP_METHODS = new Set(["POST"]);
const LOG_LEVEL_META = "io.modelcontextprotocol/logLevel";

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function hasKeyDeep(value, key, depth = 0) {
  if (depth > 64) return false;
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key, depth + 1));
  if (!isObj(value)) return false;
  for (const [k, v] of Object.entries(value)) {
    if (k === key || hasKeyDeep(v, key, depth + 1)) return true;
  }
  return false;
}

function scanClientFrame(frame) {
  const out = [];
  if (frame.message !== undefined) {
    const msg = frame.message;
    if (Array.isArray(msg)) {
      out.push("JSON-RPC batch sent");
    } else if (isObj(msg)) {
      if (typeof msg.method === "string" && FORBIDDEN_METHODS.has(msg.method)) {
        out.push(`forbidden method '${msg.method}'`);
      }
      if (hasKeyDeep(msg, LOG_LEVEL_META)) out.push(`forbidden meta key '${LOG_LEVEL_META}'`);
      if (isObj(msg.params) && "includeContext" in msg.params) out.push("forbidden param 'includeContext'");
    } else {
      out.push("message is not a JSON object");
    }
  }
  if (frame.method !== undefined) {
    const m = String(frame.method).toUpperCase();
    if (!ALLOWED_HTTP_METHODS.has(m)) out.push(`forbidden HTTP method '${m}'`);
  }
  if (frame.headers !== undefined) {
    for (const name of Object.keys(frame.headers)) {
      if (FORBIDDEN_HEADERS.has(name.toLowerCase())) out.push(`forbidden header '${name}'`);
    }
  }
  return out;
}

function validateFrame(frame) {
  if (!isObj(frame)) return "frame is not an object";
  if (frame.direction !== "client" && frame.direction !== "server") return "frame.direction must be 'client' or 'server'";
  if (frame.message === undefined && frame.method === undefined && frame.headers === undefined && frame.url === undefined) {
    return "frame carries no evidence (message/method/headers/url)";
  }
  if (frame.method !== undefined && typeof frame.method !== "string") return "frame.method must be a string";
  if (frame.headers !== undefined && !isObj(frame.headers)) return "frame.headers must be an object";
  if (frame.url !== undefined && typeof frame.url !== "string") return "frame.url must be a string";
  return null;
}

/** Scan one parsed transcript. Returns { errors, violations, clientFrames }. */
export function scanTranscript(doc, label = "<input>") {
  const errors = [];
  const violations = [];
  let clientFrames = 0;
  if (!isObj(doc)) return { errors: [`${label}: transcript is not a JSON object`], violations, clientFrames };
  if (typeof doc.fixture !== "string" || doc.fixture.length === 0) errors.push(`${label}: missing 'fixture' string`);
  if (!Array.isArray(doc.frames)) {
    errors.push(`${label}: missing 'frames' array`);
    return { errors, violations, clientFrames };
  }
  if (doc.frames.length === 0) errors.push(`${label}: empty 'frames' (no evidence)`);
  const name = typeof doc.fixture === "string" ? doc.fixture : "?";
  doc.frames.forEach((frame, i) => {
    const bad = validateFrame(frame);
    if (bad) {
      errors.push(`${label}: frame ${i}: ${bad}`);
      return;
    }
    if (frame.direction !== "client") return;
    clientFrames++;
    for (const v of scanClientFrame(frame)) violations.push(`${label} [${name}] frame ${i}: ${v}`);
  });
  return { errors, violations, clientFrames };
}

function collectFiles(p, out) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const e of readdirSync(p).sort()) collectFiles(join(p, e), out);
  } else if (p.endsWith(".json")) {
    out.push(p);
  }
}

/** Scan paths (files or directories). Returns { errors, violations, files, clientFrames }. */
export function scanPaths(paths) {
  const errors = [];
  const violations = [];
  const files = [];
  let clientFrames = 0;
  if (paths.length === 0) errors.push("no input paths given");
  for (const p of paths) {
    try {
      collectFiles(resolve(p), files);
    } catch {
      errors.push(`${p}: not found`);
    }
  }
  if (paths.length > 0 && files.length === 0 && errors.length === 0) errors.push("no transcript files found (no evidence)");
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      errors.push(`${f}: invalid JSON`);
      continue;
    }
    const r = scanTranscript(doc, f);
    errors.push(...r.errors);
    violations.push(...r.violations);
    clientFrames += r.clientFrames;
  }
  if (files.length > 0 && errors.length === 0 && clientFrames === 0) errors.push("no client frames in any transcript (no evidence)");
  return { errors, violations, files: files.length, clientFrames };
}

function main(argv) {
  const r = scanPaths(argv);
  for (const e of r.errors) console.error(`wire-scan: error: ${e}`);
  for (const v of r.violations) console.error(`wire-scan: violation: ${v}`);
  if (r.errors.length || r.violations.length) {
    console.error(`wire-scan: FAIL (${r.errors.length} errors, ${r.violations.length} violations)`);
    return 1;
  }
  console.log(`wire-scan: clean (${r.files} transcripts, ${r.clientFrames} client frames)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
