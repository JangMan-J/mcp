/** Built-in MCP resource tools: list_mcp_resources, list_mcp_resource_templates, read_mcp_resource. */

import type { Outcome } from "../../dist/index.js";
import type { McpClient } from "../../dist/index.js";
import type { Ops } from "../../dist/ops/index.js";
import type { Exposure } from "./config.ts";
import { offloadBinary, offloadText } from "./result-files.ts";
import type { ExtensionAPI, ToolResult } from "./pi-api.ts";

export interface ResourceServer {
	readonly name: string;
	readonly status: string;
	readonly client?: McpClient | undefined;
	readonly ops?: Ops | undefined;
	readonly capabilities?: Record<string, unknown> | undefined;
}

export function hasResources(state: ResourceServer): boolean {
	return typeof state.capabilities?.resources === "object" && state.capabilities.resources !== null;
}

function exposureRank(e: Exposure): number {
	return e === "direct" ? 3 : e === "codemode" ? 2 : e === "deferred" ? 1 : 0;
}

export function widestExposure(states: readonly ResourceServer[], exposures: ReadonlyMap<string, Exposure>): Exposure {
	let best: Exposure = "hidden";
	for (const state of states) {
		if (state.status !== "connected" || !hasResources(state)) continue;
		const e = exposures.get(state.name) ?? "codemode";
		if (exposureRank(e) > exposureRank(best)) best = e;
	}
	return best;
}

async function transientRetry<T>(fn: () => Promise<Outcome<T>>): Promise<Outcome<T>> {
	const first = await fn();
	if (
		first.kind === "transport-failure" &&
		[408, 429].includes(first.failure.status ?? 0) ||
		(first.kind === "transport-failure" && (first.failure.status ?? 0) >= 500)
	) {
		return fn();
	}
	return first;
}

function jsonText(value: unknown): Promise<ToolResult> {
	return offloadText(JSON.stringify(value, null, 2)).then((offloaded) => ({
		content: [{ type: "text", text: offloaded.text }],
		details: offloaded.filePath !== undefined ? { fullTextPath: offloaded.filePath } : {},
	}));
}

export class ResourceTools {
	#registered = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly states: () => ResourceServer[],
		private readonly exposures: ReadonlyMap<string, Exposure>,
	) {}

	ensure(): void {
		const states = this.states().filter((s) => s.status === "connected" && hasResources(s));
		if (states.length === 0) return;
		const exposure = widestExposure(states, this.exposures);
		if (this.#registered) return;
		this.#registered = true;
		const annotations = { readOnlyHint: true };
		this.pi.registerTool({
			name: "list_mcp_resources",
			label: "List MCP Resources",
			description: "List resources offered by MCP servers as JSON. Pass server for one page, or omit for all servers.",
			parameters: {
				type: "object",
				properties: { server: { type: "string" }, cursor: { type: "string" } },
			},
			exposure,
			annotations,
			execute: (_id, params) => this.list(params),
		});
		this.pi.registerTool({
			name: "list_mcp_resource_templates",
			label: "List MCP Resource Templates",
			description: "List URI templates for resources MCP servers do not list directly.",
			parameters: {
				type: "object",
				properties: { server: { type: "string" }, cursor: { type: "string" } },
			},
			exposure,
			annotations,
			execute: (_id, params) => this.listTemplates(params),
		});
		this.pi.registerTool({
			name: "read_mcp_resource",
			label: "Read MCP Resource",
			description: "Read one MCP resource by server and uri. Text and images are returned inline; other binary is saved to a temp file.",
			parameters: {
				type: "object",
				properties: { server: { type: "string" }, uri: { type: "string" } },
				required: ["server", "uri"],
			},
			exposure,
			annotations,
			execute: (_id, params) => this.read(params),
		});
	}

	private server(name: string): ResourceServer {
		const state = this.states().find((s) => s.name === name);
		if (!state?.ops || state.status !== "connected") throw new Error(`MCP server "${name}" is not connected`);
		return state;
	}

	private async list(params: Record<string, unknown>): Promise<ToolResult> {
		const server = params.server;
		const cursor = params.cursor;
		if (server !== undefined && typeof server !== "string") throw new Error("server must be a string");
		if (cursor !== undefined && typeof cursor !== "string") throw new Error("cursor must be a string");
		if (typeof server === "string") {
			const state = this.server(server);
			const outcome = await transientRetry(() => state.ops!.resources.list({ ...(cursor !== undefined ? { cursor } : {}) }));
			if (outcome.kind !== "ok") throw new Error(`resources/list failed: ${outcome.kind}`);
			return jsonText({
				server,
				resources: outcome.value.items.map((item) => ({ server, ...item.raw })),
				...(outcome.value.nextCursor !== undefined ? { nextCursor: outcome.value.nextCursor } : {}),
			});
		}
		const resources: unknown[] = [];
		for (const state of this.states()) {
			if (state.status !== "connected" || !state.ops || !hasResources(state)) continue;
			const outcome = await transientRetry(() => state.ops!.resources.listAll());
			if (outcome.kind !== "ok") throw new Error(`resources/list ${state.name} failed: ${outcome.kind}`);
			for (const item of outcome.value.items) resources.push({ server: state.name, ...item.raw });
		}
		return jsonText({ resources });
	}

	private async listTemplates(params: Record<string, unknown>): Promise<ToolResult> {
		const server = params.server;
		const cursor = params.cursor;
		const states = typeof server === "string" ? [this.server(server)] : this.states().filter((s) => s.status === "connected" && s.ops && hasResources(s));
		const resourceTemplates: unknown[] = [];
		let nextCursor: string | undefined;
		for (const state of states) {
			const outcome = await transientRetry(() => state.ops!.resources.listTemplates({ ...(cursor !== undefined ? { cursor: cursor as string } : {}) }));
			if (outcome.kind !== "ok") throw new Error(`resources/templates/list ${state.name} failed: ${outcome.kind}`);
			for (const item of outcome.value.items) resourceTemplates.push({ server: state.name, ...item.raw });
			nextCursor = outcome.value.nextCursor;
		}
		return jsonText({ resourceTemplates, ...(nextCursor !== undefined ? { nextCursor } : {}) });
	}

	private async read(params: Record<string, unknown>): Promise<ToolResult> {
		const server = params.server;
		const uri = params.uri;
		if (typeof server !== "string" || typeof uri !== "string") throw new Error("server and uri are required");
		const state = this.server(server);
		const outcome = await transientRetry(() => state.ops!.resources.read(uri));
		if (outcome.kind !== "ok") throw new Error(`resources/read failed: ${outcome.kind}`);
		const content: ToolResult["content"] = [];
		for (const entry of outcome.value.contents) {
			if (typeof entry.text === "string") {
				content.push({ type: "text", text: (await offloadText(entry.text)).text });
			} else if (typeof entry.blob === "string" && typeof entry.mimeType === "string" && entry.mimeType.startsWith("image/")) {
				content.push({ type: "image", data: entry.blob, mimeType: entry.mimeType });
			} else if (typeof entry.blob === "string") {
				const path = await offloadBinary(Buffer.from(entry.blob, "base64"));
				content.push({ type: "text", text: `[binary resource ${entry.uri} saved to ${path}]` });
			}
		}
		if (content.length === 0) content.push({ type: "text", text: "(empty resource)" });
		return { content, details: { server, uri } };
	}
}
