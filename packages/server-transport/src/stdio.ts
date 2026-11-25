import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcNotification, JsonRpcRequest, RequestId } from "@mcp/core";
import type { McpServer } from "@mcp/server";
import { ServerError, type Obj } from "@mcp/server-events";
import { classifyInboundJson, errorResponse, HostChannel, resultResponse } from "./channel.js";

export interface StdioServerHostOptions {
	readonly server: McpServer;
	readonly input?: Readable;
	readonly output?: Writable;
}

/**
 * Newline-delimited JSON-RPC stdio host. stdout carries only protocol messages;
 * requests run concurrently so waiting calls never block notifications/cancelled.
 */
export class StdioServerHost {
	readonly #server: McpServer;
	readonly #input: Readable;
	readonly #output: Writable;
	readonly #channels = new Map<RequestId, HostChannel>();
	readonly #inFlight = new Set<Promise<void>>();

	constructor(opts: StdioServerHostOptions) {
		this.#server = opts.server;
		this.#input = opts.input ?? process.stdin;
		this.#output = opts.output ?? process.stdout;
	}

	#write(message: unknown): void {
		this.#output.write(`${JSON.stringify(message)}\n`);
	}

	async listen(): Promise<void> {
		const rl = createInterface({ input: this.#input });
		for await (const line of rl) {
			if (line.trim() === "") continue;
			const classified = classifyInboundJson(line);
			if (classified.kind === "response") {
				continue; // Never reply to stray response envelopes (WIRE-DIR-2).
			}
			if (classified.kind === "bad") {
				this.#write(errorResponse(classified.id, new ServerError(classified.code, classified.message)));
				continue;
			}
			if (classified.kind === "notification") {
				this.#handleNotification(classified.msg);
				continue;
			}
			const request = classified.msg;
			if (request.method === "subscriptions/listen" || request.method === "events/stream") {
				this.#openStream(request);
				continue;
			}
			const task = (async () => {
				try {
					const result = await this.#server.handleRequest(request);
					if (!this.#server.wasCancelled(request.id)) this.#write(resultResponse(request.id, result));
				} catch (error) {
					if (!this.#server.wasCancelled(request.id)) this.#write(errorResponse(request.id, error));
				}
			})();
			this.#inFlight.add(task);
			void task.finally(() => this.#inFlight.delete(task));
		}
		await Promise.allSettled(this.#inFlight);
		for (const [id, channel] of [...this.#channels.entries()]) {
			channel.finish({
				resultType: "complete",
				_meta: {
					"io.modelcontextprotocol/subscriptionId": id,
					"io.modelcontextprotocol/serverInfo": this.#server.serverInfo,
				},
			});
		}
		this.#channels.clear();
	}

	#handleNotification(msg: JsonRpcNotification): void {
		this.#server.handleNotification(msg);
		if (msg.method === "notifications/cancelled") {
			const reqId = (msg.params as Obj | undefined)?.requestId;
			if (typeof reqId === "string" || typeof reqId === "number") {
				const ch = this.#channels.get(reqId);
				if (ch) {
					this.#channels.delete(reqId);
					ch.close();
				}
			}
		}
	}

	#openStream(request: JsonRpcRequest): void {
		if (this.#channels.has(request.id)) {
			this.#write(errorResponse(request.id, new ServerError(-32602, "duplicate active subscription id")));
			return;
		}
		const channel = new HostChannel(
			request.id,
			(notification) => this.#write(notification),
			(result) => {
				const existingMeta = typeof result._meta === "object" && result._meta !== null ? (result._meta as Obj) : {};
				this.#write(resultResponse(request.id, {
					...result,
					_meta: {
						...existingMeta,
						"io.modelcontextprotocol/subscriptionId": request.id,
						"io.modelcontextprotocol/serverInfo": this.#server.serverInfo,
					},
				}));
				this.#channels.delete(request.id);
			},
		);
		try {
			this.#server.validateStreamRequest(request);
			if (request.method === "subscriptions/listen") {
				const subscriptions = this.#server.subscriptions;
				if (!subscriptions) throw new ServerError(-32601, "subscriptions unavailable");
				const reqParams = (request.params ?? {}) as Obj;
				subscriptions.listen(channel, reqParams);
				const notifFilter = typeof reqParams.notifications === "object" && reqParams.notifications !== null
					? (reqParams.notifications as Obj)
					: undefined;
				const taskIds = Array.isArray(notifFilter?.taskIds)
					? notifFilter.taskIds.filter((id): id is string => typeof id === "string")
					: undefined;
				if (taskIds && taskIds.length > 0) this.#server.tasks?.attach(channel, taskIds);
			} else {
				const events = this.#server.events;
				if (!events) throw new ServerError(-32601, "events unavailable");
				events.stream(channel, (request.params ?? {}) as Obj);
			}
			this.#channels.set(request.id, channel);
		} catch (error) {
			channel.close();
			this.#write(errorResponse(request.id, error));
		}
	}
}
