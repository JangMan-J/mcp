import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Outcome } from "@mcp-client/core";

const modelTextBytes = 20 * 1024;

type Image = { type: "image"; data: string; mimeType: string };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isImage = (b: any): boolean => b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string";

function isImageMimeType(mimeType: unknown): mimeType is string {
  return typeof mimeType === "string" && mimeType.trim().toLowerCase().startsWith("image/");
}

function isTextMimeType(mimeType: unknown): boolean {
  if (typeof mimeType !== "string") return false;
  const base = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return base.startsWith("text/") || base === "application/json" || base.endsWith("+json") || base.endsWith("+xml");
}

function extensionFromUri(uri: string): string {
  let pathname = uri;
  try {
    pathname = new URL(uri).pathname;
  } catch {
    // Non-URL URI or relative path; match against raw string.
  }
  const match = /\.[A-Za-z0-9]{1,8}$/.exec(pathname);
  return match ? match[0] : ".bin";
}

async function spillBinaryResource(uri: string, mimeType: unknown, bytes: Buffer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-"));
  const filePath = join(directory, `resource${extensionFromUri(uri)}`);
  try {
    await writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return filePath;
}

function linkText(b: any, server?: string): string {
  const parts = [`[resource_link${server ? ` from ${server}` : ""}]`];
  if (typeof b.name === "string") parts.push(b.name);
  if (typeof b.uri === "string") parts.push(b.uri);
  if (typeof b.mimeType === "string") parts.push(`(${b.mimeType})`);
  if (typeof b.description === "string") parts.push(`- ${b.description}`);
  return parts.join(" ");
}

function resultImages(value: unknown): Image[] {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) return [];
  const images: Image[] = [];
  for (const b of value.content) {
    if (isImage(b)) {
      images.push({ type: "image", data: b.data, mimeType: b.mimeType });
    } else if (b?.type === "resource" && isRecord(b.resource) && typeof b.resource.blob === "string" && isImageMimeType(b.resource.mimeType)) {
      images.push({ type: "image", data: b.resource.blob, mimeType: b.resource.mimeType });
    }
  }
  return images;
}

async function resultText(value: unknown, server: string | undefined, binarySpillPaths: string[]): Promise<string> {
  if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
    const lines: string[] = [];
    for (const block of value.content) {
      if (isImage(block)) continue;
      if (block?.type === "text" && typeof block.text === "string") {
        lines.push(block.text);
      } else if (block?.type === "resource_link") {
        lines.push(linkText(block, server));
      } else if (block?.type === "audio") {
        lines.push(typeof block.mimeType === "string" && block.mimeType.length > 0 ? `[audio content (${block.mimeType})]` : "[audio content]");
      } else if (block?.type === "resource" && isRecord(block.resource)) {
        const res = block.resource;
        if (typeof res.text === "string") {
          lines.push(res.text);
        } else if (typeof res.blob === "string") {
          if (isImageMimeType(res.mimeType)) continue;
          const bytes = Buffer.from(res.blob, "base64");
          if (isTextMimeType(res.mimeType)) {
            lines.push(bytes.toString("utf8"));
          } else {
            const uri = typeof res.uri === "string" ? res.uri : "unknown";
            const mime = typeof res.mimeType === "string" && res.mimeType.length > 0 ? res.mimeType : "unknown type";
            const filePath = await spillBinaryResource(uri, res.mimeType, bytes);
            binarySpillPaths.push(filePath);
            lines.push(`[Binary resource ${uri} (${mime}, ${bytes.length} bytes) saved to ${filePath}]`);
          }
        } else {
          lines.push("[resource content]");
        }
      } else {
        lines.push(`[${block?.type ?? "unknown"} content]`);
      }
    }
    return lines.join("\n");
  }
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

