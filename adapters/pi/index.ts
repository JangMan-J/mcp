/**
 * Pi extension entry: replaces Pi's built-in MCP session support with a
 * bridge implemented on this library (@jangmanj/mcp), adding MCP 2026-07-28
 * and SEP-3415 push-event delivery via pi.sendMessage().
 *
 * Registering the /mcp command makes Pi stand down its built-in MCP
 * extension for sessions (docs/mcp.md#replace-the-built-in-mcp-support).
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { configuredExposuresOf, McpBridge, sanitizeNamePart, type ServerState } from "./bridge.ts";
import {
	agentDir,
	loadServerConfigs,
	persistServerUpdate,
	serverKey,
	type ResolvedServerConfig,
} from "./config.ts";
import type { ExtensionAPI, McpServerEntry, ModelRegistryLike, SessionContext, Ui } from "./pi-api.ts";
import { RESOURCE_TOOL_NAMES } from "./resources.ts";
import { SKILL_TOOL_NAMES } from "./skills.ts";
import { TASK_TOOL_NAMES } from "./tasks.ts";

const MCP_SERVERS_SECTION = "mcp_servers";
const MCP_SKILLS_SECTION = "mcp_skills";
const MAX_SERVER_DESCRIPTION_CHARS = 250;
const MAX_SERVERS_SECTION_CHARS = 4096;
const META_TOOL_SET = new Set<string>([...RESOURCE_TOOL_NAMES, ...SKILL_TOOL_NAMES, ...TASK_TOOL_NAMES]);

/** Tolerantly unwrap pi.getMcpServers() / mcp_servers_change event shapes. */
export function registeredServersOf(x: unknown): Map<string, McpServerEntry> {
	const out = new Map<string, McpServerEntry>();
	const put = (name: unknown, value: unknown) => {
		if (typeof name !== "string" || name === "") return;
		const rec = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
		const config = (typeof rec.config === "object" && rec.config !== null ? rec.config : rec) as McpServerEntry;
		out.set(name, config);
	};
	if (x instanceof Map) {
		for (const [k, v] of x) put(k, v);
	} else if (Array.isArray(x)) {
		for (const item of x) {
			if (Array.isArray(item)) put(item[0], item[1]);
			else if (typeof item === "object" && item !== null) {
				const rec = item as Record<string, unknown>;
				put(rec.name, rec.config ?? rec);
			}
		}
	} else if (typeof x === "object" && x !== null) {
		for (const [k, v] of Object.entries(x)) put(k, v);
	}
	return out;
}

function hasDirectTools(state: ServerState): boolean {
	return configuredExposuresOf(state.config).has("direct");
}

function hasIndirectTools(state: ServerState): boolean {
	const ex = configuredExposuresOf(state.config);
	return ex.has("codemode") || ex.has("deferred");
}

