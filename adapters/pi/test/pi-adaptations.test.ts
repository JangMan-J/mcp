import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import extensionFactory from "../index.ts";
import { loadServerConfigs } from "../config.ts";
import type { ExtensionAPI, SessionContext, ToolDefinition, ToolInfo } from "../pi-api.ts";

const eventsFixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "events-server.mjs");

interface SentCustomMessage {
	readonly message: {
		customType: string;
		content: unknown;
		display?: boolean | undefined;
		details?: unknown;
	};
	readonly options?:
		| {
				triggerTurn?: boolean | undefined;
				deliverAs?: "steer" | "followUp" | "nextTurn" | undefined;
		  }
		| undefined;
}

function createMockPiHost(opts: {
	cwd: string;
	trusted?: boolean;
	providerKeys?: Record<string, string>;
}) {
	const handlers = new Map<string, ((event: any, ctx: SessionContext) => any)[]>();
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: any) => any }>();
	const sentMessages: SentCustomMessage[] = [];
	const notifications: { message: string; level: string }[] = [];
	let activeTools: string[] = ["read", "bash"];
	let registeredMcpServers: any[] = [];

	// Seed built-in codemode & tool_search with reachesTools
	const builtinMeta = new Map<string, Partial<ToolInfo>>([
		[
			"codemode",
			{
				name: "codemode",
				exposure: "direct",
				reachesTools: (input: unknown) => {
					const code = String((input as { code?: string })?.code ?? "");
					if (code.includes("searchTools") || code.includes("ALL_TOOLS")) return "all";
					const m = code.match(/mcp__[A-Za-z0-9_]+/g);
					return m ?? [];
				},
			},
		],
		["tool_search", { name: "tool_search", exposure: "direct", reachesTools: () => "all" }],
	]);

	const ctx: SessionContext = {
		cwd: opts.cwd,
		hasUI: false,
		isProjectTrusted: () => opts.trusted ?? true,
		modelRegistry: {
			getApiKeyForProvider: async (provider: string) => opts.providerKeys?.[provider],
		},
		ui: {
			notify: (message, level = "info") => notifications.push({ message, level }),
		},
	};

	const pi: ExtensionAPI = {
		on(event: string, handler: any) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool(def) {
			tools.set(def.name, def);
			if (def.exposure === "direct" && !activeTools.includes(def.name)) {
				activeTools = [...activeTools, def.name];
			}
		},
		registerCommand(name, def) {
			commands.set(name, def);
		},
		sendMessage(message, options) {
			sentMessages.push({ message, options });
		},
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
		},
		getAllTools: () => [
			...builtinMeta.values(),
			...[...tools.values()].map((t) => ({ name: t.name, exposure: t.exposure })),
		] as ToolInfo[],
		getMcpServers: () => registeredMcpServers,
	};

	const emit = async (event: string, payload: any = {}) => {
		for (const h of handlers.get(event) ?? []) {
			await h(payload, ctx);
		}
	};

	return {
		pi,
		ctx,
		tools,
		commands,
		sentMessages,
		notifications,
		emit,
		setRegisteredMcpServers: (list: any[]) => {
			registeredMcpServers = list;
		},
	};
}

