import { describe, expect, it } from "vitest";
import { connect } from "@mcp/client";
import { InMemoryTransport } from "@mcp/testing";
import { McpServer } from "../src/server.js";

describe("McpServer <-> client interop", () => {
	it("serves tools, resources, and prompts to the real client ops", async () => {
		const server = new McpServer({ serverInfo: { name: "interop", version: "1" } });
		server.registerTool({
			name: "echo",
			inputSchema: { type: "object", properties: { message: { type: "string" } } },
			handler: (args) => ({ content: [{ type: "text", text: String((args as { message: string }).message) }] }),
		});
		server.registerResource({ uri: "file:///a", name: "a", handler: () => "A" });
		server.registerPrompt({ name: "p", handler: () => ({ messages: [] }) });
		const connection = await connect({ transport: new InMemoryTransport((msg) => server.handleRequest(msg)) });
		try {
			const tools = await connection.tools.list();
			expect(tools.map((t) => t.name)).toEqual(["echo"]);
			const called = await connection.tools.call("echo", { message: "roundtrip" });
			expect(called.content[0]?.raw).toEqual({ type: "text", text: "roundtrip" });

			const resources = await connection.ops.resources.listAll();
			expect(resources.kind).toBe("ok");
			const read = await connection.ops.resources.read("file:///a");
			expect(read.kind).toBe("ok");
			const prompts = await connection.ops.prompts.listAll();
			expect(prompts.kind).toBe("ok");
			const got = await connection.ops.prompts.get("p");
			expect(got.kind).toBe("ok");
		} finally {
			await connection.close();
		}
	});
});
