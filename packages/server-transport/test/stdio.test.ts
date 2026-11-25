import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connect } from "@mcp/client";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stdio-server.mjs");

describe("StdioServerHost <-> StdioTransport", () => {
	it("serves tools over a real child process", async () => {
		const connection = await connect({
			stdio: { command: process.execPath, args: [fixture] },
		});
		try {
			const tools = await connection.tools.list();
			expect(tools.map((t) => t.name)).toEqual(["echo"]);
			const result = await connection.tools.call("echo", { message: "stdio" });
			expect(result.content[0]?.raw).toEqual({ type: "text", text: "stdio" });
		} finally {
			await connection.close();
		}
	}, 15_000);
});
