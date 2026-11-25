import { notification, object, ServerError, type Obj, type PushChannel } from "./types.js";

export interface SubscriptionCapabilities {
	readonly tools?: { readonly listChanged?: boolean };
	readonly prompts?: { readonly listChanged?: boolean };
	readonly resources?: { readonly listChanged?: boolean; readonly subscribe?: boolean };
}

interface Listener {
	readonly channel: PushChannel;
	readonly granted: {
		toolsListChanged?: true;
		promptsListChanged?: true;
		resourcesListChanged?: true;
		resourceSubscriptions?: string[];
	};
}

/**
 * Standard MCP subscriptions/listen: capability-filtered grants, ack-first,
 * list_changed and resource-updated fanout, and graceful stream completion.
 * The host calls notify* when its own tools/prompts/resources change.
 */
export class SubscriptionsServer {
	readonly #capabilities: SubscriptionCapabilities;
	readonly #listeners = new Map<PushChannel["id"], Listener>();

	constructor(opts: { readonly capabilities?: SubscriptionCapabilities } = {}) {
		this.#capabilities = opts.capabilities ?? {};
	}

	capabilities(): Obj {
		return { ...this.#capabilities };
	}

	listen(channel: PushChannel, params: Obj): void {
		const requested = object(params.notifications) ? params.notifications : {};
		const granted: Listener["granted"] = {};
		const offered: Obj = {};
		const kinds = ["tools", "prompts", "resources"] as const;
		for (const kind of kinds) {
			const key = `${kind}ListChanged` as const;
			if (requested[key] !== true) continue;
			const supported = this.#capabilities[kind]?.listChanged === true;
			offered[key] = supported;
			if (supported) granted[key] = true;
		}
		if (Array.isArray(requested.resourceSubscriptions)) {
			const uris = requested.resourceSubscriptions.filter((u): u is string => typeof u === "string");
			if (this.#capabilities.resources?.subscribe === true) {
				granted.resourceSubscriptions = [...new Set(uris)];
				offered.resourceSubscriptions = granted.resourceSubscriptions;
			} else {
				offered.resourceSubscriptions = [];
			}
		}
		this.#listeners.set(channel.id, { channel, granted });
		// Ack is always the first message on a listen stream.
		channel.notify(notification("notifications/subscriptions/acknowledged", { notifications: offered }, channel.id));
		channel.onClose(() => this.#listeners.delete(channel.id));
	}

	/** Gracefully end a listen stream (server shutdown or filter replacement). */
	end(channel: PushChannel): void {
		this.#listeners.delete(channel.id);
		channel.finish({ resultType: "complete", _meta: { "io.modelcontextprotocol/subscriptionId": channel.id } });
	}

	notifyToolsChanged(): void {
		this.#fanout("toolsListChanged", "notifications/tools/list_changed");
	}
	notifyPromptsChanged(): void {
		this.#fanout("promptsListChanged", "notifications/prompts/list_changed");
	}
	notifyResourcesChanged(): void {
		this.#fanout("resourcesListChanged", "notifications/resources/list_changed");
	}
	notifyResourceUpdated(uri: string): void {
		for (const listener of this.#listeners.values()) {
			if (listener.granted.resourceSubscriptions?.includes(uri)) {
				listener.channel.notify(notification("notifications/resources/updated", { uri }, listener.channel.id));
			}
		}
	}

	#fanout(grant: "toolsListChanged" | "promptsListChanged" | "resourcesListChanged", method: string): void {
		for (const listener of this.#listeners.values()) {
			if (listener.granted[grant]) listener.channel.notify(notification(method, {}, listener.channel.id));
		}
	}
}

export function requireTaskId(params: Obj): string {
	if (typeof params.taskId !== "string" || params.taskId === "") throw new ServerError(-32602, "taskId required");
	return params.taskId;
}
