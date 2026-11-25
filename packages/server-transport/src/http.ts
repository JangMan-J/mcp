import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { JsonRpcNotification, JsonRpcRequest } from "@mcp/core";
import type { McpServer } from "@mcp/server";
import { object, ServerError, type Obj } from "@mcp/server-events";
import { extractAtPath, isPlainHeaderSafe, validateXmcpHeaderSchema } from "@mcp/transport-http";
import { bearerChallenge, type BearerAuthenticator } from "./auth.js";
import { classifyInboundJson, errorResponse, HostChannel, resultResponse } from "./channel.js";

const LISTEN_KEEPALIVE_MS = 30_000;
const BASE64_CHUNK_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2}==)$/u;
const EVENT_PARAM_METHODS = new Set(["events/poll", "events/stream", "events/subscribe", "events/unsubscribe"]);
const NAME_HEADER_METHODS = new Set([
	"tools/call",
	"prompts/get",
	"events/poll",
	"events/stream",
	"events/subscribe",
	"events/unsubscribe",
]);

export interface HostedServerCard {
	readonly $schema: string;
	readonly name: string;
	readonly version: string;
	readonly description: string;
	readonly [k: string]: unknown;
}

export interface HttpServerHostOptions {
	readonly server: McpServer;
	readonly path?: string;
	readonly auth?: BearerAuthenticator;
	readonly resourceMetadataUrl?: string;
	/** Optional RFC 9728 Protected Resource Metadata document served at /.well-known/oauth-protected-resource*. */
	readonly protectedResourceMetadata?: Record<string, unknown>;
	/** Optional SEP-2127 Server Card served at <path>/server-card and /.well-known/ai-catalog.json. */
	readonly serverCard?: HostedServerCard;
	/** Allowed Origin values; default loopback origins only (plus no Origin). */
	readonly allowedOrigins?: readonly string[] | ((origin: string) => boolean);
	readonly maxBodyBytes?: number;
	/** Keepalive comment cadence on subscriptions/listen SSE streams. Default 30000ms. */
	readonly listenKeepaliveMs?: number;
}

export function decodeStrictHeaderValue(value: string): string {
	if (value.startsWith("=?base64?") && value.endsWith("?=")) {
		const inner = value.slice(9, -2);
		if (inner.length > 0 && !BASE64_CHUNK_RE.test(inner)) {
			throw new ServerError(-32020, "invalid base64 in encoded MCP header");
		}
		const bytes = Buffer.from(inner, "base64");
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new ServerError(-32020, "invalid UTF-8 inside base64 MCP header");
		}
	}
	if (!isPlainHeaderSafe(value)) {
		throw new ServerError(-32020, "invalid characters in plain MCP header value");
	}
	return value;
}

export function acceptAllowsMedia(acceptHeader: string | string[] | undefined, target: string): boolean {
	if (acceptHeader === undefined) return false;
	const rawList = Array.isArray(acceptHeader) ? acceptHeader : [acceptHeader];
	const targetPrefix = target.split("/")[0]?.toLowerCase() ?? "";
	const targetLower = target.toLowerCase();
	let bestSpecificity = -1;
	let bestAllowed = false;
	for (const raw of rawList) {
		for (const item of raw.split(",")) {
			const parts = item.split(";");
			const media = (parts[0] ?? "").trim().toLowerCase();
			if (!media) continue;
			let specificity = -1;
			if (media === targetLower) specificity = 2;
			else if (media === `${targetPrefix}/*`) specificity = 1;
			else if (media === "*/*") specificity = 0;
			if (specificity < 0) continue;
			let q = 1;
			for (const param of parts.slice(1)) {
				const eq = param.indexOf("=");
				if (eq < 0) continue;
				const k = param.slice(0, eq).trim().toLowerCase();
				const v = param.slice(eq + 1).trim();
				if (k === "q") {
					const parsed = Number(v);
					if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
						q = -1;
					} else {
						q = parsed;
					}
				}
			}
			if (q < 0) continue;
			if (specificity > bestSpecificity) {
				bestSpecificity = specificity;
				bestAllowed = q > 0;
			} else if (specificity === bestSpecificity && q === 0) {
				bestAllowed = false;
			}
		}
	}
	return bestSpecificity >= 0 && bestAllowed;
}

