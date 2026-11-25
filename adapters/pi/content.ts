/**
 * Convert MCP content blocks to Pi tool-result content.
 *
 * Pi's built-in MCP support truncates long text and offloads binary to temp
 * files. This bridge truncates text inline at the same order of magnitude and
 * passes images through as Pi image blocks; everything else degrades to a
 * text description so the model always sees something.
 */

import type { ContentBlock } from "@jangmanj/mcp/ops";
import type { PiContent } from "./pi-api.ts";

/** Per-text-block cap, matching Pi's generic tool-output limit of ~50 KB. */
export const MAX_TEXT_CHARS = 50_000;

export function truncateText(text: string): string {
	if (text.length <= MAX_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_TEXT_CHARS)}\n…${text.length - MAX_TEXT_CHARS} chars truncated…`;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function textBlock(text: unknown): PiContent {
	return { type: "text", text: truncateText(typeof text === "string" ? text : JSON.stringify(text)) };
}

export function convertBlocks(blocks: readonly ContentBlock[]): PiContent[] {
	const out: PiContent[] = [];
	for (const block of blocks) {
		const raw = asRecord(block.raw) ?? {};
		switch (block.type) {
			case "text":
				out.push(textBlock(raw.text));
				break;
			case "image": {
				const data = raw.data;
				const mimeType = raw.mimeType;
				if (typeof data === "string" && typeof mimeType === "string") {
					out.push({ type: "image", data, mimeType });
				} else {
					out.push(textBlock("[image block with invalid data omitted]"));
				}
				break;
			}
			case "audio":
				out.push(textBlock(`[audio${typeof raw.mimeType === "string" ? ` ${raw.mimeType}` : ""} omitted]`));
				break;
			case "resource_link": {
				const name = typeof raw.name === "string" ? raw.name : undefined;
				const uri = typeof raw.uri === "string" ? raw.uri : "(no uri)";
				out.push(textBlock(`Resource${name ? ` "${name}"` : ""}: ${uri}`));
				break;
			}
			case "resource": {
				const resource = asRecord(raw.resource) ?? raw;
				const uri = typeof resource.uri === "string" ? resource.uri : undefined;
				if (typeof resource.text === "string") {
					out.push(textBlock(resource.text));
				} else if (
					typeof resource.blob === "string" &&
					typeof resource.mimeType === "string" &&
					resource.mimeType.startsWith("image/")
				) {
					out.push({ type: "image", data: resource.blob, mimeType: resource.mimeType });
				} else {
					out.push(textBlock(`[binary resource${uri ? ` ${uri}` : ""} omitted]`));
				}
				break;
			}
			default:
				out.push(textBlock(block.raw));
		}
	}
	if (out.length === 0) out.push(textBlock("(no content)"));
	return out;
}
