import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { JsonRpcNotification, JsonRpcRequest } from "@mcp/core";
import type { McpServer } from "@mcp/server";
import { ServerError, type Obj } from "@mcp/server-events";
import { encodeHeaderValue, extractAtPath, validateXmcpHeaderSchema } from "@mcp/transport-http";
import { bearerChallenge, type BearerAuthenticator } from "./auth.js";
import { errorResponse, HostChannel, resultResponse } from "./channel.js";

export interface HttpServerHostOptions {
	readonly server: McpServer;
	readonly path?: string;
	readonly auth?: BearerAuthenticator;
	readonly resourceMetadataUrl?: string;
	/** Allowed Origin values; default loopback origins only (plus no Origin). */
	readonly allowedOrigins?: readonly string[] | ((origin: string) => boolean);
	readonly maxBodyBytes?: number;
}

function decodeHeaderValue(value: string): string {
	const match = /^=\?base64\?(.+)\?=$/u.exec(value);
	return match ? Buffer.from(match[1] as string, "base64").toString("utf8") : value;
}

function isLoopbackOrigin(origin: string): boolean {
	try {
		return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
	} catch {
		return false;
	}
}

/** Streamable HTTP host: POST-only, header enforcement, SSE streams, bearer auth. */
export class HttpServerHost {
	readonly #options: HttpServerHostOptions;
	readonly #path: string;

	constructor(options: HttpServerHostOptions) {
		this.#options = options;
		this.#path = options.path ?? "/mcp";
	}

