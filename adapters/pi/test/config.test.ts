import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agentDir,
	expandTilde,
	interpolate,
	loadServerConfigs,
	normalizeExposure,
	serverKey,
} from "../config.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mcp-ext-config-"));
	mkdirSync(join(dir, "home", ".pi", "agent"), { recursive: true });
	mkdirSync(join(dir, "proj", ".pi"), { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const homeDir = () => join(dir, "home");
const cwd = () => join(dir, "proj");

function writeUser(json: unknown) {
	writeFileSync(join(homeDir(), ".pi", "agent", "mcp.json"), JSON.stringify(json));
}
function writeProject(json: unknown) {
	writeFileSync(join(cwd(), ".pi", "mcp.json"), JSON.stringify(json));
}

const baseOpts = () => ({
	homeDir: homeDir(),
	cwd: cwd(),
	projectTrusted: true,
	env: {} as Record<string, string>,
	exec: () => "EXECUTED",
});

describe("agentDir", () => {
	it("honors PI_CODING_AGENT_DIR and falls back to ~/.pi/agent", () => {
		expect(agentDir({ PI_CODING_AGENT_DIR: "/x" }, "/h")).toBe("/x");
		expect(agentDir({}, "/h")).toBe(join("/h", ".pi", "agent"));
	});
});

describe("normalizeExposure / serverKey", () => {
	it("maps codemode-deferred to codemode and defaults unknown values", () => {
		expect(normalizeExposure("codemode-deferred")).toBe("codemode");
		expect(normalizeExposure("direct")).toBe("direct");
		expect(normalizeExposure(undefined)).toBe("codemode");
		expect(normalizeExposure("bogus")).toBe("codemode");
	});
	it("treats - and _ as equivalent", () => {
		expect(serverKey("my-server")).toBe(serverKey("my_server"));
	});
});

describe("interpolate", () => {
	it("expands ${VAR}", () => {
		const warnings: string[] = [];
		expect(interpolate("Bearer ${TOKEN}", { TOKEN: "abc" }, () => "", warnings, "x")).toBe(
			"Bearer abc",
		);
		expect(warnings).toEqual([]);
	});
	it("warns and empties missing vars", () => {
		const warnings: string[] = [];
		expect(interpolate("${MISSING}", {}, () => "", warnings, "x")).toBe("");
		expect(warnings).toHaveLength(1);
	});
	it("runs !command whole-values", () => {
		const warnings: string[] = [];
		expect(interpolate("!echo hi", {}, (cmd) => `ran:${cmd}`, warnings, "x")).toBe("ran:echo hi");
	});
	it("warns on command failure", () => {
		const warnings: string[] = [];
		expect(
			interpolate("!false", {}, () => {
				throw new Error("exit 1");
			}, warnings, "x"),
		).toBe("");
		expect(warnings[0]).toContain("exit 1");
	});
});

describe("expandTilde", () => {
	it("expands leading ~/ only", () => {
		expect(expandTilde("~/bin/x", "/h")).toBe(join("/h", "bin/x"));
		expect(expandTilde("/a/~", "/h")).toBe("/a/~");
	});
});

describe("loadServerConfigs", () => {
	it("returns empty when no files exist", () => {
		const { servers, warnings } = loadServerConfigs(baseOpts());
		expect(servers.size).toBe(0);
		expect(warnings).toEqual([]);
	});

	it("loads a stdio server and interpolates env", () => {
		writeUser({
			mcpServers: {
				fs: { command: "npx", args: ["-y", "srv"], env: { KEY: "${MY_KEY}" } },
			},
		});
		const { servers, warnings } = loadServerConfigs({
			...baseOpts(),
			env: { MY_KEY: "v1" },
		});
		const fs = servers.get("fs");
		expect(fs?.kind).toBe("stdio");
		expect(fs?.env).toEqual({ KEY: "v1" });
		expect(fs?.exposure).toBe("codemode");
		expect(fs?.timeoutMs).toBe(60_000);
		expect(warnings).toEqual([]);
	});

	it("rejects invalid entries without killing others", () => {
		writeUser({
			mcpServers: {
				"bad name": { command: "x" },
				sseServer: { type: "sse", url: "http://x" },
				good: { url: "https://example.com/mcp" },
			},
		});
		const { servers, warnings } = loadServerConfigs(baseOpts());
		expect([...servers.keys()]).toEqual(["good"]);
		expect(warnings).toHaveLength(2);
	});

	it("project entry replaces user entry; partial override only patches", () => {
		writeUser({
			mcpServers: {
				tools: { command: "uvx", args: ["tools-mcp"], env: { A: "1" } },
			},
		});
		writeProject({ mcpServers: { tools: { enabled: false, exposure: "direct" } } });
		const { servers } = loadServerConfigs(baseOpts());
		const t = servers.get("tools");
		expect(t?.enabled).toBe(false);
		expect(t?.exposure).toBe("direct");
		expect(t?.command).toBe("uvx"); // kept from user entry
		expect(t?.env).toEqual({ A: "1" });
	});

	it("skips project file when project is not trusted", () => {
		writeProject({ mcpServers: { p: { command: "x" } } });
		const { servers } = loadServerConfigs({ ...baseOpts(), projectTrusted: false });
		expect(servers.size).toBe(0);
	});

	it("file config wins over extension-registered servers", () => {
		writeUser({ mcpServers: { s: { command: "from-file" } } });
		const { servers } = loadServerConfigs({
			...baseOpts(),
			registered: new Map([["s", { command: "from-extension" }]]),
		});
		expect(servers.get("s")?.command).toBe("from-file");
		expect(servers.get("s")?.source).toBe("user");
	});

	it("rejects -/_ name conflicts", () => {
		writeUser({
			mcpServers: {
				"my-server": { command: "a" },
				my_server: { command: "b" },
			},
		});
		const { servers, warnings } = loadServerConfigs(baseOpts());
		expect(servers.size).toBe(1);
		expect(warnings.some((w) => w.includes("conflict"))).toBe(true);
	});

	it("warns when oauth is set (still resolves the entry)", () => {
		writeUser({
			mcpServers: { remote: { url: "https://x/mcp", oauth: { clientId: "c" } } },
		});
		const { servers } = loadServerConfigs(baseOpts());
		expect(servers.get("remote")?.wantsOAuth).toBe(true);
	});
});
