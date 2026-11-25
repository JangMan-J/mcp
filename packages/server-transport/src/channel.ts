import type { JsonRpcErrorResponse, JsonRpcNotification, JsonRpcResponse, RequestId } from "@mcp/core";
import { ServerError, type Obj, type PushChannel } from "@mcp/server-events";

export function resultResponse(id: RequestId, result: Obj): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: RequestId, error: unknown): JsonRpcErrorResponse {
	if (error instanceof ServerError) {
		return {
			jsonrpc: "2.0",
			id,
			error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) },
		};
	}
	return { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
}

/** Host channel: fanout notifications and one final result, with close cleanup. */
export class HostChannel implements PushChannel {
	readonly #closers: Array<() => void> = [];
	closed = false;

	constructor(
		readonly id: RequestId,
		private readonly sendNotification: (notification: JsonRpcNotification) => void,
		private readonly sendResult: (result: Obj) => void,
	) {}

	notify(notification: JsonRpcNotification): void {
		if (!this.closed) this.sendNotification(notification);
	}

	finish(result: Obj): void {
		if (this.closed) return;
		this.sendResult(result);
		this.close();
	}

	onClose(fn: () => void): void {
		this.#closers.push(fn);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const fn of this.#closers) fn();
	}
}
