#!/usr/bin/env node
/** Feature-rich MCP stdio server for Pi bridge parity tests. */
import { createInterface } from "node:readline";

let listening = false;
const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const tools = () => [
	{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { message: { type: "string" } } } },
	{ name: "big", description: "Big text", inputSchema: { type: "object", properties: {} } },
	{ name: "ask", description: "Ask for input", inputSchema: { type: "object", properties: {} } },
	{ name: "task", description: "Start a task", inputSchema: { type: "object", properties: {} } },
	...(listening ? [{ name: "extra", description: "Added later", inputSchema: { type: "object", properties: {} } }] : []),
];

rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.id === undefined || msg.method === undefined) return;
	const result = (value) => send({ jsonrpc: "2.0", id: msg.id, result: value });
	const error = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
	switch (msg.method) {
		case "server/discover":
			return result({
				cacheScope: "public",
				capabilities: {
					tools: { listChanged: true },
					resources: { listChanged: true, subscribe: true },
					prompts: { listChanged: true },
					extensions: { "io.modelcontextprotocol/tasks": {} },
				},
				instructions: "Feature server.",
				supportedVersions: ["2026-07-28"],
			});
		case "tools/list":
			return result({ tools: tools() });
		case "tools/call": {
			const { name, arguments: args } = msg.params ?? {};
			if (name === "echo") return result({ content: [{ type: "text", text: String(args?.message ?? "") }] });
			if (name === "big") return result({ content: [{ type: "text", text: "x".repeat(25_000) }] });
			if (name === "extra") return result({ content: [{ type: "text", text: "extra" }] });
			if (name === "task") return result({ resultType: "task", taskId: "t1", status: "working", pollIntervalMs: 10 });
			if (name === "ask") {
				if (!msg.params?.inputResponses) {
					return result({
						resultType: "input_required",
						requestState: "s1",
						inputRequests: {
							q: {
								method: "elicitation/create",
								params: {
									message: "Need a name",
									requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
								},
							},
						},
					});
				}
				const name = msg.params.inputResponses.q?.content?.name;
				return result({ content: [{ type: "text", text: `hello ${name}` }] });
			}
			return error(-32602, `unknown tool: ${name}`);
		}
		case "tasks/get":
			return result({ taskId: "t1", status: "completed", result: { ok: true } });
		case "tasks/cancel":
			return result({ taskId: "t1", status: "cancelled" });
		case "resources/list":
			return result({ resources: [{ uri: "file:///a.txt", name: "a", mimeType: "text/plain" }] });
		case "resources/templates/list":
			return result({ resourceTemplates: [{ uriTemplate: "file:///users/{id}", name: "user" }] });
		case "resources/read":
			return result({ contents: [{ uri: msg.params?.uri, text: "resource text", mimeType: "text/plain" }] });
		case "prompts/list":
			return result({ prompts: [{ name: "greet", arguments: [{ name: "who", required: true }] }] });
		case "prompts/get":
			return result({ messages: [{ role: "user", content: { type: "text", text: `hi ${msg.params?.arguments?.who}` } }] });
		case "subscriptions/listen": {
			listening = true;
			const id = msg.id;
			send({
				jsonrpc: "2.0",
				method: "notifications/subscriptions/acknowledged",
				params: {
					notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
					_meta: { "io.modelcontextprotocol/subscriptionId": id },
				},
			});
			setTimeout(() => {
				send({
					jsonrpc: "2.0",
					method: "notifications/tools/list_changed",
					params: { _meta: { "io.modelcontextprotocol/subscriptionId": id } },
				});
			}, 50);
			return;
		}
		default:
			return error(-32601, `method not found: ${msg.method}`);
	}
});
