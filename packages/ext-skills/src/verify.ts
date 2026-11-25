import { createHash } from "node:crypto";

export const MAX_SKILL_FILES = 512;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;
export const SKILL_CACHE_EXCLUDE_MARKER = ".mcp-skill-cache-exclude";

export interface SkillFileEntry {
  readonly uri: string;
  readonly size: number;
  readonly sha256: string;
  readonly mimeType?: string;
}

export interface SkillEntry {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly files: readonly SkillFileEntry[];
  readonly frontmatter?: Record<string, unknown>;
  readonly resources?: "static" | "dynamic";
  readonly allowedTools?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface SkillOrigin {
  readonly kind: "mcp";
  readonly serverKey: string;
  readonly skillUri: string;
}

export interface SkillCacheEntry {
  readonly origin: SkillOrigin;
  readonly uri: string;
  readonly size: number;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function manifestFingerprint(files: readonly SkillFileEntry[]): string {
  const sorted = [...files]
    .map((f) => ({ uri: f.uri, size: f.size, sha256: f.sha256 }))
    .sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
  return sha256Hex(Buffer.from(JSON.stringify(sorted), "utf8"));
}

export type EntryValidation =
  | { readonly ok: true; readonly entry: SkillEntry }
  | { readonly ok: false; readonly kind: "protocol-violation" | "limit-exceeded" | "dynamic-declined"; readonly reason: string };

const SHA256_RE = /^[0-9a-f]{64}$/;

export function validateSkillEntry(raw: unknown, opts?: { readonly allowDynamic?: boolean }): EntryValidation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, kind: "protocol-violation", reason: "skill entry must be an object" };
  }
  const r = raw as Record<string, unknown>;
  if (typeof r["uri"] !== "string" || !r["uri"]) {
    return { ok: false, kind: "protocol-violation", reason: "skill entry missing uri" };
  }
  const fm = r["frontmatter"] && typeof r["frontmatter"] === "object" && !Array.isArray(r["frontmatter"])
    ? (r["frontmatter"] as Record<string, unknown>)
    : undefined;
  const name = typeof r["name"] === "string" && r["name"]
    ? r["name"]
    : typeof fm?.["name"] === "string" && fm["name"]
      ? fm["name"]
      : undefined;
  if (!name) {
    return { ok: false, kind: "protocol-violation", reason: "skill entry missing name" };
  }
  const description = typeof r["description"] === "string"
    ? r["description"]
    : typeof fm?.["description"] === "string"
      ? fm["description"]
      : undefined;
  if (description === undefined) {
    return { ok: false, kind: "protocol-violation", reason: "skill entry missing description" };
  }

  const rawResources = r["resources"];
  let resourcesMode: "static" | "dynamic" | undefined;
  if (rawResources === "dynamic" || rawResources === "static") {
    resourcesMode = rawResources;
  } else if (rawResources !== undefined && !Array.isArray(rawResources)) {
    return { ok: false, kind: "protocol-violation", reason: "invalid resources mode" };
  }
  if (resourcesMode === "dynamic" && !opts?.allowDynamic) {
    return { ok: false, kind: "dynamic-declined", reason: "dynamic resources declined by default" };
  }

  const manifestItems = Array.isArray(r["files"])
    ? r["files"]
    : Array.isArray(rawResources)
      ? rawResources
      : resourcesMode === "dynamic"
        ? []
        : undefined;
  if (!manifestItems) {
    return { ok: false, kind: "protocol-violation", reason: "skill entry missing complete files manifest" };
  }
  if (manifestItems.length > MAX_SKILL_FILES) {
    return { ok: false, kind: "limit-exceeded", reason: `file count ${manifestItems.length} exceeds ${MAX_SKILL_FILES}` };
  }
  let totalBytes = 0;
  const files: SkillFileEntry[] = [];
  for (const item of manifestItems) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, kind: "protocol-violation", reason: "manifest file entry must be an object" };
    }
    const f = item as Record<string, unknown>;
    if (typeof f["uri"] !== "string" || !f["uri"]) {
      return { ok: false, kind: "protocol-violation", reason: "manifest file missing uri" };
    }
    if (typeof f["size"] !== "number" || !Number.isInteger(f["size"]) || f["size"] < 0) {
      return { ok: false, kind: "protocol-violation", reason: `invalid size for ${f["uri"]}` };
    }
    const rawDigest = typeof f["sha256"] === "string"
      ? f["sha256"]
      : typeof f["digest"] === "string" && f["digest"].startsWith("sha256:")
        ? f["digest"].slice(7)
        : undefined;
    if (!rawDigest || !SHA256_RE.test(rawDigest)) {
      return { ok: false, kind: "protocol-violation", reason: `invalid sha256 for ${f["uri"]}` };
    }
    totalBytes += f["size"];
    if (totalBytes > MAX_SKILL_BYTES) {
      return { ok: false, kind: "limit-exceeded", reason: `total bytes ${totalBytes} exceeds ${MAX_SKILL_BYTES}` };
    }
    files.push({
      uri: f["uri"],
      size: f["size"],
      sha256: rawDigest,
      ...(typeof f["mimeType"] === "string" ? { mimeType: f["mimeType"] } : {}),
    });
  }
  const rawTools = r["allowed-tools"] ?? r["allowedTools"] ?? fm?.["allowed-tools"] ?? fm?.["allowedTools"];
  const allowedTools = Array.isArray(rawTools) && rawTools.every((t) => typeof t === "string") ? rawTools : undefined;
  const metaObj = r["metadata"] && typeof r["metadata"] === "object" && !Array.isArray(r["metadata"])
    ? (r["metadata"] as Record<string, unknown>)
    : fm?.["metadata"] && typeof fm["metadata"] === "object" && !Array.isArray(fm["metadata"])
      ? (fm["metadata"] as Record<string, unknown>)
      : undefined;
  return {
    ok: true,
    entry: {
      uri: r["uri"],
      name,
      description,
      files,
      ...(fm !== undefined ? { frontmatter: fm } : {}),
      ...(resourcesMode !== undefined ? { resources: resourcesMode } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}),
      ...(metaObj !== undefined ? { metadata: metaObj } : {}),
    },
  };
}

