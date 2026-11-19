#!/usr/bin/env node
// secret-scan: G11. Scans recorded wire transcripts (same JSON format as scripts/wire-scan.mjs) plus any
// given log files for secret material.
// Usage: node scripts/secret-scan.mjs <transcripts-file-or-dir>... [--log <file>]...
//
// Rules (a hit on any rule exits 1; values are never printed, only rule and location):
// 1. private-key: the text `-----BEGIN` followed by `PRIVATE KEY` on the same line, anywhere (transcripts or logs).
// 2. client-secret: in log files, any `client_secret` key/param with a non-redacted value
//    (`client_secret=<v>`, `"client_secret": "<v>"`).
// 3. bearer: in log files, `Bearer <token>` with a non-redacted token. In transcripts, a Bearer value is allowed
//    only in a frame's `headers.authorization` (case-insensitive) field, which is where fixtures expect it.
// 4. secret-field: any JSON key whose name contains `secret`, `password`, `private_key`, `access_token` or
//    `refresh_token` (case-insensitive) with a non-redacted string value, inside a transcript frame's
//    `message` when that message is a log/diagnostic frame (method starts with `notifications/` or a frame
//    with `endpoint` "other"), or anywhere in a JSON log line. Wire request/response payloads are not judged
//    (wire-scan covers wire leakage).
// A value counts as redacted when empty or matching /^(\*+|\[?redacted\]?|<redacted>|x+|…)$/i.
// Transcript files that are unparseable JSON are errors (fail closed); zero transcript files is an error.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REDACTED = /^(\*+|\[?redacted\]?|<redacted>|x+|…)$/i;
const SECRET_KEY = /secret|password|private_key|access_token|refresh_token/i;
const PRIVATE_KEY = /-----BEGIN[^\n]*PRIVATE KEY/;
const isRedacted = (v) => v.trim() === "" || REDACTED.test(v.trim());

function secretFields(value, path, hits, where) {
  if (Array.isArray(value)) value.forEach((v, i) => secretFields(v, `${path}[${i}]`, hits, where));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) && typeof v === "string" && !isRedacted(v)) hits.push(`${where}: secret-field ${path}.${k}`);
      secretFields(v, `${path}.${k}`, hits, where);
    }
}

function bearerOutsideAuth(value, path, hits, where) {
  if (typeof value === "string") {
    const m = /\bBearer\s+(\S+)/i.exec(value);
    if (m && !isRedacted(m[1])) hits.push(`${where}: bearer at ${path}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => bearerOutsideAuth(v, `${path}[${i}]`, hits, where));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (path === "headers" && k.toLowerCase() === "authorization") continue;
      bearerOutsideAuth(v, `${path}.${k}`, hits, where);
    }
}

export function scanTranscript(doc, label = "<input>", text = JSON.stringify(doc)) {
  const hits = [];
  const errors = [];
  if (PRIVATE_KEY.test(text)) hits.push(`${label}: private-key`);
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.frames)) {
    errors.push(`${label}: missing 'frames' array`);
    return { hits, errors };
  }
  doc.frames.forEach((f, i) => {
    const where = `${label}: frame ${i}`;
    if (!f || typeof f !== "object") return;
    for (const [k, v] of Object.entries(f)) bearerOutsideAuth(v, k, hits, where);
    const method = f.message && typeof f.message.method === "string" ? f.message.method : "";
    if (method.startsWith("notifications/") || f.endpoint === "other") secretFields(f.message, "message", hits, where);
  });
  return { hits, errors };
}

export function scanLog(text, label = "<log>") {
  const hits = [];
  text.split("\n").forEach((line, i) => {
    const where = `${label}:${i + 1}`;
    if (PRIVATE_KEY.test(line)) hits.push(`${where}: private-key`);
    for (const m of line.matchAll(/client_secret["']?\s*[:=]\s*"?([^"&\s,}]*)/gi))
      if (!isRedacted(m[1])) hits.push(`${where}: client-secret`);
    for (const m of line.matchAll(/\bBearer\s+([^\s"',}]+)/gi)) if (!isRedacted(m[1])) hits.push(`${where}: bearer`);
    const t = line.trim();
    if (t.startsWith("{")) {
      try {
        secretFields(JSON.parse(t), "$", hits, where);
      } catch {
        /* not JSON */
      }
    }
  });
  return hits;
}

function collectFiles(p, out) {
  if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) collectFiles(join(p, e), out);
  else if (p.endsWith(".json")) out.push(p);
}

export function scan(paths, logs = []) {
  const files = [];
  const errors = [];
  const hits = [];
  for (const p of paths) {
    try {
      collectFiles(resolve(p), files);
    } catch (e) {
      errors.push(`${p}: ${e.message}`);
    }
  }
  if (files.length === 0) errors.push("no transcript files (no evidence)");
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      errors.push(`${f}: unparseable JSON`);
      continue;
    }
    const r = scanTranscript(doc, f, text);
    hits.push(...r.hits);
    errors.push(...r.errors);
  }
  for (const l of logs) {
    if (!existsSync(l)) errors.push(`${l}: log missing`);
    else hits.push(...scanLog(readFileSync(l, "utf8"), l));
  }
  return { files: files.length, logs: logs.length, hits, errors };
}

function main(argv) {
  const paths = [];
  const logs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--log") logs.push(argv[++i] ?? "");
    else paths.push(argv[i]);
  }
  if (paths.length === 0) {
    console.error("usage: secret-scan <file-or-dir>... [--log <file>]...");
    return 2;
  }
  const r = scan(paths, logs);
  for (const e of r.errors) console.error(`secret-scan: error: ${e}`);
  for (const h of r.hits) console.error(`secret-scan: hit: ${h}`);
  if (r.errors.length || r.hits.length) return 1;
  console.log(`secret-scan: clean (${r.files} transcripts, ${r.logs} logs)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
