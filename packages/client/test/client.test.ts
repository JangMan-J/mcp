import { describe, expect, it } from "vitest";
import { createToolServer, FakeJsonRpcError, InMemoryTransport } from "@mcp/testing";
import { connect, McpOutcomeError } from "../src/index.js";

describe("connect (high-level consumer API)", () => {
	it("lists and calls tools without Outcome matching", async () => {
		const connection = await connect({
			transport: createToolServer({
				echo: {
					description: "Echo",
					inputSchema: { type: "object", properties: { message: { type: "string" } } },
					handler: (args) => ({
						content: [{ type: "text", text: String((args as { message: string }).message) }],
					}),
				},
			}),
		});
		try {
			const tools = await connection.tools.list();
			expect(tools.map((t) => t.name)).toEqual(["echo"]);
			const result = await connection.tools.call("echo", { message: "hello" });
			expect(result.content[0]?.raw).toEqual({ type: "text", text: "hello" });
		} finally {
			await connection.close();
		}
	});

	it("throws McpOutcomeError for unknown tools", async () => {
		const connection = await connect({ transport: createToolServer({}) });
		try {
			await expect(connection.tools.call("missing")).rejects.toThrow(McpOutcomeError);
		} finally {
			await connection.close();
		}
	});

	it("reconnectOnDrop rebuilds the transport and retries once", async () => {
		let generation = 0;
		const connection = await connect({
			reconnectOnDrop: true,
			transport: () => {
				const g = ++generation;
				return new InMemoryTransport((msg) => {
					if (g === 1) throw new Error("dropped");
					if (msg.method === "tools/call") {
						return { content: [{ type: "text", text: "recovered" }] };
					}
					throw new FakeJsonRpcError(-32601, "method not found");
				});
			},
		});
		try {
			const result = await connection.tools.call("anything", {}, { idempotent: true });
			expect(result.content[0]?.raw).toEqual({ type: "text", text: "recovered" });
			expect(generation).toBe(2);
		} finally {
			await connection.close();
		}
	});
});
