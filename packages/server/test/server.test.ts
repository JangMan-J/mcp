import { describe, expect, it } from "vitest";
import { McpServer } from "../src/server.js";
import { inputRequired, issueRequestState, MrtrRegistry, verifyRequestState } from "../src/mrtr.js";
import { ServerError } from "@mcp-client/server-events";

function server(): McpServer {
	const s = new McpServer({
		serverInfo: { name: "test", version: "1.0.0" },
		instructions: "Test server.",
		cache: { ttlMs: 1000, cacheScope: "public" },
		pageSize: 1,
		onComplete: () => ({ values: Array.from({ length: 120 }, (_, i) => `v${i}`), total: 120 }),
	});
	s.registerTool({
		name: "echo",
		description: "Echo",
		inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
		outputSchema: { type: "object", properties: { echo: { type: "string" } } },
		handler: (args) => ({
			content: [{ type: "text", text: String((args as { message: string }).message) }],
			structuredContent: { echo: (args as { message: string }).message },
		}),
	});
	s.registerTool({ name: "fail", handler: () => { throw new Error("boom"); } });
	s.registerResource({ uri: "file:///a.txt", name: "a", mimeType: "text/plain", handler: () => "contents" });
	s.registerResourceTemplate({
		uriTemplate: "file:///users/{id}",
		name: "user",
		handler: (uri, vars) => ({ text: `user ${vars.id}`, mimeType: "text/plain" }),
	});
	s.registerPrompt({
		name: "greet",
		arguments: [{ name: "who", required: true }],
		handler: (args) => ({ messages: [{ role: "user", content: { type: "text", text: `hi ${args.who}` } }] }),
	});
	return s;
}

function req(method: string, params: Record<string, unknown> = {}) {
	return {
		jsonrpc: "2.0" as const,
		id: 1,
		method,
		params: {
			...params,
			_meta: {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
			},
		},
	};
}

describe("McpServer", () => {
	it("discovers capabilities and cache hints", () => {
		const result = server().discover();
		expect(result.resultType).toBe("complete");
		expect(result.ttlMs).toBe(1000);
		expect(result.cacheScope).toBe("public");
		expect(result.capabilities).toMatchObject({ tools: {}, resources: {}, prompts: {}, completions: {} });
	});

	it("rejects missing metadata and unsupported versions", async () => {
		await expect(server().handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toMatchObject({ code: -32602 });
		await expect(server().handleRequest({
			jsonrpc: "2.0", id: 1, method: "tools/list",
			params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25", "io.modelcontextprotocol/clientCapabilities": {} } },
		})).rejects.toMatchObject({ code: -32022 });
	});

	it("lists tools deterministically with pagination and validates calls", async () => {
		const s = server();
		const page1 = await s.handleRequest(req("tools/list"));
		expect(page1.tools).toHaveLength(1);
		expect(page1.nextCursor).toBe("1");
		const page2 = await s.handleRequest(req("tools/list", { cursor: "1" }));
		expect(page2.nextCursor).toBeUndefined();
		await expect(s.handleRequest(req("tools/list", { cursor: "bogus" }))).rejects.toMatchObject({ code: -32602 });

		const called = await s.handleRequest(req("tools/call", { name: "echo", arguments: { message: "hi" } }));
		expect(called.structuredContent).toEqual({ echo: "hi" });
		await expect(s.handleRequest(req("tools/call", { name: "echo", arguments: {} }))).rejects.toMatchObject({ code: -32602 });
		const failed = await s.handleRequest(req("tools/call", { name: "fail" }));
		expect(failed.isError).toBe(true);
		expect(failed.resultType).toBe("complete");
	});

	it("reads exact and templated resources, with -32602 for missing", async () => {
		const s = server();
		const exact = await s.handleRequest(req("resources/read", { uri: "file:///a.txt" }));
		expect(exact.contents).toEqual([{ uri: "file:///a.txt", text: "contents", mimeType: "text/plain" }]);
		const templated = await s.handleRequest(req("resources/read", { uri: "file:///users/42" }));
		expect(templated.contents).toEqual([{ uri: "file:///users/42", text: "user 42", mimeType: "text/plain" }]);
		await expect(s.handleRequest(req("resources/read", { uri: "file:///none" }))).rejects.toMatchObject({ code: -32602 });
	});

	it("gets prompts and caps completion values", async () => {
		const s = server();
		const prompt = await s.handleRequest(req("prompts/get", { name: "greet", arguments: { who: "jang" } }));
		expect(prompt.messages).toHaveLength(1);
		await expect(s.handleRequest(req("prompts/get", { name: "greet" }))).rejects.toMatchObject({ code: -32602 });
		const completion = await s.handleRequest(req("completion/complete", {
			ref: { type: "ref/prompt", name: "greet" },
			argument: { name: "who", value: "j" },
		}));
		expect((completion.completion as { values: string[] }).values).toHaveLength(100);
		expect((completion.completion as { hasMore?: boolean }).hasMore).toBe(true);
	});

	it("correlates MRTR retries and consumes single-use state", () => {
		const registry = new MrtrRegistry("secret");
		const interim = registry.begin("tools/call", {
			inputRequests: { q: { method: "elicitation/create", params: { message: "?" } } },
			payload: { attempt: 1 },
		});
		expect(interim.resultType).toBe("input_required");
		const requestState = interim.requestState as string;
		const retry = registry.resume("tools/call", { requestState });
		expect(retry.retry?.resultType).toBe("input_required");
		const resumed = registry.resume("tools/call", { requestState, inputResponses: { q: { answer: 1 } } });
		expect(resumed.payload).toEqual({ attempt: 1 });
		expect(resumed.inputResponses).toEqual({ q: { answer: 1 } });
		expect(() => registry.resume("tools/call", { requestState, inputResponses: { q: { answer: 1 } } })).toThrow(ServerError);
	});

	it("provides MRTR interim results and integrity-protected requestState", () => {
		expect(inputRequired({ requestState: "x" }).resultType).toBe("input_required");
		const state = issueRequestState("secret", "tools/call", { attempt: 1 });
		expect(verifyRequestState("secret", state, "tools/call")).toEqual({ attempt: 1 });
		expect(() => verifyRequestState("secret", state, "tools/list")).toThrow(ServerError);
		expect(() => verifyRequestState("wrong", state, "tools/call")).toThrow(ServerError);
	});
});
