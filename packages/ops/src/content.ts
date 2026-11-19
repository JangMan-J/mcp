import { isObj, utf8Length } from "./common.js";

const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MIME_TOKEN = "[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*";
const MIME = new RegExp(`^${MIME_TOKEN}/${MIME_TOKEN}(?:\\s*;\\s*[A-Za-z0-9!#$&^_.+-]+=(?:[^\\s;"]+|"[^"]*"))*$`);
const URI_3986 = /^[A-Za-z][A-Za-z0-9+.-]*:(?:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]|%[0-9A-Fa-f]{2})*$/;

export function isBase64(s: unknown): s is string {
  return typeof s === "string" && s.length % 4 === 0 && B64.test(s);
}

export function isMimeType(s: unknown): s is string {
  return typeof s === "string" && MIME.test(s);
}

/** RFC 3986 URI syntax check (OPS-RES-6). */
export function isRfc3986Uri(s: unknown): s is string {
  return typeof s === "string" && URI_3986.test(s);
}

export type BlockType = "text" | "image" | "audio" | "resource_link" | "resource" | "unknown";

export interface ContentBlock {
  readonly type: BlockType;
  /** The block exactly as received. Never dropped, never rewritten. */
  readonly raw: unknown;
  /** The original `type` string when the block is unknown. */
  readonly rawType?: string;
  /** Flags such as unknown-type, invalid-base64, invalid-mimeType, invalid-uri, annotation-priority-out-of-range. */
  readonly issues: readonly string[];
}

export function checkAnnotations(a: unknown, issues: string[]): void {
  if (a === undefined) return;
  if (!isObj(a)) {
    issues.push("annotations-not-object");
    return;
  }
  const p = a["priority"];
  if (p !== undefined && (typeof p !== "number" || !(p >= 0 && p <= 1))) issues.push("annotation-priority-out-of-range");
  const aud = a["audience"];
  if (aud !== undefined && !(Array.isArray(aud) && aud.every((x) => x === "user" || x === "assistant"))) {
    issues.push("annotation-audience-invalid");
  }
}

export interface ResourceEntry {
  readonly raw: Record<string, unknown>;
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
  readonly issues: readonly string[];
}

/** Check one TextResourceContents / BlobResourceContents. Returns undefined when both or neither of text/blob exist. */
export function normalizeResourceContents(raw: unknown): ResourceEntry | undefined {
  if (!isObj(raw) || typeof raw["uri"] !== "string") return undefined;
  const hasText = "text" in raw;
  const hasBlob = "blob" in raw;
  if (hasText === hasBlob) return undefined;
  const issues: string[] = [];
  if (!isRfc3986Uri(raw["uri"])) issues.push("invalid-uri");
  if (raw["mimeType"] !== undefined && !isMimeType(raw["mimeType"])) issues.push("invalid-mimeType");
  if (hasText && typeof raw["text"] !== "string") issues.push("invalid-text");
  if (hasBlob && !isBase64(raw["blob"])) issues.push("invalid-base64");
  checkAnnotations(raw["annotations"], issues);
  return {
    raw,
    uri: raw["uri"],
    ...(typeof raw["mimeType"] === "string" ? { mimeType: raw["mimeType"] } : {}),
    ...(typeof raw["text"] === "string" ? { text: raw["text"] } : {}),
    ...(typeof raw["blob"] === "string" ? { blob: raw["blob"] } : {}),
    issues,
  };
}

/** Normalize one content block (OPS-TOOLS-13/14). Unknown types are preserved and flagged. */
export function normalizeContentBlock(raw: unknown): ContentBlock {
  if (!isObj(raw) || typeof raw["type"] !== "string") {
    return { type: "unknown", raw, issues: ["unknown-type", "not-a-typed-object"] };
  }
  const t = raw["type"];
  const issues: string[] = [];
  switch (t) {
    case "text":
      if (typeof raw["text"] !== "string") issues.push("invalid-text");
      break;
    case "image":
    case "audio":
      if (!isBase64(raw["data"])) issues.push("invalid-base64");
      if (!isMimeType(raw["mimeType"])) issues.push("invalid-mimeType");
      break;
    case "resource_link":
      if (typeof raw["uri"] !== "string") issues.push("invalid-uri");
      else if (!isRfc3986Uri(raw["uri"])) issues.push("invalid-uri");
      break;
    case "resource": {
      const e = normalizeResourceContents(raw["resource"]);
      if (!e) issues.push("invalid-embedded-resource");
      else issues.push(...e.issues);
      break;
    }
    default:
      return { type: "unknown", raw, rawType: t, issues: ["unknown-type"] };
  }
  checkAnnotations(raw["annotations"], issues);
  return { type: t, raw, issues };
}

export function normalizeContent(blocks: unknown): ContentBlock[] {
  return Array.isArray(blocks) ? blocks.map(normalizeContentBlock) : [];
}

/** Blocks whose data is unusable (invalid base64 or mime on image/audio, or blob). */
export function hasInvalidMedia(b: ContentBlock): boolean {
  return b.issues.some((i) => i === "invalid-base64" || i === "invalid-mimeType");
}

export interface Measure {
  readonly totalBytes: number;
  readonly blocks: readonly { readonly type: string; readonly bytes: number }[];
  readonly structuredContentBytes: number;
}

/** OPS-TOOLS-15: bytes per block only. The library never truncates. */
export function measure(result: unknown): Measure {
  const r = isObj(result) ? result : {};
  const blocks = (Array.isArray(r["content"]) ? r["content"] : []).map((b) => ({
    type: isObj(b) && typeof b["type"] === "string" ? b["type"] : "unknown",
    bytes: utf8Length(b),
  }));
  const structuredContentBytes = "structuredContent" in r ? utf8Length(r["structuredContent"]) : 0;
  return {
    totalBytes: blocks.reduce((n, b) => n + b.bytes, 0) + structuredContentBytes,
    blocks,
    structuredContentBytes,
  };
}