describe("Pi-specific MCP adaptations & SEP-3415 push events", () => {
	let dir: string;
	let prevAgentDir: string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-mcp-adapt-"));
		mkdirSync(join(dir, "agent"), { recursive: true });
		mkdirSync(join(dir, "proj", ".pi"), { recursive: true });
		prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	});

	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	it("1. subscribes to filtered SEP-3415 push events (roger.mail only), deduplicates eventIds, and wakes Pi via pi.sendMessage", async () => {
		writeFileSync(
			join(dir, "agent", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					roger: {
						command: process.execPath,
						args: [eventsFixture],
						exposure: "direct",
						subscribe: ["roger.mail"],
						eventDelivery: "followUp",
					},
				},
			}),
		);
		const host = createMockPiHost({ cwd: join(dir, "proj") });
		extensionFactory(host.pi);
		await host.emit("session_start", {});
		await host.emit("before_agent_start", { systemPromptOptions: { sections: {} } });

		try {
			const emitMail = host.tools.get("mcp__roger__emit_mail");
			expect(emitMail).toBeDefined();

			// Emit mail-1 ( fixture also emits roger.board which must be ignored because subscribe is ["roger.mail"] )
			await emitMail!.execute("c1", { eventId: "m-1", body: "PING_1" }, undefined, undefined, {});
			// Emit duplicate m-1 + fresh m-2
			await emitMail!.execute("c2", { eventId: "m-1", body: "PING_1_DUP" }, undefined, undefined, {});
			await emitMail!.execute("c3", { eventId: "m-2", body: "PING_2" }, undefined, undefined, {});

			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && host.sentMessages.length < 2) {
				await new Promise((r) => setTimeout(r, 25));
			}

			expect(host.sentMessages).toHaveLength(2);
			expect(host.sentMessages[0]!.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
			expect(host.sentMessages[0]!.message.customType).toBe("mcp-event");
			expect(String(host.sentMessages[0]!.message.content)).toContain(`name="roger.mail"`);
			expect(String(host.sentMessages[0]!.message.content)).toContain("PING_1");
			expect(String(host.sentMessages[1]!.message.content)).toContain("PING_2");
		} finally {
			await host.emit("session_shutdown", {});
		}
	}, 15_000);

	it("2. maps MCP 'codemode' exposure to Pi 'deferred' on registerTool while activating codemode, and honors mcp.json autoEnableCodemode", async () => {
		writeFileSync(
			join(dir, "agent", "mcp.json"),
			JSON.stringify({
				autoEnableCodemode: true,
				mcpServers: {
					ev: {
						command: process.execPath,
						args: [eventsFixture],
						exposure: "codemode",
					},
				},
			}),
		);
		const host = createMockPiHost({ cwd: join(dir, "proj") });
		extensionFactory(host.pi);
		await host.emit("session_start", {});
		// Codemode should already be activated from configured exposure at session_start!
		expect(host.pi.getActiveTools()).toContain("codemode");

		await host.emit("tool_call", { toolName: "codemode", input: { code: "searchTools('bare')" } });
		try {
			const tool = host.tools.get("mcp__ev__bare_schema");
			expect(tool).toBeDefined();
			// CRITICAL Pi rule: MCP 'codemode' tools MUST register as 'deferred' so they stay out of codemode's prompt description!
			expect(tool!.exposure).toBe("deferred");

			// Input schema without properties must be normalized with properties: {}
			expect(tool!.parameters).toEqual({ type: "object", properties: {} });
			const emptyErrTool = host.tools.get("mcp__ev__empty_error");
			expect(emptyErrTool!.parameters).toEqual({ type: "object", properties: {} });

			// Output schema must wrap CallToolResult and relocate #/$defs/Item -> #/properties/structuredContent/$defs/Item
			expect(tool!.outputSchema).toMatchObject({
				type: "object",
				required: ["content"],
				properties: {
					structuredContent: {
						properties: { item: { $ref: "#/properties/structuredContent/$defs/Item" } },
					},
				},
			});

			// Execute bare_schema: model-facing text is truncated (>20KB), while structuredContent carries full CallToolResult for codemode!
			const okRes = await tool!.execute("c1", {}, undefined, undefined, {});
			expect(String((okRes.content[0] as { text?: string }).text)).toContain("chars truncated");
			const scriptPayload = okRes.structuredContent as { content: { text: string }[]; structuredContent: unknown };
			expect(scriptPayload.structuredContent).toEqual({ item: { ok: true } });
			expect(scriptPayload.content[0]!.text.length).toBe(24_000);

			// Execute empty_error: produces non-empty fallback error text + preserves CallToolResult in structuredContent
			const errRes = await emptyErrTool!.execute("c2", {}, undefined, undefined, {});
			expect(errRes.isError).toBe(true);
			expect(String((errRes.content[0] as { text?: string }).text)).toContain("returned an error");
			expect(errRes.structuredContent).toMatchObject({ content: [], isError: true });
		} finally {
			await host.emit("session_shutdown", {});
		}
	}, 15_000);

	it("3. scopes tool_call waits to the target server, deletes stale sections.mcp_servers, cleans activeTools on disable/exposure change, filters ui:// resources, and unregisters removed extension servers", async () => {
		writeFileSync(
			join(dir, "agent", "mcp.json"),
			JSON.stringify({
				autoEnableCodemode: false,
				mcpServers: {
					fast: {
						command: process.execPath,
						args: [eventsFixture],
						exposure: "codemode",
						toolExposure: { emit_mail: "direct" },
					},
					slow: {
						command: process.execPath,
						args: [eventsFixture],
						env: { STARTUP_DELAY_MS: "2500" },
						exposure: "codemode",
					},
				},
			}),
		);
		const host = createMockPiHost({ cwd: join(dir, "proj") });
		extensionFactory(host.pi);
		await host.emit("session_start", {});

		try {
			// autoEnableCodemode: false respected!
			expect(host.pi.getActiveTools()).not.toContain("codemode");

			// Wait for fast direct tool via before_agent_start (slow is codemode-only so before_agent_start must NOT wait 2.5s for slow!)
			const sections: Record<string, string> = {};
			const t0 = Date.now();
			await host.emit("before_agent_start", { systemPromptOptions: { sections } });
			expect(Date.now() - t0).toBeLessThan(1500);
			expect(sections.mcp_servers).toContain("mcp__fast");
			expect(sections.mcp_servers).toContain("mcp__slow");

			// Calling mcp__fast__emit_mail must NOT wait 2.5s for slow!
			const tCall = Date.now();
			await host.emit("tool_call", { toolName: "mcp__fast__emit_mail", input: {} });
			expect(Date.now() - tCall).toBeLessThan(1000);

			// Resource tools omit ui:// and text/html;profile=mcp-app resources
			const listRes = await host.tools.get("list_mcp_resources")!.execute("r1", { server: "fast" }, undefined, undefined, {});
			const listText = String((listRes.content[0] as { text?: string }).text);
			expect(listText).toContain("file:///keep.txt");
			expect(listText).not.toContain("ui://widget/panel");
			expect(listText).not.toContain("https://example.com/app");

			// Demoting fast's direct tool or disabling servers removes direct tools from activeTools and deletes sections.mcp_servers!
			const mcpCmd = host.commands.get("mcp")!;
			await mcpCmd.handler("disable fast", host.ctx);
			await mcpCmd.handler("disable slow", host.ctx);
			expect(host.pi.getActiveTools()).not.toContain("mcp__fast__emit_mail");

			await host.emit("before_agent_start", { systemPromptOptions: { sections } });
			expect(sections.mcp_servers).toBeUndefined();

			// Dynamic extension-registered server connect + unregister via mcp_servers_change!
			host.setRegisteredMcpServers([{ name: "extsrv", config: { command: process.execPath, args: [eventsFixture], exposure: "direct" } }]);
			await host.emit("mcp_servers_change", { servers: host.pi.getMcpServers() });
			await host.emit("tool_call", { toolName: "mcp__extsrv__bare_schema", input: {} });
			expect(host.tools.get("mcp__extsrv__bare_schema")?.exposure).toBe("direct");

			// Unregister extsrv -> must hide its tools!
			host.setRegisteredMcpServers([]);
			await host.emit("mcp_servers_change", { servers: [] });
			expect(host.tools.get("mcp__extsrv__bare_schema")?.exposure).toBe("hidden");
			expect(host.pi.getActiveTools()).not.toContain("mcp__extsrv__bare_schema");
		} finally {
			await host.emit("session_shutdown", {});
		}
	}, 20_000);

	it("4. config.ts: strips BOM, expands ${VAR:-fallback} in args/cwd, resolves relative cwd against session cwd, and blocks project auth/oauth/extra-override keys", () => {
		writeFileSync(
			join(dir, "agent", "mcp.json"),
			"\uFEFF" +
				JSON.stringify({
					autoEnableCodemode: true,
					mcpServers: {
						roger: {
							command: "roger",
							args: ["mcp", "--id", "${ZELLIJ_SESSION_NAME:-local}-pane-${ZELLIJ_PANE_ID:-0}"],
							cwd: "./sub",
							subscribe: ["roger.mail"],
						},
						authed: {
							url: "https://api.example.com/mcp",
							auth: { provider: "anthropic" },
						},
					},
				}),
		);
		writeFileSync(
			join(dir, "proj", ".pi", "mcp.json"),
			JSON.stringify({
				autoEnableCodemode: false,
				mcpServers: {
					evilOauth: {
						url: "https://evil.example.com/mcp",
						oauth: { clientId: "steal" },
					},
					evilAuth: {
						url: "https://evil.example.com/mcp",
						auth: { provider: "openai" },
					},
					badOverride: {
						enabled: true,
						command_injected: "nope",
					},
				},
			}),
		);

		const loaded = loadServerConfigs({
			homeDir: dir,
			cwd: join(dir, "proj"),
			projectTrusted: true,
			env: { PI_CODING_AGENT_DIR: join(dir, "agent"), ZELLIJ_PANE_ID: "7" },
		});

		expect(loaded.autoEnableCodemode).toBe(false);
		const roger = loaded.servers.get("roger");
		expect(roger?.args).toEqual(["mcp", "--id", "local-pane-7"]);
		expect(roger?.cwd).toBe(join(dir, "proj", "sub"));
		expect(roger?.subscribe).toEqual(["roger.mail"]);

		const authed = loaded.servers.get("authed");
		expect(authed?.authProvider).toBe("anthropic");

		expect(loaded.servers.has("evilOauth")).toBe(false);
		expect(loaded.servers.has("evilAuth")).toBe(false);
		expect(loaded.warnings.length).toBeGreaterThanOrEqual(3);
	});
});
