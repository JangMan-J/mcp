import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Outcome } from "@mcp-client/core";

const modelTextBytes = 20 * 1024;

function resultText(value: unknown): string {
  if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
    return value.content.map(block => {
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      return `[${block?.type ?? "unknown"} content]`;
    }).join("\n");
  }
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

function modelText(outcome: Outcome<unknown>): string {
  switch (outcome.kind) {
    case "ok": return resultText(outcome.value);
    case "tool-isError": return resultText(outcome.result);
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
export async function renderOutcome<T>(outcome: Outcome<T>) {
  const { text, spillPath } = await bounded(modelText(outcome));
  return {
    content: [{ type: "text" as const, text }],
    isError: outcome.kind !== "ok" && outcome.kind !== "task-handle" && outcome.kind !== "mrtr-interim",
    details: { outcome, spillPath },
  };
}
