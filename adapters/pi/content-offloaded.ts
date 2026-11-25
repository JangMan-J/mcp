/** Async content conversion with built-in MCP's 20 KB middle-out truncation. */

import type { ContentBlock } from "@jangmanj/mcp/ops";
import type { PiContent } from "./pi-api.ts";
import { offloadBinary, offloadText } from "./result-files.ts";

function asRecord(v: unknown): Record<string, unknown> | undefined {
	return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

export async function convertBlocksOffloaded(blocks: readonly ContentBlock[]): Promise<PiContent[]> {
	const out: PiContent[] = [];
	for (const block of blocks) {
		const raw = asRecord(block.raw) ?? {};
		switch (block.type) {
			case "text": {
				const text = typeof raw.text === "string" ? raw.text : JSON.stringify(raw.text);
				out.push({ type: "text", text: (await offloadText(text)).text });
				break;
			}
			case "image": {
				if (typeof raw.data === "string" && typeof raw.mimeType === "string") {
					out.push({ type: "image", data: raw.data, mimeType: raw.mimeType });
				} else out.push({ type: "text", text: "[image block with invalid data omitted]" });
				break;
			}
			case "audio":
				out.push({ type: "text", text: `[audio${typeof raw.mimeType === "string" ? ` ${raw.mimeType}` : ""} omitted]` });
				break;
			case "resource_link":
				out.push({ type: "text", text: `Resource${typeof raw.name === "string" ? ` "${raw.name}"` : ""}: ${typeof raw.uri === "string" ? raw.uri : "(no uri)"}` });
				break;
			case "resource": {
				const resource = asRecord(raw.resource) ?? raw;
				if (typeof resource.text === "string") {
					out.push({ type: "text", text: (await offloadText(resource.text)).text });
				} else if (typeof resource.blob === "string" && typeof resource.mimeType === "string" && resource.mimeType.startsWith("image/")) {
					out.push({ type: "image", data: resource.blob, mimeType: resource.mimeType });
				} else if (typeof resource.blob === "string") {
					const path = await offloadBinary(Buffer.from(resource.blob, "base64"));
					out.push({ type: "text", text: `[binary resource saved to ${path}]` });
				} else {
					out.push({ type: "text", text: `[binary resource${typeof resource.uri === "string" ? ` ${resource.uri}` : ""} omitted]` });
				}
				break;
			}
			default:
				out.push({ type: "text", text: JSON.stringify(block.raw) });
		}
	}
	if (out.length === 0) out.push({ type: "text", text: "(no content)" });
	return out;
}
