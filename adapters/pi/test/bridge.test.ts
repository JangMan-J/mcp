import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assignToolNames, McpBridge, toolExposureFor } from "../bridge.ts";
import type { ResolvedServerConfig } from "../config.ts";
import type { ExtensionAPI, ToolDefinition } from "../pi-api.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-server.mjs");

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

function stdioConfig(overrides: Partial<ResolvedServerConfig> = {}): ResolvedServerConfig {
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
		...overrides,
	};
}

describe("assignToolNames", () => {
	it("sanitizes non-word characters", () => {
		expect(assignToolNames("my-server", ["get.thing/1"]).get("get.thing/1")).toBe(
			"mcp__my_server__get_thing_1",
		);
	});
	it("hash-suffixes every tool in a collision group", () => {
		const names = assignToolNames("s", ["a.b", "a_b"]);
		const a = names.get("a.b") as string;
		const b = names.get("a_b") as string;
		expect(a).not.toBe(b);
		expect(a).toMatch(/^mcp__s__a_b_h[0-9a-f]{8}$/);
		expect(b).toMatch(/^mcp__s__a_b_h[0-9a-f]{8}$/);
	});
});

describe("toolExposureFor", () => {
	const cfg = stdioConfig({
		exposure: "codemode",
		toolExposure: { search_code: "direct", "get_*": "deferred", "delete_*": "hidden" },
	});
	it("exact names win over patterns", () => {
		expect(toolExposureFor(cfg, "search_code")).toBe("direct");
	});
	it("first matching pattern wins", () => {
		expect(toolExposureFor(cfg, "get_thing")).toBe("deferred");
		expect(toolExposureFor(cfg, "delete_all")).toBe("hidden");
	});
	it("falls back to server exposure", () => {
		expect(toolExposureFor(cfg, "other")).toBe("codemode");
	});
});

describe("McpBridge against a real stdio server", () => {
	let bridge: McpBridge | undefined;
	const notes: { message: string; level: string }[] = [];

	afterEach(async () => {
		await bridge?.closeAll();
		bridge = undefined;
		notes.length = 0;
	});

	function makeBridge(pi: ExtensionAPI) {
		bridge = new McpBridge({
			pi,
			notify: (message, level) => notes.push({ message, level }),
		});
		return bridge;
	}

	it(
		"connects, registers sanitized tools, and executes calls",
		async () => {
			const { pi, tools } = fakePi();
			const b = makeBridge(pi);
			b.sync(new Map([["fake", stdioConfig()]]));
			await b.waitForPending();

			const state = b.get("fake");
			expect(state?.status).toBe("connected");
			expect(state?.toolCount).toBe(3);
			expect(state?.description).toBe("Fake test server.");

			const echo = tools.get("mcp__fake__echo");
			expect(echo).toBeDefined();
			expect(echo?.exposure).toBe("direct");
			expect(echo?.annotations).toEqual({ readOnlyHint: true });
			expect(echo?.namespace?.name).toBe("mcp__fake");
			expect(echo?.namespace?.instructions).toContain("Fake test server.");
			expect(tools.get("mcp__fake__weird_name_x")).toBeDefined();

			const result = await echo?.execute("call-1", { message: "hi" }, undefined, undefined, {});
			expect(result?.content).toEqual([{ type: "text", text: "hi" }]);
			expect(result?.structuredContent).toEqual({
				content: [{ type: "text", text: "hi" }],
				structuredContent: { echo: "hi" },
			});

			const fail = tools.get("mcp__fake__fail");
			const failed = await fail?.execute("call-2", {}, undefined, undefined, {});
			expect(failed?.isError).toBe(true);
			expect(failed?.content).toEqual([{ type: "text", text: "boom" }]);
		},
		20_000,
	);

	it(
		"reports spawn failures as error state without throwing",
		async () => {
			const { pi } = fakePi();
			const b = makeBridge(pi);
			b.sync(new Map([["broken", stdioConfig({ name: "broken", command: "definitely-not-a-real-binary-xyz" })]]));
			await b.waitForPending();
			expect(b.get("broken")?.status).toBe("error");
			expect(notes.some((n) => n.level === "error" && n.message.includes("broken"))).toBe(true);
		},
		20_000,
	);

	it(
		"tool calls error clearly when the server is not connected",
		async () => {
			const { pi, tools } = fakePi();
			const b = makeBridge(pi);
			b.sync(new Map([["fake", stdioConfig()]]));
			await b.waitForPending();
			await b.closeAll();
			const echo = tools.get("mcp__fake__echo");
			await expect(echo?.execute("c", { message: "x" }, undefined, undefined, {})).rejects.toThrow(
				/not connected/,
			);
			bridge = undefined; // already closed
		},
		20_000,
	);
});
