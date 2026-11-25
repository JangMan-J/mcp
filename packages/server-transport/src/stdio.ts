import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { JsonRpcNotification, JsonRpcRequest, RequestId } from "@mcp/core";
import type { McpServer } from "@mcp/server";
import type { Obj } from "@mcp/server-events";
import { errorResponse, HostChannel, resultResponse } from "./channel.js";

export interface StdioServerHostOptions {
	readonly server: McpServer;
	readonly input?: Readable;
	readonly output?: Writable;
}

/**
 * Newline-delimited JSON-RPC stdio host. stdout carries only protocol messages;
 * requests, notifications/cancelled, subscriptions/listen, and events/stream.
 */
export class StdioServerHost {
	readonly #server: McpServer;
	readonly #input: Readable;
	readonly #output: Writable;
	readonly #channels = new Map<RequestId, HostChannel>();

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
			let msg: JsonRpcRequest | JsonRpcNotification;
			try {
				msg = JSON.parse(line) as JsonRpcRequest;
			} catch {
				continue; // malformed input is not a protocol message
			}
			if (Array.isArray(msg) || typeof msg !== "object" || msg === null) continue;
			if (!("id" in msg)) {
				this.#server.handleNotification(msg as JsonRpcNotification);
				continue;
			}
			const request = msg as JsonRpcRequest;
			if (request.method === "subscriptions/listen" || request.method === "events/stream") {
				this.#openStream(request);
				continue;
			}
			try {
				const result = await this.#server.handleRequest(request);
				if (!this.#server.wasCancelled(request.id)) this.#write(resultResponse(request.id, result));
			} catch (error) {
				if (!this.#server.wasCancelled(request.id)) this.#write(errorResponse(request.id, error));
			}
		}
		for (const channel of this.#channels.values()) channel.close();
		this.#channels.clear();
	}

	#openStream(request: JsonRpcRequest): void {
		const channel = new HostChannel(
			request.id,
			(notification) => this.#write(notification),
			(result) => {
				this.#write(resultResponse(request.id, result));
				this.#channels.delete(request.id);
			},
		);
		this.#channels.set(request.id, channel);
		try {
			if (request.method === "subscriptions/listen") {
				const subscriptions = this.#server.subscriptions;
				if (!subscriptions) throw new Error("subscriptions unavailable");
				subscriptions.listen(channel, (request.params ?? {}) as Obj);
				this.#server.tasks?.attach(channel);
			} else {
				const events = this.#server.events;
				if (!events) throw new Error("events unavailable");
				events.stream(channel, (request.params ?? {}) as Obj);
			}
		} catch (error) {
			this.#channels.delete(request.id);
			this.#write(errorResponse(request.id, error));
		}
	}
}
