import { describe, expect, it } from "vitest";
import { connect } from "@mcp/client";
import { ConfiguredBearer } from "@mcp/auth";
import { McpServer } from "@mcp/server";
import { EventBus, EventsServer, SubscriptionsServer, TaskCenter } from "@mcp/server-events";
import { HttpServerHost, StaticBearerAuth } from "../src/index.js";

async function startServer(opts: { auth?: boolean } = {}) {
	const bus = new EventBus();
	const server = new McpServer({
		serverInfo: { name: "http-test", version: "1" },
		subscriptions: new SubscriptionsServer({ capabilities: { tools: { listChanged: true } } }),
		events: new EventsServer({ bus, heartbeatMs: 1000 }),
		tasks: new TaskCenter({ bus }),
	});
	server.registerTool({
		name: "echo",
		inputSchema: {
			type: "object",
			properties: { message: { type: "string", "x-mcp-header": "X-Message" } },
			required: ["message"],
		},
		handler: (args) => ({ content: [{ type: "text", text: String((args as { message: string }).message) }] }),
	});
	server.registerTool({
		name: "slow",
		handler: async (_args, { signal }) => {
			await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
			throw new Error("aborted by test");
		},
	});
	const host = new HttpServerHost({
		server,
		...(opts.auth ? { auth: new StaticBearerAuth("secret") } : {}),
	});
	const listener = host.createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("no bind");
	return {
		url: `http://127.0.0.1:${address.port}/mcp`,
		bus,
		close: () => new Promise<void>((resolve) => {
			listener.close(() => resolve());
			listener.closeAllConnections();
		}),
	};
}

describe("HttpServerHost <-> HttpTransport", () => {
	it("serves tools with Mcp-Name and Mcp-Param validation", async () => {
		const srv = await startServer();
		const connection = await connect({ http: { url: srv.url } });
		try {
			const result = await connection.tools.call("echo", { message: "http" });
			expect(result.content[0]?.raw).toEqual({ type: "text", text: "http" });
		} finally {
			await connection.close();
			await srv.close();
		}
	}, 15_000);

	it("pushes events over SSE", async () => {
		const srv = await startServer();
		const connection = await connect({ http: { url: srv.url }, discover: true });
		try {
			const subscription = await connection.events.subscribe("mail");
			const next = subscription[Symbol.asyncIterator]().next();
			// Let the live stream register before publishing (cursor null = new events only).
			await new Promise((r) => setTimeout(r, 150));
			srv.bus.publish("mail", { subject: "sse" });
			const received = await next;
			expect(received.value?.data).toEqual({ subject: "sse" });
			await subscription.close();
		} finally {
			await connection.close();
			await srv.close();
		}
	}, 15_000);

	it("enforces bearer auth", async () => {
		const srv = await startServer({ auth: true });
		const unauthenticated = await connect({ http: { url: srv.url } });
		await expect(unauthenticated.tools.list()).rejects.toThrow();
		await unauthenticated.close();

		const connection = await connect({
			http: { url: srv.url, authProvider: new ConfiguredBearer({ resource: srv.url, token: "secret", allowInsecureDev: true }) },
		});
		try {
			expect((await connection.tools.list()).length).toBeGreaterThan(0);
		} finally {
			await connection.close();
			await srv.close();
		}
	}, 15_000);

	it("cancels in-flight tool work", async () => {
		const srv = await startServer();
		const connection = await connect({ http: { url: srv.url } });
		try {
			const ac = new AbortController();
			const pending = connection.ops.tools.call("slow", {}, { signal: ac.signal, idempotent: true });
			setTimeout(() => ac.abort(), 100);
			const outcome = await pending;
			expect(outcome.kind).toBe("cancelled");
		} finally {
			await connection.close();
			await srv.close();
		}
	}, 15_000);
});
