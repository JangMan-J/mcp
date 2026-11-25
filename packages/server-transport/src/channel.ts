import type { JsonRpcErrorResponse, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, RequestId } from "@mcp/core";
import { object, ServerError, type Obj, type PushChannel } from "@mcp/server-events";

export function resultResponse(id: RequestId, result: Obj): JsonRpcResponse {
	return { jsonrpc: "2.0", id, result };
}

export function errorResponse(id: RequestId | null, error: unknown): JsonRpcErrorResponse {
	if (error instanceof ServerError) {
		return {
			jsonrpc: "2.0",
			id,
			error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) },
		};
	}
	return { jsonrpc: "2.0", id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
}

export type ClassifiedInbound =
	| { readonly kind: "request"; readonly msg: JsonRpcRequest }
	| { readonly kind: "notification"; readonly msg: JsonRpcNotification }
	| { readonly kind: "response" }
	| { readonly kind: "bad"; readonly id: RequestId | null; readonly code: number; readonly message: string };

function validRequestId(id: unknown): id is RequestId {
	if (typeof id === "string") return id.length > 0;
	if (typeof id === "number") return Number.isSafeInteger(id);
	return false;
}

export function classifyInboundJson(text: string): ClassifiedInbound {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			kind: "bad",
			id: null,
			code: -32700,
			message: error instanceof Error ? error.message : "parse error",
		};
	}
	return classifyInboundValue(parsed);
}

export function classifyInboundValue(parsed: unknown): ClassifiedInbound {
	if (!object(parsed)) {
		return { kind: "bad", id: null, code: -32600, message: "expected a JSON-RPC request object" };
	}
	const hasId = "id" in parsed;
	const rawId = parsed.id;
	const idForError: RequestId | null = validRequestId(rawId) ? rawId : null;
	if (!("method" in parsed) || parsed.method === undefined) {
		if (hasId && ("result" in parsed || "error" in parsed)) {
			return { kind: "response" };
		}
		return { kind: "bad", id: idForError, code: -32600, message: "expected method to be a string" };
	}
	if (typeof parsed.method !== "string" || parsed.method.length === 0) {
		return { kind: "bad", id: idForError, code: -32600, message: "expected method to be a non-empty string" };
	}
	if (parsed.params !== undefined && !object(parsed.params)) {
		return { kind: "bad", id: idForError, code: -32602, message: "expected params to be an object" };
	}
	if (!hasId) {
		return {
			kind: "notification",
			msg: {
				jsonrpc: "2.0",
				method: parsed.method,
				...(parsed.params !== undefined ? { params: parsed.params } : {}),
			},
		};
	}
	if (!validRequestId(rawId)) {
		return { kind: "bad", id: null, code: -32600, message: "expected id to be a non-empty string or integer" };
	}
	return {
		kind: "request",
		msg: {
			jsonrpc: "2.0",
			id: rawId,
			method: parsed.method,
			...(parsed.params !== undefined ? { params: parsed.params } : {}),
		},
	};
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
