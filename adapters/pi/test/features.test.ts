import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpBridge } from "../bridge.ts";
import type { ResolvedServerConfig } from "../config.ts";
import type { ExtensionAPI, ToolDefinition } from "../pi-api.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "feature-server.mjs");

function fakePi() {
	const tools = new Map<string, ToolDefinition>();
	let active: string[] = [];
	const pi: ExtensionAPI = {
		on() {},
		registerTool(def) {
			tools.set(def.name, def);
		},
		registerCommand() {},
		getActiveTools: () => active,
		setActiveTools: (names) => {
			active = names;
		},
		getAllTools: () => [...tools.keys()].map((name) => ({ name })),
		getMcpServers: () => new Map(),
	};
	return { pi, tools };
}

function config(): ResolvedServerConfig {
	return {
		name: "fake",
		source: "user",
		kind: "stdio",
		command: process.execPath,
		args: [fixture],
		enabled: true,
		exposure: "direct",
		timeoutMs: 15_000,
		wantsOAuth: false,
	};
}

describe("Pi built-in MCP parity features", () => {
	let bridge: McpBridge | undefined;

	afterEach(async () => {
		await bridge?.closeAll();
		bridge = undefined;
	});

	async function start() {
		const { pi, tools } = fakePi();
		bridge = new McpBridge({
			pi,
			notify: () => {},
			ui: {
				notify: () => {},
				confirm: async () => true,
				input: async () => "Jang",
				select: async (options) => options[0],
			},
		});
		bridge.sync(new Map([["fake", config()]]));
		await bridge.waitForPending();
		expect(bridge.get("fake")?.status).toBe("connected");
		return { pi, tools };
	}

	it("registers resource tools and reads resources", async () => {
		const { tools } = await start();
		expect(tools.has("list_mcp_resources")).toBe(true);
		expect(tools.has("list_mcp_resource_templates")).toBe(true);
		expect(tools.has("read_mcp_resource")).toBe(true);
		const list = await tools.get("list_mcp_resources")!.execute("1", {}, undefined, undefined, {});
		expect(JSON.stringify(list.content)).toContain("file:///a.txt");
		const read = await tools.get("read_mcp_resource")!.execute("2", { server: "fake", uri: "file:///a.txt" }, undefined, undefined, {});
		expect(read.content).toEqual([{ type: "text", text: "resource text" }]);
	}, 20_000);

	it("registers new tools on list_changed", async () => {
		const { tools } = await start();
		for (let i = 0; i < 50 && !tools.has("mcp__fake__extra"); i++) {
			await new Promise((r) => setTimeout(r, 100));
		}
		expect(tools.has("mcp__fake__extra")).toBe(true);
	}, 20_000);

	it("truncates large text with a temp-file marker", async () => {
		const { tools } = await start();
		const result = await tools.get("mcp__fake__big")!.execute("3", {}, undefined, undefined, {});
		const text = String((result.content[0] as { text?: string }).text);
		expect(text).toContain("chars truncated; full text saved to");
		expect(text.length).toBeLessThan(25_000);
	}, 20_000);

	it("fulfills elicitation through the host UI", async () => {
		const { tools } = await start();
		const result = await tools.get("mcp__fake__ask")!.execute("4", {}, undefined, undefined, {});
		expect(result.content).toEqual([{ type: "text", text: "hello Jang" }]);
	}, 20_000);

	it("returns task handles and supports tasks/get", async () => {
		const { tools } = await start();
		const result = await tools.get("mcp__fake__task")!.execute("5", {}, undefined, undefined, {});
		expect(result.structuredContent).toEqual({ taskId: "t1", status: "working" });
		expect(await bridge!.taskState("fake", "t1")).toMatchObject({ taskId: "t1", status: "completed" });
	}, 20_000);

	it("gets prompts", async () => {
		await start();
		const prompt = await bridge!.promptGet("fake", "greet", { who: "tester" });
		expect(JSON.stringify(prompt)).toContain("hi tester");
	}, 20_000);
});
