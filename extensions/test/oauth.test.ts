import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpBridge } from "../bridge.ts";
import type { ResolvedServerConfig } from "../config.ts";
import { FileCredentialStore } from "../oauth.ts";
import type { ExtensionAPI, ToolDefinition } from "../pi-api.ts";
// @ts-expect-error plain-JS fixture
import { startOAuthMcpServer } from "./fixtures/oauth-server.mjs";

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

describe("FileCredentialStore", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("round-trips and persists across instances", async () => {
		dir = mkdtempSync(join(tmpdir(), "mcp-ext-oauth-"));
		const path = join(dir, "auth.json");
		const a = new FileCredentialStore(path);
		await a.set("k1", "v1");
		expect(await a.get("k1")).toBe("v1");
		const b = new FileCredentialStore(path);
		expect(await b.get("k1")).toBe("v1");
		await b.delete("k1");
		expect(await new FileCredentialStore(path).get("k1")).toBeUndefined();
	});

	it("deleteResource removes only matching keys", async () => {
		dir = mkdtempSync(join(tmpdir(), "mcp-ext-oauth-"));
		const s = new FileCredentialStore(join(dir, "auth.json"));
		await s.set('["refresh","https://a.test/mcp","issuer","cid"]', "t");
		await s.set('["refresh","https://b.test/mcp","issuer","cid"]', "t");
		expect(await s.deleteResource("https://a.test/mcp")).toBe(1);
		expect((await s.get('["refresh","https://b.test/mcp","issuer","cid"]')) !== undefined).toBe(true);
	});
});

describe("McpBridge OAuth flow", () => {
	let server: { url: string; issuer: string; calls: string[]; close(): Promise<void> } | undefined;
	let bridge: McpBridge | undefined;
	let dir: string;

	afterEach(async () => {
		await bridge?.closeAll();
		bridge = undefined;
		await server?.close();
		server = undefined;
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	function httpConfig(url: string): ResolvedServerConfig {
		return {
			name: "secure",
			source: "user",
			kind: "http",
			url,
			enabled: true,
			exposure: "direct",
			timeoutMs: 20_000,
			wantsOAuth: true,
			oauth: { clientId: "test-client" },
		};
	}

	it(
		"marks auth-required servers, completes sign-in via browser redirect, and logs out",
		async () => {
			server = await startOAuthMcpServer();
			const srv = server!;
			dir = mkdtempSync(join(tmpdir(), "mcp-ext-oauth-"));
			const { pi, tools } = fakePi();
			const browserOpen = async (url: string) => {
				// Stand in for the user: follow the authorize redirect to the loopback callback.
				const res = await fetch(url, { redirect: "manual" });
				const location = res.headers.get("location");
				if (!location) throw new Error("authorize did not redirect");
				await fetch(location);
			};
			bridge = new McpBridge({
				pi,
				notify: () => {},
				credentialStorePath: join(dir, "auth.json"),
				confirm: async () => true,
				browserOpen,
				allowInsecureAuth: true,
			});

			// Background connect without arming login: consent declines, server marked as needing sign-in.
			bridge.sync(new Map([["secure", httpConfig(srv.url)]]));
			await bridge.waitForPending();
			expect(bridge.get("secure")?.status).toBe("error");
			expect(bridge.get("secure")?.authRequired).toBe(true);
			expect(bridge.statusLines().join("\n")).toContain("needs sign-in");

			// /mcp login arms the consent gate: full authorization-code + PKCE flow runs.
			const state = await bridge.login("secure");
			expect(state.status).toBe("connected");
			expect(state.toolCount).toBe(1);
			expect(srv.calls.some((c: string) => c === "GET /authorize")).toBe(true);
			expect(srv.calls.some((c: string) => c === "POST /token")).toBe(true);

			// The grant works for tool calls.
			const echo = tools.get("mcp__secure__echo");
			const result = await echo?.execute("c1", { message: "authed" }, undefined, undefined, {});
			expect(result?.content).toEqual([{ type: "text", text: "authed" }]);

			// Credentials persisted (refresh token stored, issuer-keyed).
			const stored = readFileSync(join(dir, "auth.json"), "utf8");
			expect(stored).toContain("refresh");

			// Logout clears credentials; the next connect needs sign-in again.
			await bridge.logout("secure");
			expect(bridge.get("secure")?.authRequired).toBe(true);
		},
		30_000,
	);

	it(
		"honors callbackPort and scope config",
		async () => {
			server = await startOAuthMcpServer();
			dir = mkdtempSync(join(tmpdir(), "mcp-ext-oauth-"));
			const { pi } = fakePi();
			let authorizeScope: string | null = null;
			const browserOpen = async (url: string) => {
				const u = new URL(url);
				authorizeScope = u.searchParams.get("scope");
				// Fixed callback: the redirect must target the configured port.
				expect(u.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:18765/callback");
				const res = await fetch(url, { redirect: "manual" });
				await fetch(res.headers.get("location") as string);
			};
			bridge = new McpBridge({
				pi,
				notify: () => {},
				credentialStorePath: join(dir, "auth.json"),
				confirm: async () => true,
				browserOpen,
				allowInsecureAuth: true,
			});
			const cfg = {
				...httpConfig(server!.url),
				oauth: { clientId: "test-client", callbackPort: 18765, scope: "read write" },
			};
			bridge.sync(new Map([["secure", cfg]]));
			await bridge.waitForPending();
			const state = await bridge.login("secure");
			expect(state.status).toBe("connected");
			expect(authorizeScope).toContain("read");
			expect(authorizeScope).toContain("write");
		},
		30_000,
	);

	it(
		"honors authServerMetadataUrl (skips PRM discovery)",
		async () => {
			server = await startOAuthMcpServer();
			dir = mkdtempSync(join(tmpdir(), "mcp-ext-oauth-"));
			const { pi } = fakePi();
			const browserOpen = async (url: string) => {
				const res = await fetch(url, { redirect: "manual" });
				await fetch(res.headers.get("location") as string);
			};
			bridge = new McpBridge({
				pi,
				notify: () => {},
				credentialStorePath: join(dir, "auth.json"),
				confirm: async () => true,
				browserOpen,
				allowInsecureAuth: true,
			});
			const cfg = {
				...httpConfig(server!.url),
				oauth: {
					clientId: "test-client",
					authServerMetadataUrl: `${server!.issuer}/.well-known/oauth-authorization-server`,
				},
			};
			bridge.sync(new Map([["secure", cfg]]));
			await bridge.waitForPending();
			const state = await bridge.login("secure");
			expect(state.status).toBe("connected");
			expect(server!.calls.some((c: string) => c.includes("oauth-protected-resource"))).toBe(false);
		},
		30_000,
	);
});