export function verifyFileBytes(bytes: Uint8Array, expected: SkillFileEntry): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (bytes.byteLength !== expected.size) {
    return { ok: false, reason: `size mismatch for ${expected.uri}: expected ${expected.size}, got ${bytes.byteLength}` };
  }
  const actual = sha256Hex(bytes);
  if (actual !== expected.sha256) {
    return { ok: false, reason: `sha256 mismatch for ${expected.uri}: expected ${expected.sha256}, got ${actual}` };
  }
  return { ok: true };
}

export function parseYamlFrontmatter(text: string): Record<string, unknown> | undefined {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return undefined;
  const lines = (m[1] ?? "").split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let currentKey: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.trimStart().startsWith("#")) continue;
    const listMatch = line.match(/^\s+-\s+(.*)$/);
    if (listMatch && currentKey) {
      const arr = Array.isArray(out[currentKey]) ? (out[currentKey] as unknown[]) : [];
      arr.push(unquote(listMatch[1]!.trim()));
      out[currentKey] = arr;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    currentKey = kv[1]!;
    const val = kv[2]!.trim();
    if (val === "") {
      out[currentKey] = [];
    } else if (val.startsWith("[") && val.endsWith("]")) {
      const inner = val.slice(1, -1).trim();
      out[currentKey] = inner ? inner.split(",").map((s) => unquote(s.trim())) : [];
    } else {
      out[currentKey] = unquote(val);
    }
  }
  return out;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export function isSkillMdUri(uri: string): boolean {
  const clean = uri.split(/[?#]/)[0] ?? uri;
  return clean.endsWith("/SKILL.md") || clean === "SKILL.md";
}

export function verifySkillMd(uri: string, text: string, entry: SkillEntry): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  const clean = uri.split(/[?#]/)[0] ?? uri;
  const parts = clean.split("/").filter(Boolean);
  const parent = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  if (parent !== entry.name) {
    return { ok: false, reason: `SKILL.md parent dir "${parent ?? ""}" does not match skill name "${entry.name}"` };
  }
  const fm = parseYamlFrontmatter(text);
  if (!fm) {
    return { ok: false, reason: "SKILL.md missing YAML frontmatter" };
  }
  if (fm["name"] !== entry.name) {
    return { ok: false, reason: `frontmatter name mismatch: expected "${entry.name}", got "${String(fm["name"])}"` };
  }
  if (fm["description"] !== entry.description) {
    return { ok: false, reason: `frontmatter description mismatch` };
  }
  const fmTools = fm["allowed-tools"] ?? fm["allowedTools"];
  if (entry.allowedTools !== undefined || fmTools !== undefined) {
    const a = JSON.stringify(entry.allowedTools ?? []);
    const b = JSON.stringify(Array.isArray(fmTools) ? fmTools : typeof fmTools === "string" ? fmTools.split(/\s+/).filter(Boolean) : []);
    if (a !== b) {
      return { ok: false, reason: `frontmatter allowed-tools mismatch` };
    }
  }
  return { ok: true };
}
