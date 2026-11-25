import type { EventBus } from "./bus.js";
import { notification, type Obj, type PushChannel } from "./types.js";

/**
 * Notices are application events, not the deprecated MCP Logging feature.
 * Publish them on a named event stream (default "notices") so clients receive
 * them through the same push path as everything else.
 */
export class Notices {
	constructor(
		private readonly bus: EventBus,
		private readonly stream = "notices",
	) {}

	info(message: string, data?: unknown): void {
		this.bus.publish(this.stream, { level: "info", message, ...(data !== undefined ? { data } : {}) });
	}
	warn(message: string, data?: unknown): void {
		this.bus.publish(this.stream, { level: "warning", message, ...(data !== undefined ? { data } : {}) });
	}
	error(message: string, data?: unknown): void {
		this.bus.publish(this.stream, { level: "error", message, ...(data !== undefined ? { data } : {}) });
	}
}

/** Request-scoped progress notice (not on the subscriptions/listen stream). */
export function sendProgress(
	channel: PushChannel,
	progress: { readonly progressToken: string | number; readonly progress: number; readonly total?: number; readonly message?: string },
): void {
	channel.notify(notification("notifications/progress", { ...progress }));
}

/** Request-scoped custom notice. Do not use for list_changed or events traffic. */
export function sendNotice(channel: PushChannel, method: string, params: Obj = {}): void {
	channel.notify(notification(method, params));
}
