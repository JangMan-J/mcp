import { describe, expect, it } from "vitest";
import { connect } from "@mcp/client";
import { ConfiguredBearer } from "@mcp/auth";
import { McpServer } from "@mcp/server";
import { EventBus, EventsServer, SubscriptionsServer, TaskCenter } from "@mcp/server-events";
import { buildProtectedResourceMetadata, HttpServerHost, StaticBearerAuth } from "../src/index.js";

async function startServer(opts: { auth?: boolean } = {}) {
	const bus = new EventBus();
	const server = new McpServer({
		serverInfo: { name: "io.example/http-test", version: "1.0.0" },
		subscriptions: new SubscriptionsServer({ capabilities: { tools: { listChanged: true } } }),
		events: new EventsServer({
			bus,
			heartbeatMs: 1000,
			events: [
				{
					name: "mail",
					delivery: ["push", "poll"],
					inputSchema: {
						type: "object",
						properties: { folder: { type: "string", "x-mcp-header": "Folder" } },
					},
				},
				{
					name: "board",
					delivery: ["push"],
				},
			],
		}),
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
	server.registerResource({
		uri: "file:///readme.txt",
		name: "readme",
		handler: () => "hello resource",
	});
	const listener = new HttpServerHost({
		server,
		...(opts.auth
			? {
					auth: new StaticBearerAuth("secret"),
					protectedResourceMetadata: buildProtectedResourceMetadata({
						resource: "http://127.0.0.1/mcp",
						authorizationServers: ["https://auth.example.test"],
					}),
				}
			: {}),
		serverCard: {
			$schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
			name: "io.example/http-test",
			version: "1.0.0",
			description: "HTTP test server",
			remotes: [{ type: "streamable-http", url: "http://127.0.0.1/mcp", supportedProtocolVersions: ["2026-07-28"] }],
		},
	}).createServer();
	await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
	const address = listener.address();
	if (!address || typeof address === "string") throw new Error("no bind");
	const baseUrl = `http://127.0.0.1:${address.port}`;
	return {
		baseUrl,
		url: `${baseUrl}/mcp`,
		bus,
		close: () => new Promise<void>((resolve) => {
			listener.close(() => resolve());
			listener.closeAllConnections();
		}),
	};
}

describe("HttpServerHost <-> HttpTransport", () => {
	it("serves tools and resources with strict Mcp-Name and Mcp-Param validation", async () => {
		const srv = await startServer();
		const connection = await connect({ http: { url: srv.url } });
		try {
			const result = await connection.tools.call("echo", { message: "http" });
			expect(result.content[0]?.raw).toEqual({ type: "text", text: "http" });
			const resOut = await connection.ops.resources.read("file:///readme.txt");
			expect(resOut.kind).toBe("ok");
		} finally {
			await connection.close();
			await srv.close();
		}
	}, 15_000);

	it("pushes events over SSE with string request IDs and mirrors event x-mcp-header params", async () => {
		const srv = await startServer();
		let seq = 0;
		const connection = await connect({
			http: { url: srv.url },
			discover: true,
			idGenerator: () => `str-req-${++seq}`,
		});
		try {
			const subscription = await connection.events.subscribe("mail", { folder: "inbox" });
			const next = subscription[Symbol.asyncIterator]().next();
			await new Promise((r) => setTimeout(r, 100));
			srv.bus.publish("mail", { subject: "sse-string-id" }, { folder: "inbox" });
			const received = await next;
			expect(received.value?.data).toEqual({ subject: "sse-string-id" });
			await subscription.close();
		} finally {
			await connection.close();
			await srv.close();
		}
	}, 15_000);

	it("validates Accept q-values, malformed base64 Mcp-Name, 404 on unknown method, Server Cards, and RFC 9728 metadata", async () => {
		const srv = await startServer({ auth: true });
		try {
			// Server Card + AI Catalog + ETag 304 (public pre-connection discovery, no auth needed)
			const cardRes = await fetch(`${srv.baseUrl}/mcp/server-card`);
			expect(cardRes.status).toBe(200);
			expect(cardRes.headers.get("content-type")).toBe("application/mcp-server-card+json");
			const etag = cardRes.headers.get("etag")!;
			expect(etag).toBeTruthy();
			const cached = await fetch(`${srv.baseUrl}/mcp/server-card`, { headers: { "If-None-Match": etag } });
			expect(cached.status).toBe(304);

			const catRes = await fetch(`${srv.baseUrl}/.well-known/ai-catalog.json`);
			expect(catRes.status).toBe(200);
			expect(catRes.headers.get("content-type")).toBe("application/ai-catalog+json");

			// RFC 9728 Protected Resource Metadata
			const prmRes = await fetch(`${srv.baseUrl}/.well-known/oauth-protected-resource/mcp`);
			expect(prmRes.status).toBe(200);
			expect(await prmRes.json()).toMatchObject({ authorization_servers: ["https://auth.example.test"] });

			const authHeaders = {
				Authorization: "Bearer secret",
				"Content-Type": "application/json",
				"MCP-Protocol-Version": "2026-07-28",
			};
			const meta = {
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientCapabilities": {},
			};

			// Accept: */* passes; Accept with q=0 fails with 406 and id: null
			const wildcard = await fetch(srv.url, {
				method: "POST",
				headers: { ...authHeaders, Accept: "*/*", "Mcp-Method": "server/discover" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }),
			});
			expect(wildcard.status).toBe(200);

			const qZero = await fetch(srv.url, {
				method: "POST",
				headers: { ...authHeaders, Accept: "application/json;q=0, text/event-stream", "Mcp-Method": "server/discover" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }),
			});
			expect(qZero.status).toBe(406);
			expect((await qZero.json() as { id: unknown }).id).toBeNull();

			// Malformed base64 Mcp-Name -> 400 + -32020
			const badB64 = await fetch(srv.url, {
				method: "POST",
				headers: {
					...authHeaders,
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "tools/call",
					"Mcp-Name": "=?base64?not_valid!?=",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "echo", _meta: meta } }),
			});
			expect(badB64.status).toBe(400);
			expect((await badB64.json() as { error: { code: number } }).error.code).toBe(-32020);

			// Unknown method -> 404 + -32601 (2026-07-28 Streamable HTTP)
			const noMethod = await fetch(srv.url, {
				method: "POST",
				headers: { ...authHeaders, Accept: "application/json, text/event-stream", "Mcp-Method": "unknown/rpc" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "unknown/rpc", params: { _meta: meta } }),
			});
			expect(noMethod.status).toBe(404);
			expect((await noMethod.json() as { error: { code: number } }).error.code).toBe(-32601);

			// Push-only event stream invalid event -> JSON error without opening SSE stream; valid stream sets X-Accel-Buffering: no
			const badStream = await fetch(srv.url, {
				method: "POST",
				headers: {
					...authHeaders,
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "events/stream",
					"Mcp-Name": "missing",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "events/stream", params: { name: "missing", _meta: meta } }),
			});
			expect(badStream.headers.get("content-type")).toContain("application/json");
			expect((await badStream.json() as { error: { code: number } }).error.code).toBe(-32023);

			const ac = new AbortController();
			const okStream = await fetch(srv.url, {
				method: "POST",
				headers: {
					...authHeaders,
					Accept: "application/json, text/event-stream",
					"Mcp-Method": "events/stream",
					"Mcp-Name": "board",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "events/stream", params: { name: "board", _meta: meta } }),
				signal: ac.signal,
			});
			expect(okStream.status).toBe(200);
			expect(okStream.headers.get("x-accel-buffering")).toBe("no");
			ac.abort();
		} finally {
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