	createServer(): Server {
		return createServer((req, res) => {
			void this.handle(req, res).catch((error) => {
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify(errorResponse(0, error)));
				} else if (!res.writableEnded) res.end();
			});
		});
	}

	async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		if (req.method === "GET" && url.pathname === "/healthz") {
			this.#json(res, 200, { ok: true });
			return;
		}
		if (url.pathname !== this.#path) {
			this.#json(res, 404, errorResponse(0, new ServerError(-32601, "not found")));
			return;
		}
		if (req.method !== "POST") {
			res.writeHead(405, { Allow: "POST", "Content-Type": "application/json" });
			res.end(JSON.stringify(errorResponse(0, new ServerError(-32601, "method not allowed"))));
			return;
		}
		const origin = req.headers.origin;
		if (origin !== undefined && !this.#originAllowed(origin)) {
			this.#json(res, 403, errorResponse(0, new ServerError(-32602, "forbidden origin")));
			return;
		}
		const accept = req.headers.accept ?? "";
		if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
			this.#json(res, 406, errorResponse(0, new ServerError(-32602, "Accept must include application/json and text/event-stream")));
			return;
		}
		let msg: JsonRpcRequest | JsonRpcNotification;
		try {
			const text = await this.#body(req);
			const parsed = JSON.parse(text) as unknown;
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("single JSON-RPC message required");
			msg = parsed as JsonRpcRequest;
		} catch (error) {
			this.#json(res, 400, errorResponse(0, new ServerError(-32700, error instanceof Error ? error.message : "parse error")));
			return;
		}
		const id = "id" in msg ? msg.id : undefined;
		const params = (msg.params ?? {}) as Obj;
		const meta = (params._meta ?? {}) as Obj;
		const version = req.headers["mcp-protocol-version"];
		const methodHeader = req.headers["mcp-method"];
		if (version !== meta["io.modelcontextprotocol/protocolVersion"] || methodHeader !== msg.method) {
			this.#json(res, 400, errorResponse(id ?? 0, new ServerError(-32020, "header mismatch")));
			return;
		}
		if (typeof params.name === "string") {
			const nameHeader = req.headers["mcp-name"];
			if (typeof nameHeader !== "string" || decodeHeaderValue(nameHeader) !== params.name) {
				this.#json(res, 400, errorResponse(id ?? 0, new ServerError(-32020, "Mcp-Name mismatch")));
				return;
			}
		}
		if (this.#options.auth) {
			const context = await this.#options.auth.authenticate(req.headers.authorization);
			if (!context) {
				const metadata = this.#options.resourceMetadataUrl ?? `http://${req.headers.host ?? "localhost"}/.well-known/oauth-protected-resource${this.#path}`;
				res.writeHead(401, { "WWW-Authenticate": bearerChallenge(metadata), "Content-Type": "application/json" });
				res.end(JSON.stringify(errorResponse(id ?? 0, new ServerError(-32602, "unauthorized"))));
				return;
			}
		}
		if (id === undefined) {
			this.#options.server.handleNotification(msg as JsonRpcNotification);
			res.writeHead(202).end();
			return;
		}
		const request = msg as JsonRpcRequest;
		if (request.method === "tools/call") {
			const mismatch = this.#paramMismatch(request, req);
			if (mismatch) {
				this.#json(res, 400, errorResponse(id, new ServerError(-32020, mismatch)));
				return;
			}
		}
		if (request.method === "subscriptions/listen" || request.method === "events/stream") {
			this.#openStream(request, res);
			return;
		}
		try {
			const result = await this.#options.server.handleRequest(request);
			if (this.#options.server.wasCancelled(id)) {
				res.writeHead(202).end();
				return;
			}
			this.#json(res, 200, resultResponse(id, result));
		} catch (error) {
			if (this.#options.server.wasCancelled(id)) {
				res.writeHead(202).end();
				return;
			}
			const status = error instanceof ServerError && [-32602, -32020, -32022].includes(error.code) ? 400 : 200;
			this.#json(res, status, errorResponse(id, error));
		}
	}

	#paramMismatch(request: JsonRpcRequest, req: IncomingMessage): string | undefined {
		const params = (request.params ?? {}) as Obj;
		const schema = this.#options.server.toolSchema(String(params.name));
		if (!schema) return undefined;
		const validation = validateXmcpHeaderSchema(schema.inputSchema);
		if (!validation.valid) return `server tool has invalid x-mcp-header annotations: ${validation.violations[0]}`;
		for (const param of validation.params) {
			const headerName = `mcp-param-${param.headerName.toLowerCase()}`;
			const header = req.headers[headerName] as string | undefined;
			const value = extractAtPath(params.arguments, param.path);
			if (value === undefined || value === null) {
				if (header !== undefined) return `Mcp-Param-${param.headerName} must be omitted`;
				continue;
			}
			const expected = encodeHeaderValue(value as string | number | boolean);
			if (header !== expected) return `Mcp-Param-${param.headerName} does not match the request body`;
		}
		return undefined;
	}

	#openStream(request: JsonRpcRequest, res: ServerResponse): void {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(": mcp-stream-open\n\n");
		const channel = new HostChannel(
			request.id,
			(notification) => res.write(`data: ${JSON.stringify(notification)}\n\n`),
			(result) => {
				res.write(`data: ${JSON.stringify(resultResponse(request.id, result))}\n\n`, () => res.end());
			},
		);
		res.on("close", () => channel.close());
		try {
			if (request.method === "subscriptions/listen") {
				const subscriptions = this.#options.server.subscriptions;
				if (!subscriptions) throw new ServerError(-32601, "subscriptions unavailable");
				subscriptions.listen(channel, (request.params ?? {}) as Obj);
				this.#options.server.tasks?.attach(channel);
			} else {
				const events = this.#options.server.events;
				if (!events) throw new ServerError(-32601, "events unavailable");
				events.stream(channel, (request.params ?? {}) as Obj);
			}
		} catch (error) {
			res.write(`data: ${JSON.stringify(errorResponse(request.id, error))}\n\n`, () => res.end());
		}
	}

	#originAllowed(origin: string): boolean {
		const allowed = this.#options.allowedOrigins;
		if (allowed === undefined) return isLoopbackOrigin(origin);
		if (typeof allowed === "function") return allowed(origin);
		return allowed.includes(origin) || isLoopbackOrigin(origin);
	}

	async #body(req: IncomingMessage): Promise<string> {
		const max = this.#options.maxBodyBytes ?? 1024 * 1024;
		let text = "";
		for await (const chunk of req) {
			text += chunk;
			if (text.length > max) throw new Error("request body too large");
		}
		return text;
	}

	#json(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(body));
	}
}
