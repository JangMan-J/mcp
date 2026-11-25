/** SEP-2640 MCP skills tools: list_mcp_skills, read_mcp_skill, read_mcp_skill_file. */

import type { McpClient } from "@jangmanj/mcp/core";
import {
	SKILLS_EXTENSION_ID,
	SkillsClient,
	MemorySkillCache,
	type SkillEntry,
} from "@jangmanj/mcp/ext-skills";
import type { Exposure } from "./config.ts";
import type { ExtensionAPI, ToolExposure, ToolResult } from "./pi-api.ts";
import { offloadText } from "./result-files.ts";

export const SKILL_TOOL_NAMES = [
	"list_mcp_skills",
	"read_mcp_skill",
	"read_mcp_skill_file",
] as const;

export interface SkillServer {
	readonly name: string;
	readonly status: string;
	readonly enabled?: boolean;
	readonly client?: McpClient | undefined;
	readonly capabilities?: Record<string, unknown> | undefined;
	readonly skillsClient?: SkillsClient | undefined;
	readonly skills?: readonly SkillEntry[] | undefined;
}

export function hasSkills(state: SkillServer): boolean {
	const caps = state.capabilities;
	if (!caps || typeof caps !== "object") return false;
	if (typeof caps.resources !== "object" || caps.resources === null) return false;
	const exts = caps.extensions;
	if (!exts || typeof exts !== "object" || Array.isArray(exts)) return false;
	const s = (exts as Record<string, unknown>)[SKILLS_EXTENSION_ID];
	return typeof s === "object" && s !== null && !Array.isArray(s);
}

function exposureRank(e: Exposure): number {
	return e === "direct" ? 3 : e === "codemode" ? 2 : e === "deferred" ? 1 : 0;
}

function toPiExposure(e: Exposure): ToolExposure {
	return e === "codemode" ? "deferred" : e;
}

export function widestSkillExposure(
	states: readonly SkillServer[],
	exposures: ReadonlyMap<string, Exposure>,
): Exposure {
	let best: Exposure = "hidden";
	for (const state of states) {
		if (state.status !== "connected" || state.enabled === false || !hasSkills(state)) continue;
		const e = exposures.get(state.name) ?? "codemode";
		if (exposureRank(e) > exposureRank(best)) best = e;
	}
	return best;
}

function escapeAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Tag loaded MCP skill content with explicit untrusted server provenance (SEP-2640). */
export function formatOriginTaggedSkill(server: string, skillUri: string, fileUri: string, text: string): string {
	const baseUri = skillUri.replace(/\/SKILL\.md$/u, "");
	return `<mcp_skill server="${escapeAttr(server)}" skill_uri="${escapeAttr(skillUri)}" file_uri="${escapeAttr(fileUri)}" base_uri="${escapeAttr(baseUri)}" trust="untrusted-mcp-origin">\n${text}\n</mcp_skill>`;
}

export function createServerSkillsClient(
	serverName: string,
	client: McpClient,
	capabilities: Record<string, unknown> | undefined,
	cache: MemorySkillCache,
): SkillsClient {
	return new SkillsClient({
		client,
		serverKey: serverName,
		...(capabilities !== undefined ? { capabilities } : {}),
		cache,
	});
}