function isLoopbackOrigin(origin: string): boolean {
	if (!origin || origin === "null") return false;
	try {
		const u = new URL(origin);
		if (u.protocol !== "http:" && u.protocol !== "https:") return false;
		return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
	} catch {
		return false;
	}
}

function etagOf(body: string): string {
	return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

/** Streamable HTTP host: POST-only /mcp, header enforcement, SSE streams, Server Cards, RFC 9728 metadata, bearer auth. */
export class HttpServerHost {
	readonly #options: HttpServerHostOptions;
	readonly #path: string;
	readonly #keepaliveMs: number;

	constructor(options: HttpServerHostOptions) {
		this.#options = options;
		this.#path = options.path ?? "/mcp";
		this.#keepaliveMs = options.listenKeepaliveMs ?? LISTEN_KEEPALIVE_MS;
	}

	createServer(): Server {
		return createServer((req, res) => {
			void this.handle(req, res).catch((error) => {
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify(errorResponse(null, error)));
				} else if (!res.writableEnded) res.end();
			});
		});
	}

	async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", "http://localhost");
		const cleanPath = this.#path.replace(/\/+$/u, "") || "";
		const cardPath = `${cleanPath}/server-card`;
		const prmSubPath = `/.well-known/oauth-protected-resource${cleanPath}`;

		if (url.pathname === "/healthz") {
			if (req.method !== "GET") {
				this.#methodNotAllowed(res, "GET");
				return;
			}
			this.#json(res, 200, { ok: true });
			return;
		}

		if (this.#options.serverCard && (url.pathname === cardPath || url.pathname === "/.well-known/ai-catalog.json")) {
			if (req.method !== "GET") {
				this.#methodNotAllowed(res, "GET");
				return;
			}
			const isCatalog = url.pathname === "/.well-known/ai-catalog.json";
			const payload = isCatalog
				? {
						specVersion: "1.0",
						entries: [{
							identifier: `urn:air:mcp:server:${this.#options.serverCard.name}`,
							type: "application/mcp-server-card+json",
							data: this.#options.serverCard,
						}],
					}
				: this.#options.serverCard;
			const body = JSON.stringify(payload);
			const etag = etagOf(body);
			if (req.headers["if-none-match"] === etag) {
				res.writeHead(304, {
					ETag: etag,
					"Cache-Control": "public, max-age=300",
					"Access-Control-Allow-Origin": "*",
				}).end();
				return;
			}
			res.writeHead(200, {
				"Content-Type": isCatalog ? "application/ai-catalog+json" : "application/mcp-server-card+json",
				ETag: etag,
				"Cache-Control": "public, max-age=300",
				"Access-Control-Allow-Origin": "*",
			});
			res.end(body);
			return;
		}

		if (
			this.#options.protectedResourceMetadata &&
			(url.pathname === prmSubPath || url.pathname === "/.well-known/oauth-protected-resource")
		) {
			if (req.method !== "GET") {
				this.#methodNotAllowed(res, "GET");
				return;
			}
			this.#json(res, 200, this.#options.protectedResourceMetadata);
			return;
		}

		if (url.pathname !== this.#path) {
			this.#json(res, 404, errorResponse(null, new ServerError(-32601, "not found")));
			return;
		}
		if (req.method !== "POST") {
			this.#methodNotAllowed(res, "POST");
			return;
		}
		const origin = req.headers.origin;
		if (origin !== undefined && !this.#originAllowed(origin)) {
			this.#json(res, 403, errorResponse(null, new ServerError(-32602, "forbidden origin")));
			return;
		}
		if (this.#options.auth) {
			const context = await this.#options.auth.authenticate(req.headers.authorization);
			if (!context) {
				const metadata = this.#options.resourceMetadataUrl ?? `http://${req.headers.host ?? "localhost"}/.well-known/oauth-protected-resource${cleanPath}`;
				res.writeHead(401, { "WWW-Authenticate": bearerChallenge(metadata), "Content-Type": "application/json" });
				res.end(JSON.stringify(errorResponse(null, new ServerError(-32602, "unauthorized"))));
				return;
			}
		}
		if (!acceptAllowsMedia(req.headers.accept, "application/json") || !acceptAllowsMedia(req.headers.accept, "text/event-stream")) {
			this.#json(res, 406, errorResponse(null, new ServerError(-32602, "Accept must allow application/json and text/event-stream")));
			return;
		}

		let rawText: string;
		try {
			rawText = await this.#body(req);
		} catch (error) {
			const status = error instanceof BodyTooLargeError ? 413 : 400;
			this.#json(res, status, errorResponse(null, new ServerError(-32700, error instanceof Error ? error.message : "invalid body")));
			return;
		}

		const classified = classifyInboundJson(rawText);
		if (classified.kind === "response") {
			this.#json(res, 400, errorResponse(null, new ServerError(-32600, "clients must not send JSON-RPC responses")));
			return;
		}
		if (classified.kind === "bad") {
			this.#json(res, 400, errorResponse(classified.id, new ServerError(classified.code, classified.message)));
			return;
		}
		if (classified.kind === "notification") {
			try {
				this.#validateNotificationHeaders(req, classified.msg);
			} catch (error) {
				this.#json(res, 400, errorResponse(null, error));
				return;
			}
			this.#options.server.handleNotification(classified.msg);
			res.writeHead(202).end();
			return;
		}

		const request = classified.msg;
		const id = request.id;
		try {
			this.#validateRequestHeaders(req, request);
		} catch (error) {
			this.#json(res, 400, errorResponse(id, error));
			return;
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
			this.#json(res, this.#errorHttpStatus(error), errorResponse(id, error));
		}
	}

	#errorHttpStatus(error: unknown): number {
		if (!(error instanceof ServerError)) return 200;
		if (error.code === -32601) return 404;
		if ([-32602, -32020, -32021, -32022].includes(error.code)) return 400;
		return 200;
	}

	#methodNotAllowed(res: ServerResponse, allow: string): void {
		res.writeHead(405, { Allow: allow, "Content-Type": "application/json" });
		res.end(JSON.stringify(errorResponse(null, new ServerError(-32601, "method not allowed"))));
	}

	#validateNotificationHeaders(req: IncomingMessage, msg: JsonRpcNotification): void {
		const methodHeader = req.headers["mcp-method"];
		if (methodHeader !== undefined && methodHeader !== msg.method) {
			throw new ServerError(-32020, "Mcp-Method header does not match notification method");
		}
		const params = (msg.params ?? {}) as Obj;
		const meta = object(params._meta) ? params._meta : undefined;
		const bodyPv = meta?.["io.modelcontextprotocol/protocolVersion"];
		const hdrPv = req.headers["mcp-protocol-version"];
		if (typeof bodyPv === "string" && hdrPv !== bodyPv) {
			throw new ServerError(-32020, "MCP-Protocol-Version header does not match _meta protocolVersion");
		}
	}

	#validateRequestHeaders(req: IncomingMessage, request: JsonRpcRequest): void {
		const params = (request.params ?? {}) as Obj;
		const meta = object(params._meta) ? params._meta : undefined;
		const version = req.headers["mcp-protocol-version"];
		const methodHeader = req.headers["mcp-method"];
		if (typeof version !== "string" || version === "") {
			throw new ServerError(-32020, "missing MCP-Protocol-Version header");
		}
		if (typeof methodHeader !== "string" || methodHeader !== request.method) {
			throw new ServerError(-32020, "Mcp-Method header mismatch");
		}
		const bodyVersion = meta?.["io.modelcontextprotocol/protocolVersion"];
		if (typeof bodyVersion === "string" && version !== bodyVersion) {
			throw new ServerError(-32020, "MCP-Protocol-Version header does not match _meta protocolVersion");
		}

		if (NAME_HEADER_METHODS.has(request.method)) {
			const rawName = req.headers["mcp-name"];
			if (typeof rawName !== "string" || rawName === "") {
				throw new ServerError(-32020, "missing Mcp-Name header");
			}
			const decoded = decodeStrictHeaderValue(rawName);
			if (typeof params.name !== "string" || params.name === "" || decoded !== params.name) {
				throw new ServerError(-32020, "Mcp-Name header does not match params.name");
			}
		} else if (request.method === "resources/read") {
			const rawName = req.headers["mcp-name"];
			if (typeof rawName !== "string" || rawName === "") {
				throw new ServerError(-32020, "missing Mcp-Name header");
			}
			const decoded = decodeStrictHeaderValue(rawName);
			if (typeof params.uri !== "string" || params.uri === "" || decoded !== params.uri) {
				throw new ServerError(-32020, "Mcp-Name header does not match params.uri");
			}
		} else if (
			request.method === "tasks/get" ||
			request.method === "tasks/update" ||
			request.method === "tasks/cancel"
		) {
			const rawName = req.headers["mcp-name"];
			if (typeof rawName !== "string" || rawName === "") {
				throw new ServerError(-32020, "missing Mcp-Name header");
			}
			const decoded = decodeStrictHeaderValue(rawName);
			if (typeof params.taskId !== "string" || params.taskId === "" || decoded !== params.taskId) {
				throw new ServerError(-32020, "Mcp-Name header does not match params.taskId");
			}
		}

		if (request.method === "tools/call" || EVENT_PARAM_METHODS.has(request.method)) {
			const mismatch = this.#paramMismatch(request, req);
			if (mismatch) throw new ServerError(-32020, mismatch);
		}
	}

	#paramMismatch(request: JsonRpcRequest, req: IncomingMessage): string | undefined {
		const params = (request.params ?? {}) as Obj;
		const targetName = String(params.name ?? "");
		const schema = request.method === "tools/call"
			? this.#options.server.toolSchema(targetName)
			: this.#options.server.eventSchema(targetName);
		if (!schema) return undefined;
		const validation = validateXmcpHeaderSchema(schema.inputSchema);
		if (!validation.valid) return `server schema has invalid x-mcp-header annotations: ${validation.violations[0]}`;
		for (const param of validation.params) {
			const headerName = `mcp-param-${param.headerName.toLowerCase()}`;
			const rawHeader = req.headers[headerName];
			if (Array.isArray(rawHeader)) return `duplicate Mcp-Param-${param.headerName} header`;
			const value = extractAtPath(params.arguments, param.path);
			if (value === undefined || value === null) {
				if (rawHeader !== undefined) return `Mcp-Param-${param.headerName} must be omitted`;
				continue;
			}
			if (rawHeader === undefined) return `missing Mcp-Param-${param.headerName} header`;
			let decoded: string;
			try {
				decoded = decodeStrictHeaderValue(rawHeader);
			} catch (error) {
				return error instanceof Error ? error.message : `invalid Mcp-Param-${param.headerName}`;
			}
			if (param.type === "string") {
				if (typeof value !== "string" || decoded !== value) return `Mcp-Param-${param.headerName} does not match the request body`;
			} else if (param.type === "boolean") {
				if (typeof value !== "boolean" || decoded !== (value ? "true" : "false")) {
					return `Mcp-Param-${param.headerName} does not match the request body`;
				}
			} else if (param.type === "integer") {
				if (typeof value !== "number" || !Number.isSafeInteger(value) || !/^-?\d+$/u.test(decoded) || Number(decoded) !== value) {
					return `Mcp-Param-${param.headerName} does not match the request body`;
				}
			}
		}
		return undefined;
	}

	#openStream(request: JsonRpcRequest, res: ServerResponse): void {
		let streaming = false;
		const buffered: string[] = [];
		let finishedResult: Obj | undefined;

		const writeFrame = (frame: string, end = false) => {
			if (!streaming) {
				buffered.push(frame);
				return;
			}
			if (res.writableEnded) return;
			if (end) res.write(frame, () => res.end());
			else res.write(frame);
		};

		const channel = new HostChannel(
			request.id,
			(notification) => writeFrame(`data: ${JSON.stringify(notification)}\n\n`),
			(result) => {
				const existingMeta = object(result._meta) ? result._meta : {};
				const withMeta: Obj = {
					...result,
					_meta: {
						...existingMeta,
						"io.modelcontextprotocol/subscriptionId": request.id,
						"io.modelcontextprotocol/serverInfo": this.#options.server.serverInfo,
					},
				};
				if (!streaming) {
					finishedResult = withMeta;
				}
				writeFrame(`data: ${JSON.stringify(resultResponse(request.id, withMeta))}\n\n`, true);
			},
		);

		try {
			this.#options.server.validateStreamRequest(request);
			if (request.method === "subscriptions/listen") {
				const subscriptions = this.#options.server.subscriptions;
				if (!subscriptions) throw new ServerError(-32601, "subscriptions unavailable");
				const reqParams = (request.params ?? {}) as Obj;
				subscriptions.listen(channel, reqParams);
				const notifFilter = object(reqParams.notifications) ? reqParams.notifications : undefined;
				const taskIds = Array.isArray(notifFilter?.taskIds)
					? notifFilter.taskIds.filter((id): id is string => typeof id === "string")
					: undefined;
				if (taskIds && taskIds.length > 0) this.#options.server.tasks?.attach(channel, taskIds);
			} else {
				const events = this.#options.server.events;
				if (!events) throw new ServerError(-32601, "events unavailable");
				events.stream(channel, (request.params ?? {}) as Obj);
			}
		} catch (error) {
			channel.close();
			this.#json(res, this.#errorHttpStatus(error), errorResponse(request.id, error));
			return;
		}

		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		res.write(": mcp-stream-open\n\n");
		streaming = true;
		for (const frame of buffered) {
			res.write(frame);
		}
		buffered.length = 0;
		if (finishedResult !== undefined) {
			res.end();
			return;
		}

		let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
		if (request.method === "subscriptions/listen" && this.#keepaliveMs > 0) {
			keepaliveTimer = setInterval(() => {
				if (!res.writableEnded) res.write(": keepalive\n\n");
			}, this.#keepaliveMs);
			keepaliveTimer.unref?.();
		}
		res.on("close", () => {
			if (keepaliveTimer) clearInterval(keepaliveTimer);
			channel.close();
		});
	}

	#originAllowed(origin: string): boolean {
		const allowed = this.#options.allowedOrigins;
		if (allowed === undefined) return isLoopbackOrigin(origin);
		if (typeof allowed === "function") return allowed(origin);
		return allowed.includes(origin) || isLoopbackOrigin(origin);
	}

	async #body(req: IncomingMessage): Promise<string> {
		const max = this.#options.maxBodyBytes ?? 16 * 1024 * 1024;
		const cl = req.headers["content-length"];
		if (cl !== undefined) {
			const parsedLen = Number(cl);
			if (Number.isFinite(parsedLen) && parsedLen > max) throw new BodyTooLargeError(max);
		}
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of req) {
			const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
			total += buf.byteLength;
			if (total > max) throw new BodyTooLargeError(max);
			chunks.push(buf);
		}
		return Buffer.concat(chunks).toString("utf8");
	}

	#json(res: ServerResponse, status: number, body: unknown): void {
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
		res.end(JSON.stringify(body));
	}
}

class BodyTooLargeError extends Error {
	constructor(max: number) {
		super(`request body exceeds ${max} bytes`);
	}
}