function truncateSummary(text: string, max: number): string {
	if (text.length <= max) return text;
	return max <= 1 ? "" : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Render Pi's `mcp_servers` system prompt section (mirrors built-in renderServersSection). */
export function renderServersSection(states: readonly ServerState[]): string | undefined {
	const listed = states
		.filter((s) => s.config.enabled && hasIndirectTools(s))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (listed.length === 0) return undefined;

	const reaches = listed.map((s) =>
		configuredExposuresOf(s.config).has("codemode") ? "codemode" : "tool_search",
	);
	const reachSet = new Set(reaches);
	let intro = "MCP servers whose tools are not declared to you.";
	if (reachSet.has("codemode")) intro += " Call the tools of `codemode` servers from codemode scripts.";
	if (reachSet.has("tool_search")) intro += " Load the tools of `tool_search` servers with `tool_search`.";

	const heads = listed.map((s, idx) => `- mcp__${sanitizeNamePart(s.name)} (${reaches[idx]})`);
	const omitted = (count: number) =>
		count > 0 ? [`- … ${count} more server${count === 1 ? "" : "s"}; find their tools with searchTools()`] : [];
	const size = (kept: number) =>
		[intro, ...heads.slice(0, kept), ...omitted(listed.length - kept)].join("\n").length;

	let kept = listed.length;
	while (kept > 0 && size(kept) > MAX_SERVERS_SECTION_CHARS) kept--;
	const perServer =
		kept === 0
			? 0
			: Math.min(MAX_SERVER_DESCRIPTION_CHARS, Math.floor((MAX_SERVERS_SECTION_CHARS - size(kept)) / kept) - 2);

	const lines = listed.slice(0, kept).map((s, idx) => {
		const rawSummary = (s.config.description ?? s.description ?? "").split("\n")[0]?.trim() ?? "";
		const summary = perServer > 0 && rawSummary ? truncateSummary(rawSummary, perServer) : "";
		return summary ? `${heads[idx]}: ${summary}` : heads[idx];
	});
	return [intro, ...lines, ...omitted(listed.length - kept)].join("\n");
}

/** Render origin-tagged SEP-2640 MCP skills index so MCP skills never silently shadow filesystem skills. */
export function renderMcpSkillsSection(states: readonly ServerState[]): string | undefined {
	const lines: string[] = [];
	for (const s of [...states].sort((a, b) => a.name.localeCompare(b.name))) {
		if (!s.config.enabled || s.status !== "connected" || !s.skills || s.skills.length === 0) continue;
		for (const skill of s.skills) {
			const desc = skill.description.split("\n")[0]?.trim() ?? "";
			lines.push(`- [mcp:${s.name}] ${skill.name} (${skill.uri})${desc ? `: ${truncateSummary(desc, 180)}` : ""}`);
		}
	}
	if (lines.length === 0) return undefined;
	return [
		"MCP-served skills (untrusted remote origin; load on demand with read_mcp_skill({ server, uri })):",
		...lines,
	].join("\n");
}

function reachesServer(reach: "all" | readonly string[], serverName: string): boolean {
	if (reach === "all") return true;
	const ns = `mcp__${sanitizeNamePart(serverName)}`;
	return reach.some((word) => word.includes(ns) || word === serverName || word === serverKey(serverName));
}

export default function (pi: ExtensionAPI) {
	let currentUi: Ui | undefined;
	let currentModelRegistry: ModelRegistryLike | undefined;
	let fileOnlyConfigs = new Map<string, ResolvedServerConfig>();
	let overriddenNotices: string[] = [];
	let waitedForStartup = false;

	const currentAgentDir = () => agentDir(process.env as Record<string, string | undefined>, homedir());

	const bridge = new McpBridge({
		pi,
		notify: (message, level) => currentUi?.notify(message, level),
		credentialStorePath: join(currentAgentDir(), "mcp-oauth.json"),
		diagnosticsLogPath: join(currentAgentDir(), "mcp.log"),
		confirm: (title, message) => currentUi?.confirm?.(title, message) ?? Promise.resolve(false),
		providerToken: (provider) => currentModelRegistry?.getApiKeyForProvider?.(provider),
		ui: {
			notify: (message, level) => currentUi?.notify(message, level),
			confirm: (title, message) => currentUi?.confirm?.(title, message) ?? Promise.resolve(false),
			input: (title, placeholder) => currentUi?.input?.(title, placeholder) ?? Promise.resolve(undefined),
			select: (title, options) => currentUi?.select?.(title, options) ?? Promise.resolve(undefined),
		},
	});

	pi.registerCommand("mcp", {
		description:
			"MCP (mcp bridge): list, reconnect, login, logout, tools, prompts, resources, events, task, enable/disable, exposure",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const name = rest[0];
			const json = (value: unknown) => ctx.ui.notify(JSON.stringify(value, null, 2), "info");
			const fail = (err: unknown) => ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			try {
				switch (sub) {
					case undefined:
					case "list":
						ctx.ui.notify(bridge.statusLines(overriddenNotices).join("\n"), "info");
						return;
					case "reconnect":
					case "login":
					case "logout": {
						if (!name) return fail(`usage: /mcp ${sub} <name>`);
						const state =
							sub === "login"
								? await bridge.login(name)
								: sub === "logout"
									? await bridge.logout(name)
									: await bridge.reconnect(name);
						ctx.ui.notify(
							state.status === "connected"
								? `mcp "${state.name}": connected, ${state.toolCount} tools`
								: `mcp "${state.name}": ${state.error ?? "failed"}`,
							state.status === "connected" ? "info" : "error",
						);
						return;
					}
					case "tools": {
						if (!name) return fail("usage: /mcp tools <name>");
						const state = bridge.get(name);
						if (!state) return fail(`unknown server: ${name}`);
						return json([...state.registeredTools]);
					}
					case "events": {
						if (!name) return fail("usage: /mcp events <name>");
						return json(bridge.eventsStatus(name));
					}
					case "prompts":
						if (!name) return fail("usage: /mcp prompts <name>");
						return json(await bridge.promptsList(name));
					case "prompt": {
						if (!name || !rest[1]) return fail("usage: /mcp prompt <name> <prompt> [jsonArgs]");
						const promptArgs = rest[2] ? (JSON.parse(rest[2]) as Record<string, string>) : {};
						return json(await bridge.promptGet(name, rest[1], promptArgs));
					}
					case "resources":
						if (!name) return fail("usage: /mcp resources <name>");
						return json(await bridge.resourcesList(name));
					case "skills":
						if (!name) return fail("usage: /mcp skills <name>");
						return json(await bridge.skillsList(name));
					case "skill":
						if (!name || !rest[1]) return fail("usage: /mcp skill <name> <uri>");
						ctx.ui.notify(await bridge.skillRead(name, rest[1]), "info");
						return;
					case "task": {
						if (!name || !rest[1]) return fail("usage: /mcp task <name> <taskId> [cancel]");
						return json(await bridge.taskState(name, rest[1], rest[2] === "cancel"));
					}
					case "enable":
					case "disable": {
						if (!name) return fail(`usage: /mcp ${sub} <name>`);
						const state = bridge.get(name);
						bridge.setEnabled(name, sub === "enable");
						if (state) {
							persistServerUpdate(
								name,
								state.config.source,
								{ enabled: sub === "enable" },
								{
									homeDir: homedir(),
									cwd: ctx.cwd ?? "",
									...(state.config.hasProjectOverride ? { hasProjectOverride: true } : {}),
								},
							);
						}
						ctx.ui.notify(`mcp "${name}": ${sub}d`, "info");
						return;
					}
					case "exposure": {
						if (!name || !rest[1]) {
							return fail("usage: /mcp exposure <name> <direct|codemode|deferred|hidden> [toolPattern]");
						}
						const value = rest[1] as "direct" | "codemode" | "deferred" | "hidden";
						const state = bridge.get(name);
						bridge.setExposure(name, value, rest[2]);
						if (state && !rest[2]) {
							persistServerUpdate(
								name,
								state.config.source,
								{ exposure: value },
								{
									homeDir: homedir(),
									cwd: ctx.cwd ?? "",
									...(state.config.hasProjectOverride ? { hasProjectOverride: true } : {}),
								},
							);
						}
						ctx.ui.notify(
							`mcp "${name}": exposure ${value}${rest[2] ? ` for ${rest[2]} (session only)` : ""}`,
							"info",
						);
						return;
					}
					default:
						ctx.ui.notify(
							"Usage: /mcp [list] | reconnect|login|logout <name> | tools|events|prompts|resources <name> | prompt <name> <prompt> [jsonArgs] | task <name> <taskId> [cancel] | enable|disable <name> | exposure <name> <value> [toolPattern]",
							"info",
						);
				}
			} catch (err) {
				fail(err);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		currentUi = ctx.ui;
		currentModelRegistry = ctx.modelRegistry;
		waitedForStartup = false;
		await bridge.closeAll();

		const loaded = loadServerConfigs({
			homeDir: homedir(),
			cwd: ctx.cwd,
			projectTrusted: safeTrusted(ctx),
			registered: registeredServersOf(pi.getMcpServers()),
		});
		fileOnlyConfigs = loaded.fileServers;
		overriddenNotices = loaded.overriddenExtensions.map((line) => `overridden: ${line}`);
		bridge.setAutoEnableCodemode(loaded.autoEnableCodemode);
		for (const warning of loaded.warnings) ctx.ui.notify(`mcp: ${warning}`, "warning");
		bridge.sync(loaded.servers);
	});

	pi.on("mcp_servers_change", async (event, ctx) => {
		currentUi = ctx.ui;
		currentModelRegistry = ctx.modelRegistry;
		const merged = new Map<string, ResolvedServerConfig>(fileOnlyConfigs);
		const seenFileKeys = new Set([...fileOnlyConfigs.keys()].map(serverKey));
		const nextOverridden: string[] = [];

		for (const [name, raw] of registeredServersOf(event.servers)) {
			if (seenFileKeys.has(serverKey(name))) {
				nextOverridden.push(`overridden: "${name}" registered by extension is overridden by mcp.json`);
				continue;
			}
			const { servers, warnings } = loadServerConfigs({
				homeDir: homedir(),
				cwd: ctx.cwd,
				projectTrusted: false,
				registered: new Map([[name, raw]]),
				// Prevent reading user mcp.json again during isolated single-entry parse
				env: { ...(process.env as Record<string, string | undefined>), PI_CODING_AGENT_DIR: join(ctx.cwd, ".__pi_mcp_empty__") },
			});
			for (const warning of warnings) ctx.ui.notify(`mcp: ${warning}`, "warning");
			const cfg = servers.get(name);
			if (cfg) merged.set(name, cfg);
		}
		overriddenNotices = nextOverridden;
		bridge.sync(merged);
	});

	pi.on("turn_start", async (_event, _ctx) => {
		await bridge.reconnectIfSignedInExternally();
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		currentUi = ctx.ui;
		await bridge.closeAll();
		fileOnlyConfigs = new Map();
		overriddenNotices = [];
		waitedForStartup = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!waitedForStartup) {
			waitedForStartup = true;
			const finished = await bridge.waitForPending((s) => hasDirectTools(s));
			if (!finished) {
				ctx.ui.notify(
					"MCP servers are still connecting; their tools become available once connected.",
					"info",
				);
			}
		}

		const sections = event.systemPromptOptions?.sections;
		if (!sections) return;
		const states = bridge.list();
		const rendered = renderServersSection(states);
		if (rendered !== undefined) sections[MCP_SERVERS_SECTION] = rendered;
		else delete sections[MCP_SERVERS_SECTION];
		const skillsRendered = renderMcpSkillsSection(states);
		if (skillsRendered !== undefined) sections[MCP_SKILLS_SECTION] = skillsRendered;
		else delete sections[MCP_SKILLS_SECTION];
	});

	pi.on("tool_call", async (event, _ctx) => {
		const tool = pi.getAllTools().find((t) => t.name === event.toolName);
		if (tool?.reachesTools) {
			const reach = tool.reachesTools(event.input);
			await bridge.waitForPending((s) => reachesServer(reach, s.name));
			return;
		}
		if (event.toolName === "codemode" || event.toolName === "tool_search" || META_TOOL_SET.has(event.toolName)) {
			await bridge.waitForPending();
			return;
		}
		if (event.toolName.startsWith("mcp__")) {
			const owner = bridge.ownerOfTool(event.toolName);
			if (owner !== undefined) {
				await bridge.waitForPending((s) => s.name === owner);
			} else {
				// Tool called before its server finished initial registration: match prefix mcp__<srv>__
				await bridge.waitForPending((s) => event.toolName.startsWith(`mcp__${sanitizeNamePart(s.name)}__`));
			}
		}
	});
}

function safeTrusted(ctx: SessionContext): boolean {
	try {
		return ctx.isProjectTrusted();
	} catch {
		return false;
	}
}
