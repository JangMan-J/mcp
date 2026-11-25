import type { JsonRpcNotification, RequestId } from "@mcp-client/core";
import type { Obj, PushChannel } from "../src/types.js";

export class FakeChannel implements PushChannel {
	readonly notifications: JsonRpcNotification[] = [];
	result: Obj | undefined;
	readonly #closers: Array<() => void> = [];

	constructor(readonly id: RequestId) {}

	notify(notification: JsonRpcNotification): void {
		this.notifications.push(notification);
	}

	finish(result: Obj): void {
		this.result = result;
	}

	onClose(fn: () => void): void {
		this.#closers.push(fn);
	}

	close(): void {
		for (const fn of this.#closers) fn();
	}

	methods(): string[] {
		return this.notifications.map((n) => n.method);
	}
}
