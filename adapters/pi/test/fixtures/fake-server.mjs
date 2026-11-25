#!/usr/bin/env node
/**
 * Minimal MCP stdio server for bridge tests: newline-delimited JSON-RPC.
 * Implements server/discover, tools/list, tools/call (echo / fail), ping.
 */

import { createInterface } from "node:readline";

const TOOLS = [
	{
		name: "echo",
		description: "Echo the message back",
		inputSchema: {
			type: "object",
			properties: { message: { type: "string" } },
			required: ["message"],
		},
		annotations: { readOnlyHint: true },
	},
	{
		name: "fail",
		description: "Always fails with isError",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "weird.name/x",
		description: "Name needing sanitization",
		inputSchema: { type: "object", properties: {} },
	},
];

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
	const trimmed = line.trim();
	if (trimmed === "") return;
	let msg;
	try {
		msg = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (msg.id === undefined || msg.method === undefined) return; // notification
	const reply = (result) =>
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
	const fail = (code, message) =>
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message } })}\n`);

	switch (msg.method) {
		case "server/discover":
			reply({
				cacheScope: "public",
				capabilities: { tools: {} },
				instructions: "Fake test server.\nSecond line.",
				serverInfo: { name: "fake", version: "0.0.1" },
			});
			break;
		case "initialize":
			reply({
				protocolVersion: "2026-07-28",
				capabilities: { tools: {} },
				serverInfo: { name: "fake", version: "0.0.1" },
			});
			break;
		case "ping":
			reply({});
			break;
		case "tools/list":
			reply({ tools: TOOLS });
			break;
		case "tools/call": {
			const { name, arguments: args } = msg.params ?? {};
			if (name === "echo") {
				reply({
					content: [{ type: "text", text: String(args?.message ?? "") }],
					structuredContent: { echo: args?.message ?? null },
				});
			} else if (name === "fail") {
				reply({ content: [{ type: "text", text: "boom" }], isError: true });
			} else if (name === "weird.name/x") {
				reply({ content: [{ type: "text", text: "weird ok" }] });
			} else {
				fail(-32602, `unknown tool: ${name}`);
			}
			break;
		}
		default:
			fail(-32601, `method not found: ${msg.method}`);
	}
});