export class SkillTools {
	#lastExposure: Exposure | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly states: () => SkillServer[],
		private readonly exposures: ReadonlyMap<string, Exposure>,
	) {}

	ensure(): void {
		const next = widestSkillExposure(this.states(), this.exposures);
		if (next === this.#lastExposure || (this.#lastExposure === undefined && next === "hidden")) return;
		const wasDirect = this.#lastExposure === "direct";
		this.#lastExposure = next;
		const exposure = toPiExposure(next);
		const annotations = { readOnlyHint: true };

		this.pi.registerTool({
			name: "list_mcp_skills",
			label: "List MCP Skills",
			description:
				"List SEP-2640 skills advertised by connected MCP servers (name, description, SKILL.md uri, and file manifest).",
			parameters: {
				type: "object",
				properties: { server: { type: "string" } },
			},
			exposure,
			annotations,
			execute: (_id, params) => this.list(params),
		});
		this.pi.registerTool({
			name: "read_mcp_skill",
			label: "Read MCP Skill",
			description:
				"Load and SHA-256/frontmatter-verify an MCP-served SKILL.md by server and uri (SEP-2640).",
			parameters: {
				type: "object",
				properties: {
					server: { type: "string" },
					uri: { type: "string", description: "SKILL.md URI (e.g. skill://name/SKILL.md)" },
				},
				required: ["server", "uri"],
			},
			exposure,
			annotations,
			execute: (_id, params) => this.readSkill(params),
		});
		this.pi.registerTool({
			name: "read_mcp_skill_file",
			label: "Read MCP Skill File",
			description:
				"Read and SHA-256-verify a supporting file listed in an MCP skill manifest (bound to the originating server).",
			parameters: {
				type: "object",
				properties: {
					server: { type: "string" },
					skillUri: { type: "string", description: "Enclosing skill SKILL.md URI" },
					fileUri: { type: "string", description: "Supporting file URI listed in the skill manifest" },
				},
				required: ["server", "skillUri", "fileUri"],
			},
			exposure,
			annotations,
			execute: (_id, params) => this.readFile(params),
		});

		if (wasDirect && exposure !== "direct") {
			const drop = new Set<string>(SKILL_TOOL_NAMES);
			this.pi.setActiveTools(this.pi.getActiveTools().filter((n) => !drop.has(n)));
		}
	}

	private server(name: string): SkillServer & { skillsClient: SkillsClient } {
		const state = this.states().find((s) => s.name === name);
		if (!state?.skillsClient || state.status !== "connected" || state.enabled === false) {
			throw new Error(`MCP server "${name}" does not have an active skills client`);
		}
		return state as SkillServer & { skillsClient: SkillsClient };
	}

	private async list(params: Record<string, unknown>): Promise<ToolResult> {
		const server = params.server;
		if (server !== undefined && typeof server !== "string") throw new Error("server must be a string");
		const targets = typeof server === "string"
			? [this.server(server)]
			: this.states().filter((s): s is SkillServer & { skillsClient: SkillsClient } =>
					s.status === "connected" && s.enabled !== false && Boolean(s.skillsClient) && hasSkills(s),
				);
		const skills: Array<Record<string, unknown>> = [];
		for (const target of targets) {
			const listed = await target.skillsClient.listAll();
			if (listed.kind !== "ok") continue;
			for (const entry of listed.value.skills) {
				skills.push({
					server: target.name,
					uri: entry.uri,
					name: entry.name,
					description: entry.description,
					files: entry.files.map((f) => ({ uri: f.uri, size: f.size, sha256: f.sha256 })),
				});
			}
		}
		const offloaded = await offloadText(JSON.stringify({ skills }, null, 2));
		return {
			content: [{ type: "text", text: offloaded.text }],
			details: offloaded.filePath !== undefined ? { fullTextPath: offloaded.filePath } : {},
			structuredContent: { skills },
		};
	}

	private async readSkill(params: Record<string, unknown>): Promise<ToolResult> {
		const server = params.server;
		const uri = params.uri;
		if (typeof server !== "string" || typeof uri !== "string") throw new Error("server and uri are required");
		const state = this.server(server);
		if (!state.skillsClient.isKnownSkill(uri)) {
			const got = await state.skillsClient.get(uri);
			if (got.kind !== "ok") throw new Error(`skills/get failed: ${got.kind}`);
		}
		const read = await state.skillsClient.readFile(uri, uri);
		if (read.kind !== "ok") throw new Error(`read_mcp_skill verification failed: ${JSON.stringify(read)}`);
		const tagged = formatOriginTaggedSkill(server, uri, uri, read.value.text);
		const offloaded = await offloadText(tagged);
		return {
			content: [{ type: "text", text: offloaded.text }],
			details: { server, skillUri: uri, sha256: read.value.file.sha256 },
			structuredContent: { server, uri, sha256: read.value.file.sha256, text: read.value.text },
		};
	}

	private async readFile(params: Record<string, unknown>): Promise<ToolResult> {
		const server = params.server;
		const skillUri = params.skillUri;
		const fileUri = params.fileUri;
		if (typeof server !== "string" || typeof skillUri !== "string" || typeof fileUri !== "string") {
			throw new Error("server, skillUri, and fileUri are required");
		}
		const state = this.server(server);
		if (!state.skillsClient.isKnownSkill(skillUri)) {
			const got = await state.skillsClient.get(skillUri);
			if (got.kind !== "ok") throw new Error(`skills/get failed: ${got.kind}`);
		}
		const read = await state.skillsClient.readFile(skillUri, fileUri);
		if (read.kind !== "ok") throw new Error(`read_mcp_skill_file verification failed: ${JSON.stringify(read)}`);
		const tagged = formatOriginTaggedSkill(server, skillUri, fileUri, read.value.text);
		const offloaded = await offloadText(tagged);
		return {
			content: [{ type: "text", text: offloaded.text }],
			details: { server, skillUri, fileUri, sha256: read.value.file.sha256 },
			structuredContent: { server, skillUri, fileUri, sha256: read.value.file.sha256, text: read.value.text },
		};
	}
}
