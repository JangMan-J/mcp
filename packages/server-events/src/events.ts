import { systemClock, type Clock } from "@mcp/core";
import { EventBus, type ServerOccurrence } from "./bus.js";
import { notification, object, ServerError, type Obj, type PushChannel } from "./types.js";

export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";

export interface EventsServerOptions {
	readonly bus?: EventBus;
	/** Heartbeat interval for live streams. Default 15000ms. */
	readonly heartbeatMs?: number;
	/** Max occurrences returned by one events/poll. Default 100. */
	readonly pageSize?: number;
	/** Suggested delay for empty polls. Default 1000ms. */
	readonly nextPollMs?: number;
	readonly clock?: Clock;
}

interface LiveStream {
	readonly channel: PushChannel;
	readonly name: string;
	readonly args: Obj;
	cursor: string;
	unsubscribe: () => void;
	stopHeartbeat: () => void;
}

/**
 * Server side of io.modelcontextprotocol/events: events/list, events/poll,
 * and live events/stream with active/event/heartbeat/terminated notices.
 * Webhook delivery (events/subscribe with a URL) is intentionally out of scope.
 */
export class EventsServer {
	readonly bus: EventBus;
	readonly #heartbeatMs: number;
	readonly #pageSize: number;
	readonly #nextPollMs: number;
	readonly #clock: Clock;
	readonly #live = new Set<LiveStream>();

	constructor(opts: EventsServerOptions = {}) {
		this.bus = opts.bus ?? new EventBus();
		this.#heartbeatMs = opts.heartbeatMs ?? 15_000;
		this.#pageSize = opts.pageSize ?? 100;
		this.#nextPollMs = opts.nextPollMs ?? 1000;
		this.#clock = opts.clock ?? systemClock;
	}

	capabilities(): Obj {
		return { extensions: { [EVENTS_EXTENSION_ID]: { revision: "2026-07-28", listChanged: true } } };
	}

	list(): Obj {
		return { events: this.bus.list() };
	}

	poll(params: Obj): Obj {
		const { name, args, cursor } = readSubscription(params);
		const page = this.bus.poll(name, args, cursor, this.#pageSize);
		return {
			events: page.events,
			cursor: page.cursor,
			...(page.truncated ? { truncated: true } : {}),
			...(page.hasMore ? { hasMore: true } : {}),
			nextPollMs: page.hasMore ? 0 : this.#nextPollMs,
		};
	}

	/** Open a live stream on a host channel. Null cursor means "new events only". */
	stream(channel: PushChannel, params: Obj): void {
		const { name, args, cursor } = readSubscription(params);
		const live: LiveStream = {
			channel,
			name,
			args,
			cursor: cursor ?? this.bus.endCursor(name, args),
			unsubscribe: () => {},
			stopHeartbeat: () => {},
		};
		const send = (event: ServerOccurrence) => {
			live.cursor = event.cursor;
			channel.notify(notification("notifications/events/event", { ...event }, channel.id));
		};
		const truncated = cursor !== null && this.bus.poll(name, args, cursor, 1).truncated;
		channel.notify(notification("notifications/events/active", {
			heartbeatMs: this.#heartbeatMs,
			cursor: live.cursor,
			...(truncated ? { truncated: true } : {}),
		}, channel.id));
		if (cursor !== null) {
			// Replay retained occurrences after the cursor, then continue live.
			let page = this.bus.poll(name, args, cursor, this.#pageSize);
			for (;;) {
				for (const event of page.events) send(event);
				if (!page.hasMore) break;
				page = this.bus.poll(name, args, live.cursor, this.#pageSize);
			}
		}
		live.unsubscribe = this.bus.subscribe(name, args, send);
		const heartbeat = () => {
			channel.notify(notification("notifications/events/heartbeat", { cursor: live.cursor }, channel.id));
			live.stopHeartbeat = this.#clock.setTimeout(heartbeat, this.#heartbeatMs);
		};
		live.stopHeartbeat = this.#clock.setTimeout(heartbeat, this.#heartbeatMs);
		this.#live.add(live);
		channel.onClose(() => this.#close(live));
	}

	/** Terminate every live stream, optionally only one name+arguments stream. */
	terminate(name?: string, args: Obj = {}, error?: unknown): void {
		for (const live of [...this.#live]) {
			if (name !== undefined && (live.name !== name || live.args !== args)) continue;
			live.channel.notify(notification("notifications/events/terminated", { ...(error !== undefined ? { error } : {}) }, live.channel.id));
			this.#close(live);
		}
	}

	#close(live: LiveStream): void {
		live.unsubscribe();
		live.stopHeartbeat();
		this.#live.delete(live);
	}
}

export function readSubscription(params: Obj): { name: string; args: Obj; cursor: string | null } {
	if (typeof params.name !== "string" || params.name === "") throw new ServerError(-32602, "events name required");
	const args = params.arguments === undefined ? {} : params.arguments;
	if (!object(args)) throw new ServerError(-32602, "events arguments must be an object");
	const cursor = params.cursor;
	if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
		throw new ServerError(-32602, "events cursor must be a string or null");
	}
	return { name: params.name, args, cursor: cursor ?? null };
}
