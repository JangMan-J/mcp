/**
 * Pi extension entry: replaces Pi's built-in MCP session support with a
 * bridge implemented on this library (@jangmanj/mcp).
 *
 * Registering the /mcp command is what makes Pi stand down its built-in MCP
 * extension for sessions (docs/mcp.md#replace-the-built-in-mcp-support), so
 * this extension reads mcp.json itself and owns all connections.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { McpBridge } from "./bridge.ts";
import { agentDir, loadServerConfigs, persistServerUpdate, type ResolvedServerConfig } from "./config.ts";
import type { ExtensionAPI, McpServerEntry, SessionContext, Ui } from "./pi-api.ts";

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

export default function (pi: ExtensionAPI) {
	// Bridge notifications go to the most recent session context's UI.
	let currentUi: Ui | undefined;
	const bridge = new McpBridge({
		pi,
		notify: (message, level) => currentUi?.notify(message, level),
		credentialStorePath: join(agentDir(process.env, homedir()), "mcp-oauth.json"),
		diagnosticsLogPath: join(agentDir(process.env, homedir()), "mcp.log"),
		confirm: (title, message) => currentUi?.confirm?.(title, message) ?? Promise.resolve(false),
		ui: {
			notify: (message, level) => currentUi?.notify(message, level),
			confirm: (title, message) => currentUi?.confirm?.(title, message) ?? Promise.resolve(false),
			input: (title, placeholder) => currentUi?.input?.(title, placeholder) ?? Promise.resolve(undefined),
			select: (title, options) => currentUi?.select?.(title, options) ?? Promise.resolve(undefined),
		},
	});

	// Registering /mcp replaces built-in MCP support for sessions.
	pi.registerCommand("mcp", {
		description: "MCP (mcp bridge): list, reconnect, login, logout, tools, prompts, resources, task, enable/disable, exposure",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const name = rest[0];
			const json = (value: unknown) => ctx.ui.notify(JSON.stringify(value, null, 2), "info");
			const fail = (err: unknown) => ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
			try {
				switch (sub) {
					case undefined:
					case "list":
						ctx.ui.notify(bridge.statusLines().join("\n"), "info");
						return;
					case "reconnect":
					case "login":
					case "logout": {
						if (!name) return fail(`usage: /mcp ${sub} <name>`);
						const state = sub === "login" ? await bridge.login(name) : sub === "logout" ? await bridge.logout(name) : await bridge.reconnect(name);
						ctx.ui.notify(
							state.status === "connected" ? `mcp "${state.name}": connected, ${state.toolCount} tools` : `mcp "${state.name}": ${state.error ?? "failed"}`,
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
					case "task": {
						if (!name || !rest[1]) return fail("usage: /mcp task <name> <taskId> [cancel]");
						return json(await bridge.taskState(name, rest[1], rest[2] === "cancel"));
					}
					case "enable":
					case "disable": {
						if (!name) return fail(`usage: /mcp ${sub} <name>`);
						bridge.setEnabled(name, sub === "enable");
						const state = bridge.get(name);
						if (state) persistServerUpdate(name, state.config.source, { enabled: sub === "enable" }, { homeDir: homedir(), cwd: ctx.cwd ?? "" });
						ctx.ui.notify(`mcp "${name}": ${sub}d`, "info");
						return;
					}
					case "exposure": {
						if (!name || !rest[1]) return fail("usage: /mcp exposure <name> <direct|codemode|deferred|hidden> [toolPattern]");
						const value = rest[1] as "direct" | "codemode" | "deferred" | "hidden";
						bridge.setExposure(name, value, rest[2]);
						const state = bridge.get(name);
						if (state && !rest[2]) persistServerUpdate(name, state.config.source, { exposure: value }, { homeDir: homedir(), cwd: ctx.cwd ?? "" });
						ctx.ui.notify(`mcp "${name}": exposure ${value}${rest[2] ? ` for ${rest[2]}` : ""}${rest[2] ? " (session only)" : ""}`, "info");
						return;
					}
					default:
						ctx.ui.notify("Usage: /mcp [list] | reconnect|login|logout <name> | tools|prompts|resources <name> | prompt <name> <prompt> [jsonArgs] | task <name> <taskId> [cancel] | enable|disable <name> | exposure <name> <value> [toolPattern]", "info");
				}
			} catch (err) {
				fail(err);
			}
		},
	});

	let fileConfigs = new Map<string, ResolvedServerConfig>();

	const loadAndSync = (ctx: SessionContext) => {
		const { servers, warnings } = loadServerConfigs({
			homeDir: homedir(),
			cwd: ctx.cwd,
			projectTrusted: safeTrusted(ctx),
			registered: registeredServersOf(pi.getMcpServers()),
		});
		fileConfigs = servers;
		for (const warning of warnings) ctx.ui.notify(`mcp: ${warning}`, "warning");
		bridge.sync(servers);
	};

	pi.on("session_start", async (_event, ctx) => {
		currentUi = ctx.ui;
		loadAndSync(ctx);
	});

	pi.on("mcp_servers_change", async (event, ctx) => {
		currentUi = ctx.ui;		const merged = new Map(fileConfigs);
		for (const [name, raw] of registeredServersOf(event.servers)) {
			if (!merged.has(name)) {
				const { servers } = loadServerConfigs({
					homeDir: homedir(),
					cwd: ctx.cwd,
					projectTrusted: false,
					registered: new Map([[name, raw]]),
				});
				const cfg = servers.get(name);
				if (cfg) merged.set(name, cfg);
			}
		}
		bridge.sync(merged);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		currentUi = ctx.ui;
		await bridge.closeAll();
		fileConfigs = new Map();
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		// Direct-exposure tools must be declared in the first request: wait for
		// those servers, bounded, like built-in MCP does.
		await bridge.waitForPending((s) => s.config.exposure === "direct");

		const sections = event.systemPromptOptions?.sections;
		if (!sections) return;
		const lines = bridge
			.list()
			.filter((s) => s.config.enabled && s.config.exposure !== "direct" && s.config.exposure !== "hidden")
			.map((s) => {
				const reach = s.config.exposure === "deferred" ? "tool_search" : "codemode";
				const desc = s.description ?? "MCP server";
				return `- mcp__${s.name.replace(/-/g, "_")}: ${desc} (tools reachable via ${reach})`;
			});
		if (lines.length > 0) sections.mcp_servers = lines.join("\n");
	});

	pi.on("tool_call", async (event, _ctx) => {
		// Late registration: finish connecting servers before codemode /
		// tool_search / direct mcp__* calls run.
		if (
			event.toolName === "codemode" ||
			event.toolName === "tool_search" ||
			event.toolName.startsWith("mcp__")
		) {
			await bridge.waitForPending();
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
