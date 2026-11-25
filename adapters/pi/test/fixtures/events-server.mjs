#!/usr/bin/env node
/** MCP 2026-07-28 stdio server fixture advertising SEP-3415 events, tools without properties, and ui:// resources. */
import { createInterface } from "node:readline";

const startupDelayMs = Number(process.env.STARTUP_DELAY_MS ?? "0");
const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const activeStreams = new Map(); // name -> { id, cursor }

rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.id === undefined || msg.method === undefined) return;
	const result = (value) => send({ jsonrpc: "2.0", id: msg.id, result: value });
	const error = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });

	const handle = () => {
		switch (msg.method) {
			case "server/discover":
				return result({
					cacheScope: "public",
					capabilities: {
						tools: {},
						resources: {},
						extensions: { "io.modelcontextprotocol/events": { revision: "2026-07-28" } },
					},
					instructions: "Events & Roger parity fixture.\nSecond line.",
					supportedVersions: ["2026-07-28"],
				});
			case "tools/list":
				return result({
					tools: [
						{
							name: "bare_schema",
							description: "Omits properties on inputSchema and uses local $ref on outputSchema",
							inputSchema: { type: "object" },
							outputSchema: {
								type: "object",
								properties: { item: { $ref: "#/$defs/Item" } },
								$defs: { Item: { type: "object", properties: { ok: { type: "boolean" } } } },
							},
						},
						{
							name: "emit_mail",
							description: "Push a roger.mail occurrence to active subscribers",
							inputSchema: {
								type: "object",
								properties: {
									eventId: { type: "string" },
									body: { type: "string" },
								},
								required: ["eventId", "body"],
							},
						},
						{
							name: "empty_error",
							description: "Returns isError: true with empty content",
							inputSchema: {},
						},
					],
				});
			case "tools/call": {
				const { name, arguments: args } = msg.params ?? {};
				if (name === "bare_schema") {
					return result({
						content: [{ type: "text", text: "big-".repeat(6000) }],
						structuredContent: { item: { ok: true } },
					});
				}
				if (name === "empty_error") {
					return result({ content: [], isError: true });
				}
				if (name === "emit_mail") {
					const mailSub = activeStreams.get("roger.mail");
					const boardSub = activeStreams.get("roger.board");
					if (boardSub) {
						send({
							jsonrpc: "2.0",
							method: "notifications/events/event",
							params: {
								name: "roger.board",
								eventId: `board-${args.eventId}`,
								timestamp: "2026-11-25T18:00:00.000Z",
								cursor: `cur-b-${args.eventId}`,
								data: { event: "claim" },
								_meta: { "io.modelcontextprotocol/subscriptionId": boardSub.id },
							},
						});
					}
					if (mailSub) {
						send({
							jsonrpc: "2.0",
							method: "notifications/events/event",
							params: {
								name: "roger.mail",
								eventId: String(args.eventId),
								timestamp: "2026-11-25T18:00:00.000Z",
								cursor: `cur-${args.eventId}`,
								data: { from: "pane-2", body: String(args.body), kind: "directed" },
								_meta: { "io.modelcontextprotocol/subscriptionId": mailSub.id },
							},
						});
					}
					return result({ content: [{ type: "text", text: "sent" }] });
				}
				return error(-32602, `unknown tool: ${name}`);
			}
			case "events/list":
				return result({
					resultType: "complete",
					events: [
						{ name: "roger.mail", delivery: ["push"] },
						{ name: "roger.board", delivery: ["push"] },
					],
				});
			case "events/stream": {
				const subName = msg.params?.name;
				activeStreams.set(subName, { id: msg.id, cursor: msg.params?.cursor ?? null });
				send({
					jsonrpc: "2.0",
					method: "notifications/events/active",
					params: {
						cursor: msg.params?.cursor ?? "c0",
						heartbeatMs: 30_000,
						truncated: false,
						_meta: { "io.modelcontextprotocol/subscriptionId": msg.id },
					},
				});
				return; // open stream stays open until cancelled
			}
			case "resources/list":
				return result({
					resources: [
						{ uri: "file:///keep.txt", name: "keep", mimeType: "text/plain" },
						{ uri: "ui://widget/panel", name: "app-ui", mimeType: "text/html;profile=mcp-app" },
						{ uri: "https://example.com/app", name: "app-mime", mimeType: "text/html;profile=mcp-app" },
					],
				});
			default:
				return error(-32601, `method not found: ${msg.method}`);
		}
	};

	if (startupDelayMs > 0 && msg.method === "server/discover") {
		setTimeout(handle, startupDelayMs);
	} else {
		handle();
	}
});
