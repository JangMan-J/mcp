/**
 * Header value encoding and `x-mcp-header` validation (IMPLEMENTATION_PLAN §7.2/§7.3).
 * No Node-only APIs: base64 is encoded from UTF-8 bytes by hand.
 */

const SENTINEL_RE = /^=\?base64\?.*\?=$/;
const TCHAR_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function base64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += alphabet[b0 >> 2]!;
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)]!;
    out += i + 1 < bytes.length ? alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)]! : "=";
    out += i + 2 < bytes.length ? alphabet[b2 & 0x3f]! : "=";
  }
  return out;
}

/** True when the plain value may be sent as-is (§7.2). */
export function isPlainHeaderSafe(value: string): boolean {
  if (SENTINEL_RE.test(value)) return false;
  if (value.length > 0 && (value.startsWith(" ") || value.startsWith("\t") || value.endsWith(" ") || value.endsWith("\t"))) {
    return false;
  }
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const visible = code >= 0x21 && code <= 0x7e;
    if (!visible && ch !== " " && ch !== "\t") return false;
  }
  return true;
}

export function encodeHeaderValue(value: string | number | boolean): string {
  const text = typeof value === "string" ? value : typeof value === "boolean" ? (value ? "true" : "false") : String(value);
  const encoded = isPlainHeaderSafe(text) ? text : `=?base64?${base64EncodeUtf8(text)}?=`;
  if (encoded.includes("\r") || encoded.includes("\n")) {
    throw new TypeError("Encoded header value must not contain CR/LF");
  }
  return encoded;
}

/** Case-insensitive lookup in a plain header record (HTTP-CASE-1). Values stay case-sensitive. */
export function getHeaderCaseInsensitive(
  headers: Readonly<Record<string, string>> | Headers,
  name: string,
): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Readonly<Record<string, string>>)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return undefined;
}

export interface AnnotatedParam {
  readonly path: readonly string[];
  readonly headerName: string; // value of x-mcp-header, used as Mcp-Param-{headerName}
  readonly type: "string" | "integer" | "boolean";
}

export interface XmcpValidation {
  readonly valid: boolean;
  readonly violations: readonly string[];
  readonly params: readonly AnnotatedParam[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface Found {
  path: string[];
  headerValue: unknown;
  schema: Record<string, unknown>;
  reachable: boolean;
  viaRef: boolean;
}

/**
 * Collect x-mcp-header annotations. Reachability follows only `properties`
 * chains; annotations under items/composition/conditionals/$ref are found
 * with reachable=false so the owning tool is rejected, never dereferenced.
 */
function collect(node: unknown, path: string[], reachable: boolean, viaRef: boolean, out: Found[]): void {
  if (!isRecord(node)) return;
  const nodeViaRef = viaRef || "$ref" in node;
  if ("x-mcp-header" in node) {
    out.push({ path, headerValue: node["x-mcp-header"], schema: node, reachable, viaRef: nodeViaRef });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && isRecord(value)) {
      for (const [prop, sub] of Object.entries(value)) {
        collect(sub, [...path, prop], reachable, nodeViaRef, out);
      }
    } else if (key === "propertyNames" || key === "additionalProperties") {
      collect(value, path, false, nodeViaRef, out);
    } else if (isRecord(value) || Array.isArray(value)) {
      // Any other nesting (items, oneOf/anyOf/allOf/not, if/then/else, $defs, ...) is not a properties chain.
      const items = Array.isArray(value) ? value : [value];
      for (const item of items) collect(item, path, false, nodeViaRef, out);
    }
  }
}

export function validateXmcpHeaderSchema(inputSchema: unknown): XmcpValidation {
  const violations: string[] = [];
  const params: AnnotatedParam[] = [];
  if (!isRecord(inputSchema)) {
    return { valid: true, violations, params };
  }
  const found: Found[] = [];
  collect(inputSchema, [], true, false, found);
  const seen = new Map<string, string>();
  for (const f of found) {
    const label = f.path.join(".") || "(root)";
    if (!f.reachable) {
      violations.push(`x-mcp-header at '${label}' is not reachable through a properties chain`);
      continue;
    }
    if (f.viaRef) {
      violations.push(`x-mcp-header at '${label}' is reached through $ref`);
      continue;
    }
    if (typeof f.headerValue !== "string" || f.headerValue.length === 0) {
      violations.push(`x-mcp-header at '${label}' must be a non-empty string`);
      continue;
    }
    if (!TCHAR_RE.test(f.headerValue)) {
      violations.push(`x-mcp-header at '${label}' is not a valid 1*tchar token`);
      continue;
    }
    const lower = f.headerValue.toLowerCase();
    if (seen.has(lower)) {
      violations.push(`x-mcp-header '${f.headerValue}' at '${label}' duplicates '${seen.get(lower)!}' case-insensitively`);
      continue;
    }
    seen.set(lower, f.headerValue);
    const type = f.schema["type"];
    if (type !== "string" && type !== "integer" && type !== "boolean") {
      violations.push(`x-mcp-header at '${label}' applies only to string/integer/boolean properties`);
      continue;
    }
    params.push({ path: f.path, headerName: f.headerValue, type });
  }
  return { valid: violations.length === 0, violations, params };
}

/** Extract a value at an exact property path; undefined when absent. */
export function extractAtPath(args: unknown, path: readonly string[]): unknown {
  let cur: unknown = args;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Built-in read-only methods (mirrors core recovery policy, §6.5). */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "server/discover",
  "tools/list",
  "prompts/list",
  "prompts/get",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "completion/complete",
  "subscriptions/listen",
]);

export function isReadOnlyMethod(method: string): boolean {
  return READ_ONLY_METHODS.has(method);
}
