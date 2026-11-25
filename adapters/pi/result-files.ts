/** Temp-file offload for large text/binary results, matching built-in MCP's UX. */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_INLINE_TEXT = 20_000;

export interface OffloadedText {
	readonly text: string;
	readonly filePath?: string;
}

/** Middle-out truncation at 20 KB with the full text saved to a temp file. */
export async function offloadText(text: string): Promise<OffloadedText> {
	if (text.length <= MAX_INLINE_TEXT) return { text };
	const filePath = join(tmpdir(), `mcp-client-${randomUUID()}.txt`);
	await writeFile(filePath, text);
	const removed = text.length - MAX_INLINE_TEXT;
	const half = MAX_INLINE_TEXT / 2;
	return {
		text: `${text.slice(0, half)}\n…${removed} chars truncated; full text saved to ${filePath}…\n${text.slice(-half)}`,
		filePath,
	};
}

export async function offloadBinary(bytes: Uint8Array, extension = "bin"): Promise<string> {
	const filePath = join(tmpdir(), `mcp-client-${randomUUID()}.${extension}`);
	await writeFile(filePath, bytes);
	return filePath;
}
