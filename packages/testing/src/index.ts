/**
 * Consumer test utilities: an in-memory Transport and a tiny scriptable MCP
 * tool server. No processes, sockets, or fixtures required.
 *
 *   const transport = createToolServer({
 *     echo: { handler: (args) => ({ content: [{ type: "text", text: String(args.message) }] }) },
 *   });
 *   const connection = await connect({ transport });
 */
import {
	NotificationQueue,
	type Exchange,
	type ExchangeEnd,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type RequestId,
	type Transport,
	type TransportCall,
	type TransportDiagnostic,
} from "@mcp-client/core";

/** Throw from a handler to return a JSON-RPC error instead of a result. */
export class FakeJsonRpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "FakeJsonRpcError";
	}
}

export type InMemoryHandler = (msg: JsonRpcRequest) => unknown | Promise<unknown>;

async function* emptyDiagnostics(): AsyncGenerator<TransportDiagnostic> {
	// no diagnostics in the in-memory transport
}

export class InMemoryTransport implements Transport {
	readonly binding = "in-memory";
	readonly #handler: InMemoryHandler;
	readonly #streams = new Map<RequestId, NotificationQueue<JsonRpcNotification>>();
	readonly #closers = new Map<RequestId, () => void>();

	constructor(handler: InMemoryHandler) {
		this.#handler = handler;
	}

	/** Push a notification into one active request stream (or all of them). */
	push(notification: JsonRpcNotification, id?: RequestId): boolean {
		if (id !== undefined) return this.#streams.get(id)?.push(notification) ?? false;
		let delivered = false;
		for (const queue of this.#streams.values()) delivered = queue.push(notification) || delivered;
		return delivered;
	}

	start(msg: JsonRpcRequest, ctx: TransportCall): Exchange {
		const notifications = new NotificationQueue<JsonRpcNotification>();
		this.#streams.set(msg.id, notifications);
		const aborted = (): ExchangeEnd => ({
			kind: "failure",
			failure: { kind: "closed", message: "aborted" },
			delivery: "delivered-no-response",
		});
		const onAbort = new Promise<ExchangeEnd>((resolve) => {
			const finish = () => resolve(aborted());
			this.#closers.set(msg.id, finish);
			if (ctx.signal.aborted) finish();
			else ctx.signal.addEventListener("abort", finish, { once: true });
		});
		const work = (async (): Promise<ExchangeEnd> => {
			try {
				const result = await this.#handler(msg);
				return {
					kind: "response" as const,
					message: { jsonrpc: "2.0" as const, id: msg.id, result: result as Record<string, unknown> },
				};
			} catch (error) {
				if (error instanceof FakeJsonRpcError) {
					return {
						kind: "response" as const,
						message: {
							jsonrpc: "2.0" as const,
							id: msg.id,
							error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) },
						},
					};
				}
				return {
					kind: "failure" as const,
					failure: {
						kind: "stream-broken" as const,
						message: error instanceof Error ? error.message : String(error),
					},
					delivery: "delivered-no-response" as const,
				};
			}
		})();
		const done = Promise.race([work, onAbort]).finally(() => {
			this.#streams.delete(msg.id);
			this.#closers.delete(msg.id);
			notifications.close();
		});
		return { notifications, done };
	}

	async notify(_msg: JsonRpcNotification, _ctx: TransportCall): Promise<void> {
		// notifications are accepted and ignored
	}

	async close(): Promise<void> {
		for (const finish of [...this.#closers.values()]) finish();
	}

	get diagnostics(): AsyncIterable<TransportDiagnostic> {
		return emptyDiagnostics();
	}
}

export interface FakeTool {
	readonly description?: string;
	readonly inputSchema?: Record<string, unknown>;
	/** Return a CallToolResult-shaped object, or any value to wrap as text content. */
	readonly handler: (args: unknown) => unknown | Promise<unknown>;
}

/** A minimal MCP server exposing only tools, suitable for consumer unit tests. */
export function createToolServer(tools: Record<string, FakeTool>): InMemoryTransport {
	return new InMemoryTransport(async (msg) => {
		switch (msg.method) {
			case "server/discover":
				return {
					cacheScope: "public",
					capabilities: { tools: {} },
					supportedVersions: ["2026-07-28"],
					serverInfo: { name: "in-memory", version: "0.0.0" },
				};
			case "tools/list":
				return {
					tools: Object.entries(tools).map(([name, tool]) => ({
						name,
						description: tool.description ?? "",
						inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
					})),
				};
			case "tools/call": {
				const params = (msg.params ?? {}) as { name?: string; arguments?: unknown };
				const tool = params.name !== undefined ? tools[params.name] : undefined;
				if (!tool) throw new FakeJsonRpcError(-32602, `unknown tool: ${String(params.name)}`);
				const result = await tool.handler(params.arguments);
				if (typeof result === "object" && result !== null && "content" in result) return result;
				return {
					content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
				};
			}
			default:
				throw new FakeJsonRpcError(-32601, `method not found: ${msg.method}`);
		}
	});
}
