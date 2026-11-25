import { describe, expect, it } from "vitest";
import { McpClient } from "@mcp-client/core";
import { createOps } from "@mcp-client/ops";
import { createToolServer } from "../src/index.js";

describe("createToolServer", () => {
	it("serves discover, tools/list, and tools/call", async () => {
		const client = new McpClient({
			transport: createToolServer({
				add: {
					handler: (args) => {
						const { a, b } = args as { a: number; b: number };
						return { content: [{ type: "text", text: String(a + b) }] };
					},
				},
			}),
			server: { key: "test" },
		});
		const ops = createOps(client);
		const listed = await ops.tools.listAll();
		expect(listed.kind).toBe("ok");
		const called = await ops.tools.call("add", { a: 2, b: 3 });
		expect(called.kind).toBe("ok");
		const missing = await ops.tools.call("missing");
		expect(missing.kind).toBe("jsonrpc-error");
		if (missing.kind === "jsonrpc-error") expect(missing.code).toBe(-32602);
		await client.close();
	});
});