async function modelText(outcome: Outcome<unknown>, server: string | undefined, binarySpillPaths: string[]): Promise<string> {
  switch (outcome.kind) {
    case "ok": return resultText(outcome.value, server, binarySpillPaths);
    case "tool-isError": return resultText(outcome.result, server, binarySpillPaths);
    case "uncertain-write": return "Uncertain write: the operation may or may not have run; do not retry blindly. Check its effects first.";
    case "jsonrpc-error": return `JSON-RPC error ${outcome.code}: ${outcome.message}`;
    case "transport-failure": return `Transport failure (${outcome.failure.kind}): ${outcome.failure.message}`;
    default: return `MCP outcome: ${outcome.kind}`;
  }
}

async function bounded(text: string) {
  const bytes = Buffer.from(text);
  if (bytes.length <= modelTextBytes) return { text, spillPath: undefined };
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-"));
  const spillPath = join(directory, "result.txt");
  try {
    await writeFile(spillPath, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  const marker = `\n[… full text: ${spillPath} …]\n`;
  const budget = modelTextBytes - Buffer.byteLength(marker);
  let head = Math.floor(budget / 2);
  let tail = bytes.length - (budget - head);
  // Neither slice may begin/end partway through a UTF-8 sequence.
  while ((bytes[head]! & 0xc0) === 0x80) head--;
  while ((bytes[tail]! & 0xc0) === 0x80) tail++;
  return { text: bytes.toString("utf8", 0, head) + marker + bytes.toString("utf8", tail), spillPath };
}

/** Caller owns the spill directory and may remove it once the model no longer needs it. */
export async function renderOutcome<T>(
  outcome: Outcome<T>,
  options: { server?: string; includeStructuredContent?: boolean } = {},
) {
  const binarySpillPaths: string[] = [];
  const { text, spillPath } = await bounded(await modelText(outcome, options.server, binarySpillPaths));
  const raw = outcome.kind === "ok" ? outcome.value : outcome.kind === "tool-isError" ? outcome.result : undefined;
  const images = resultImages(raw);
  const content: Array<{ type: "text"; text: string } | Image> = [...images];
  if (text || images.length === 0) content.unshift({ type: "text", text });

  let rawCallToolResult: Record<string, unknown> | undefined;
  if (isRecord(raw) && Array.isArray(raw.content)) {
    const { _meta: _, ...clean } = raw;
    rawCallToolResult = clean;
  }

  return {
    content,
    isError: outcome.kind !== "ok" && outcome.kind !== "task-handle" && outcome.kind !== "mrtr-interim",
    details: {
      outcome,
      spillPath,
      ...(binarySpillPaths.length > 0 ? { binarySpillPaths: binarySpillPaths as readonly string[] } : {}),
      ...(rawCallToolResult !== undefined ? { rawCallToolResult } : {}),
    },
    ...(rawCallToolResult !== undefined && options.includeStructuredContent !== false
      ? { structuredContent: rawCallToolResult }
      : {}),
  };
}

const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "dependentSchemas", "dependencies", "$defs", "definitions"]);

export function relocateSchemaRefs(schema: unknown, pointer: string): unknown {
  if (schema === null || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(item => relocateSchemaRefs(item, pointer));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (DATA_KEYWORDS.has(key)) {
      out[key] = value;
    } else if (key === "$ref" && typeof value === "string") {
      if (value === "#") {
        out[key] = pointer;
      } else if (value.startsWith("#/")) {
        out[key] = pointer === "#" ? value : `${pointer}${value.slice(1)}`;
      } else {
        out[key] = value;
      }
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && isRecord(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [mapKey, mapVal] of Object.entries(value)) {
        mapped[mapKey] = relocateSchemaRefs(mapVal, pointer);
      }
      out[key] = mapped;
    } else {
      out[key] = relocateSchemaRefs(value, pointer);
    }
  }
  return out;
}

export function createCallToolResultSchema(
  structuredContentSchema?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      content: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
            text: { type: "string" },
            data: { type: "string" },
            mimeType: { type: "string" },
          },
          required: ["type"],
          additionalProperties: true,
        },
      },
      structuredContent: structuredContentSchema
        ? relocateSchemaRefs(structuredContentSchema, "#/properties/structuredContent")
        : {},
      isError: { type: "boolean" },
    },
    required: ["content"],
    additionalProperties: true,
  };
}
