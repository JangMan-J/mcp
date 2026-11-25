import { PassThrough } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connect } from "@mcp/client";
import { McpServer } from "@mcp/server";
import { EventsServer, SubscriptionsServer } from "@mcp/server-events";
import { StdioServerHost } from "../src/index.js";

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

	it("dispatches concurrently so notifications/cancelled aborts a waiting tool without head-of-line blocking, ignores stray responses, and finishes streams on EOF", async () => {
		let aborted = false;
		const server = new McpServer({
			serverInfo: { name: "stdio-unit", version: "1.0.0" },
			subscriptions: new SubscriptionsServer({ capabilities: { tools: { listChanged: true } } }),
			events: new EventsServer({ events: [{ name: "roger.mail", delivery: ["push", "poll"] }] }),
		});
		server.registerTool({
			name: "wait_forever",
			handler: (_args, { signal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						aborted = true;
						reject(new Error("aborted"));
					}, { once: true });
				}),
		});
		server.registerTool({
			name: "fast",
			handler: () => ({ content: [{ type: "text", text: "quick" }] }),
		});

		const input = new PassThrough();
		const output = new PassThrough();
		const lines: Array<Record<string, unknown>> = [];
		let buf = "";
		output.on("data", (chunk: Buffer) => {
			buf += chunk.toString("utf8");
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const raw = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (raw) lines.push(JSON.parse(raw) as Record<string, unknown>);
				nl = buf.indexOf("\n");
			}
		});

		const host = new StdioServerHost({ server, input, output });
		const done = host.listen();
		const meta = {
			"io.modelcontextprotocol/protocolVersion": "2026-07-28",
			"io.modelcontextprotocol/clientCapabilities": {},
		};

		// 1. Parse error (-32700, id: null), batch invalid-request (-32600, id: null), and ignored stray response
		input.write("{bad json\n");
		input.write("[1,2]\n");
		input.write(JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} }) + "\n");

		// 2. Open a live events/stream (id: "stream-1")
		input.write(JSON.stringify({
			jsonrpc: "2.0",
			id: "stream-1",
			method: "events/stream",
			params: { name: "roger.mail", cursor: null, _meta: meta },
		}) + "\n");

		// 3. Start blocking wait_forever (id: 10), then concurrent fast (id: 11), then cancel id: 10
		input.write(JSON.stringify({
			jsonrpc: "2.0",
			id: 10,
			method: "tools/call",
			params: { name: "wait_forever", arguments: {}, _meta: meta },
		}) + "\n");
		input.write(JSON.stringify({
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "fast", arguments: {}, _meta: meta },
		}) + "\n");
		await new Promise((r) => setTimeout(r, 20));
		// fast completed even while wait_forever was still blocked!
		expect(lines.some((m) => m.id === 11)).toBe(true);

		input.write(JSON.stringify({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 10 },
		}) + "\n");
		await new Promise((r) => setTimeout(r, 20));
		expect(aborted).toBe(true);
		// Cancelled request 10 emitted no response
		expect(lines.some((m) => m.id === 10)).toBe(false);

		// Close stdin -> graceful stream completion frame for "stream-1"
		input.end();
		await done;

		expect(lines.find((m) => (m.error as { code?: number } | undefined)?.code === -32700)?.id).toBeNull();
		expect(lines.find((m) => (m.error as { code?: number } | undefined)?.code === -32600)?.id).toBeNull();
		expect(lines.some((m) => m.id === 99)).toBe(false);
		expect(lines.find((m) => m.id === "stream-1" && "result" in m)).toMatchObject({
			id: "stream-1",
			result: {
				resultType: "complete",
				_meta: {
					"io.modelcontextprotocol/subscriptionId": "stream-1",
					"io.modelcontextprotocol/serverInfo": { name: "stdio-unit", version: "1.0.0" },
				},
			},
		});
	});
});
