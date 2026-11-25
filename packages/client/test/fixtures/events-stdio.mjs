#!/usr/bin/env node
import { createInterface } from "node:readline";
const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
rl.on("line", (line) => {
	if (!line.trim()) return;
	let msg;
	try { msg = JSON.parse(line); } catch { return; }
	if (msg.id === undefined) return;
	if (msg.method === "server/discover") {
		return send({ jsonrpc: "2.0", id: msg.id, result: {
			cacheScope: "public",
			capabilities: { extensions: { "io.modelcontextprotocol/events": { revision: "2026-07-28" } } },
			supportedVersions: ["2026-07-28"],
		} });
	}
	if (msg.method === "events/list") return send({ jsonrpc: "2.0", id: msg.id, result: { events: [{ name: "mail" }] } });
	if (msg.method === "events/stream") {
		const id = msg.id;
		send({ jsonrpc: "2.0", method: "notifications/events/active", params: { heartbeatMs: 1000, cursor: "c0", _meta: { "io.modelcontextprotocol/subscriptionId": id } } });
		setTimeout(() => {
			send({ jsonrpc: "2.0", method: "notifications/events/event", params: {
				eventId: "e1", name: "mail", timestamp: "2026-01-01T00:00:00Z", data: { ok: true }, cursor: "c1",
				_meta: { "io.modelcontextprotocol/subscriptionId": id },
			} });
		}, 50);
		return;
	}
	send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
});
