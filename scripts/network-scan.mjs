#!/usr/bin/env node
// network-scan: G11. Scans recorded wire transcripts (same JSON format as scripts/wire-scan.mjs) for any
// network destination that is not loopback.
// Usage: node scripts/network-scan.mjs <file-or-dir>...
//
// Rules:
// - Inspect mcpEndpoint and every frame's url and headers for absolute http(s)/ws(s) URLs.
//   Inspect client frame messages too, but not server messages: server JSON-RPC stimuli are test inputs,
//   whereas client frames provide evidence of destinations contacted.
// - A host is loopback when it is `localhost` (or `*.localhost`), an IPv4 address in 127.0.0.0/8, or `::1`.
//   Any other host is an offender. Hosts in reserved example domains are NOT exempt.
// - Unparseable JSON or a file without a `frames` array is an error (fails closed). Zero files is an error.
// - Offenders are listed as `<file>: frame <i>: <host>`; exit 1 on any offender or error, else exit 0.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;

export function isLoopback(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((x) => Number(x) <= 255) && m[1] === "127";
}

function hostsIn(value, out) {
  if (typeof value === "string") {
    for (const u of value.match(URL_RE) ?? []) {
      try {
        out.push(new URL(u).hostname);
      } catch {
        out.push(u);
      }
    }
  } else if (Array.isArray(value)) for (const v of value) hostsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) hostsIn(v, out);
}

export function scanTranscript(doc, label = "<input>") {
  const offenders = [];
  const errors = [];
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.frames)) {
    errors.push(`${label}: missing 'frames' array`);
    return { offenders, errors };
  }
  const top = [];
  hostsIn(doc.mcpEndpoint, top);
  for (const h of top) if (!isLoopback(h)) offenders.push(`${label}: mcpEndpoint: ${h}`);
  doc.frames.forEach((f, i) => {
    const hs = [];
    hostsIn([f?.url, f?.headers, ...(f?.direction === "server" ? [] : [f?.message])], hs);
    for (const h of hs) if (!isLoopback(h)) offenders.push(`${label}: frame ${i}: ${h}`);
  });
  return { offenders, errors };
}

function collectFiles(p, out) {
  if (statSync(p).isDirectory()) for (const e of readdirSync(p).sort()) collectFiles(join(p, e), out);
  else if (p.endsWith(".json")) out.push(p);
}

export function scanPaths(paths) {
  const files = [];
  const errors = [];
  const offenders = [];
  for (const p of paths) {
    try {
      collectFiles(resolve(p), files);
    } catch (e) {
      errors.push(`${p}: ${e.message}`);
    }
  }
  if (files.length === 0) errors.push("no transcript files (no evidence)");
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      errors.push(`${f}: unparseable JSON`);
      continue;
    }
    const r = scanTranscript(doc, f);
    offenders.push(...r.offenders);
    errors.push(...r.errors);
  }
  return { files: files.length, offenders, errors };
}

function main(argv) {
  if (argv.length === 0) {
    console.error("usage: network-scan <file-or-dir>...");
    return 2;
  }
  const r = scanPaths(argv);
  for (const e of r.errors) console.error(`network-scan: error: ${e}`);
  for (const o of r.offenders) console.error(`network-scan: non-loopback: ${o}`);
  if (r.errors.length || r.offenders.length) return 1;
  console.log(`network-scan: clean (${r.files} transcripts, loopback only)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
