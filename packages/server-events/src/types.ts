import type { JsonRpcNotification, RequestId } from "@mcp-client/core";

export type Obj = Record<string, unknown>;

/**
 * Host-owned channel for one long-lived server response stream.
 * The host transport creates one per subscriptions/listen or events/stream
 * request and delivers notifications/final results to the client.
 */
export interface PushChannel {
	readonly id: RequestId;
	notify(notification: JsonRpcNotification): void;
	/** Final JSON-RPC result for the stream request (graceful close). */
	finish(result: Obj): void;
	/** Register cleanup for client disconnect/cancel. */
	onClose(fn: () => void): void;
}

/** Error with a JSON-RPC code, for hosts to map onto error responses. */
export class ServerError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "ServerError";
	}
}

export function notification(method: string, params: Obj, subscriptionId?: RequestId): JsonRpcNotification {
	return {
		jsonrpc: "2.0",
		method,
		params: subscriptionId === undefined
			? params
			: { ...params, _meta: { "io.modelcontextprotocol/subscriptionId": subscriptionId } },
	};
}

export function object(x: unknown): x is Obj {
	return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Deterministic key for name+arguments subscription identity. */
export function streamKey(name: string, args: Obj): string {
	const stable = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(stable);
		if (object(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
		return v;
	};
	return JSON.stringify([name, stable(args)]);
}
