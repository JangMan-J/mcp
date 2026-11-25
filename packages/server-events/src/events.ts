import { systemClock, type Clock } from "@mcp/core";
import { EventBus, type ServerOccurrence } from "./bus.js";
import type { SubscriptionsServer } from "./subscriptions.js";
import {
	notFoundError,
	notification,
	object,
	ServerError,
	streamKey,
	unsupportedError,
	type Obj,
	type PushChannel,
} from "./types.js";

export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";

export type EventDeliveryMode = "push" | "poll";

export interface EventDescriptor {
	readonly name: string;
	readonly description?: string;
	readonly delivery?: readonly EventDeliveryMode[];
	readonly inputSchema?: Obj;
	readonly payloadSchema?: Obj;
	readonly _meta?: Obj;
	/**
	 * Optional server-side filter over a shared `(name, {})` event log.
	 * When set, subscribers pass filter arguments in `params.arguments` while
	 * publishers emit once to `bus.publish(name, data)`.
	 */
	readonly filter?: (data: unknown, args: Obj) => boolean;
}

export interface EventsServerOptions {
	readonly bus?: EventBus;
	readonly events?: readonly EventDescriptor[];
	/** Reject unknown event names even when no descriptors were pre-registered. */
	readonly strictCatalog?: boolean;
	readonly subscriptions?: SubscriptionsServer;
	readonly listChanged?: boolean;
	/** Default heartbeat interval for live streams. Default 15000ms. */
	readonly heartbeatMs?: number;
	/** Floor for client-suggested heartbeatMs. Default min(1000, heartbeatMs). */
	readonly minHeartbeatMs?: number;
	/** Ceiling for client-suggested heartbeatMs. Default max(60000, heartbeatMs). */
	readonly maxHeartbeatMs?: number;
	/** Default max occurrences returned by one events/poll. Default 100. */
	readonly pageSize?: number;
	/** Hard cap on client-requested maxEvents. Default max(500, pageSize). */
	readonly maxPageSize?: number;
	/** Page size for events/list pagination. Default 100. */
	readonly listPageSize?: number;
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

function paginateItems<T>(items: readonly T[], cursor: unknown, pageSize: number): { items: T[]; nextCursor?: string } {
	let offset = 0;
	if (cursor !== undefined && cursor !== null) {
		if (typeof cursor !== "string" || !/^\d+$/u.test(cursor)) throw new ServerError(-32602, "invalid cursor");
		offset = Number.parseInt(cursor, 10);
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) {
			throw new ServerError(-32602, "invalid cursor");
		}
	}
	const page = items.slice(offset, offset + pageSize);
	return {
		items: page,
		...(offset + pageSize < items.length ? { nextCursor: String(offset + pageSize) } : {}),
	};
}

/**
 * Server side of io.modelcontextprotocol/events (SEP-3415): events/list,
 * events/poll, and live events/stream with active/event/heartbeat/terminated
 * notices. Webhook delivery returns -32026 Unsupported (deliveryMode=webhook).
 */
export class EventsServer {
	readonly bus: EventBus;
	readonly #catalog = new Map<string, EventDescriptor>();
	readonly #strictCatalog: boolean;
	readonly #subscriptions: SubscriptionsServer | undefined;
	readonly #listChanged: boolean;
	readonly #heartbeatMs: number;
	readonly #minHeartbeatMs: number;
	readonly #maxHeartbeatMs: number;
	readonly #pageSize: number;
	readonly #maxPageSize: number;
	readonly #listPageSize: number;
	readonly #nextPollMs: number;
	readonly #clock: Clock;
	readonly #live = new Set<LiveStream>();

	constructor(opts: EventsServerOptions = {}) {
		this.bus = opts.bus ?? new EventBus();
		this.#strictCatalog = opts.strictCatalog === true;
		this.#subscriptions = opts.subscriptions;
		this.#listChanged = opts.listChanged ?? opts.subscriptions !== undefined;
		this.#heartbeatMs = opts.heartbeatMs ?? 15_000;
		this.#minHeartbeatMs = opts.minHeartbeatMs ?? Math.min(1_000, this.#heartbeatMs);
		this.#maxHeartbeatMs = opts.maxHeartbeatMs ?? Math.max(60_000, this.#heartbeatMs);
		this.#pageSize = opts.pageSize ?? 100;
		this.#maxPageSize = opts.maxPageSize ?? Math.max(500, this.#pageSize);
		this.#listPageSize = opts.listPageSize ?? 100;
		this.#nextPollMs = opts.nextPollMs ?? 1_000;
		this.#clock = opts.clock ?? systemClock;
		for (const descriptor of opts.events ?? []) {
			this.#setDescriptor(descriptor);
		}
	}

	#setDescriptor(descriptor: EventDescriptor): void {
		if (!descriptor.name) throw new ServerError(-32602, "event name required");
		const delivery = descriptor.delivery ?? ["push", "poll"];
		if (delivery.length === 0) throw new ServerError(-32602, `event ${descriptor.name}: delivery must be non-empty`);
		this.#catalog.set(descriptor.name, { ...descriptor, delivery });
	}

	registerEvent(descriptor: EventDescriptor): this {
		this.#setDescriptor(descriptor);
		this.#subscriptions?.notifyEventsChanged();
		return this;
	}

	/** Remove an event descriptor and terminate active push streams with -32023 NotFound (SEP-3415). */
	unregisterEvent(name: string): boolean {
		const removed = this.#catalog.delete(name);
		if (removed) {
			const err = notFoundError("event", `event ${name} was removed`);
			this.terminate(name, undefined, { code: err.code, message: err.message, data: err.data });
			this.#subscriptions?.notifyEventsChanged();
		}
		return removed;
	}

	eventSchema(name: string): Obj | undefined {
		const desc = this.#catalog.get(name);
		if (!desc) return undefined;
		return {
			name: desc.name,
			...(desc.description !== undefined ? { description: desc.description } : {}),
			delivery: [...(desc.delivery ?? ["push", "poll"])],
			...(desc.inputSchema !== undefined ? { inputSchema: desc.inputSchema } : {}),
			...(desc.payloadSchema !== undefined ? { payloadSchema: desc.payloadSchema } : {}),
			...(desc._meta !== undefined ? { _meta: desc._meta } : {}),
		};
	}

	capabilities(): Obj {
		return {
			extensions: {
				[EVENTS_EXTENSION_ID]: {
					revision: "2026-07-28",
					listChanged: this.#listChanged,
				},
			},
		};
	}

	list(params: Obj = {}): Obj {
		const items: Obj[] = [...this.#catalog.values()]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((desc) => this.eventSchema(desc.name)!);
		for (const adhoc of this.bus.list()) {
			if (this.#catalog.has(adhoc.name)) continue;
			items.push({
				name: adhoc.name,
				delivery: ["push", "poll"],
				...(Object.keys(adhoc.arguments).length > 0 ? { arguments: adhoc.arguments } : {}),
			});
		}
		const page = paginateItems(items, params.cursor, this.#listPageSize);
		return {
			resultType: "complete",
			events: page.items,
			...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
		};
	}

	#resolveDescriptor(name: string, mode: "poll" | "push" | "webhook"): EventDescriptor | undefined {
		const desc = this.#catalog.get(name);
		if (!desc) {
			if (this.#strictCatalog || this.#catalog.size > 0) {
				throw notFoundError("event", `unknown event ${name}`);
			}
			if (mode === "webhook") {
				throw unsupportedError("deliveryMode", "webhook", `event ${name} does not support webhook delivery`);
			}
			return undefined;
		}
		if (mode === "webhook" || !(desc.delivery ?? ["push", "poll"]).includes(mode)) {
			throw unsupportedError("deliveryMode", mode, `event ${name} does not support ${mode} delivery`);
		}
		return desc;
	}

	/** Reject webhook subscribe/unsubscribe with SEP-3415 -32023 / -32026 codes. */
	unsupportedWebhook(params: Obj): never {
		const name = params.name;
		if (typeof name !== "string" || name === "") throw new ServerError(-32602, "events name required");
		this.#resolveDescriptor(name, "webhook");
		throw unsupportedError("deliveryMode", "webhook", `event ${name} does not support webhook delivery`);
	}

	poll(params: Obj): Obj {
		const { name, args, cursor, maxAgeMs, maxEvents } = readPollParams(params, this.#pageSize, this.#maxPageSize);
		const desc = this.#resolveDescriptor(name, "poll");
		const logArgs = desc?.filter ? {} : args;
		// SEP-3415: cursor: null means "start from now" (no backlog, fresh cursor).
		if (cursor === null) {
			return {
				resultType: "complete",
				events: [],
				cursor: this.bus.endCursor(name, logArgs),
				truncated: false,
				hasMore: false,
				nextPollMs: this.#nextPollMs,
			};
		}
		const page = this.bus.poll(name, logArgs, cursor, maxEvents, {
			...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
			...(desc?.filter ? { filter: desc.filter, filterArgs: args } : {}),
		});
		const events = page.events.map(({ cursor: _c, ...occurrence }) => occurrence);
		return {
			resultType: "complete",
			events,
			cursor: page.cursor,
			truncated: page.truncated,
			hasMore: page.hasMore,
			nextPollMs: page.hasMore ? 0 : this.#nextPollMs,
		};
	}

	/** Open a live stream on a host channel. Null cursor means "new events only". */
	stream(channel: PushChannel, params: Obj): void {
		const { name, args, cursor, maxAgeMs, heartbeatMs } = readStreamParams(
			params,
			this.#heartbeatMs,
			this.#minHeartbeatMs,
			this.#maxHeartbeatMs,
		);
		const desc = this.#resolveDescriptor(name, "push");
		const logArgs = desc?.filter ? {} : args;
		const pred = desc?.filter;

		let replay: ServerOccurrence[] = [];
		let truncated = false;
		let initialCursor: string;

		if (cursor === null) {
			initialCursor = this.bus.endCursor(name, logArgs);
		} else {
			let page = this.bus.poll(name, logArgs, cursor, this.#pageSize, {
				...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
				...(pred ? { filter: pred, filterArgs: args } : {}),
			});
			truncated = page.truncated;
			initialCursor = page.startCursor;
			for (;;) {
				replay.push(...page.events);
				if (!page.hasMore) break;
				const lastCursor = replay.length > 0 ? replay[replay.length - 1]!.cursor : page.cursor;
				page = this.bus.poll(name, logArgs, lastCursor, this.#pageSize, {
					...(pred ? { filter: pred, filterArgs: args } : {}),
				});
			}
		}

		const live: LiveStream = {
			channel,
			name,
			args,
			cursor: initialCursor,
			unsubscribe: () => {},
			stopHeartbeat: () => {},
		};

		const armHeartbeat = () => {
			live.stopHeartbeat();
			live.stopHeartbeat = this.#clock.setTimeout(() => {
				channel.notify(notification("notifications/events/heartbeat", { cursor: live.cursor }, channel.id));
				armHeartbeat();
			}, heartbeatMs);
		};

		const send = (event: ServerOccurrence, resetHb: boolean) => {
			live.cursor = event.cursor;
			if (pred && !pred(event.data, args)) return;
			channel.notify(notification("notifications/events/event", { ...event }, channel.id));
			if (resetHb) armHeartbeat();
		};

		channel.notify(notification("notifications/events/active", {
			heartbeatMs,
			cursor: live.cursor,
			truncated,
		}, channel.id));

		for (const event of replay) {
			send(event, false);
		}
		if (cursor !== null && replay.length === 0) {
			live.cursor = this.bus.endCursor(name, logArgs);
		}

		live.unsubscribe = this.bus.subscribe(name, logArgs, (event) => send(event, true));
		armHeartbeat();
		this.#live.add(live);
		channel.onClose(() => this.#close(live));
	}

	/** Terminate live streams, optionally scoped to name (and optionally exact arguments). */
	terminate(name?: string, args?: Obj, error?: unknown): void {
		const targetKey = name !== undefined && args !== undefined ? streamKey(name, args) : undefined;
		for (const live of [...this.#live]) {
			if (name !== undefined && live.name !== name) continue;
			if (targetKey !== undefined && streamKey(live.name, live.args) !== targetKey) continue;
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
	const args = params.arguments === undefined || params.arguments === null ? {} : params.arguments;
	if (!object(args)) throw new ServerError(-32602, "events arguments must be an object");
	const cursor = params.cursor;
	if (cursor !== undefined && cursor !== null && typeof cursor !== "string") {
		throw new ServerError(-32602, "events cursor must be a string or null");
	}
	return { name: params.name, args, cursor: cursor ?? null };
}

function readMaxAgeMs(params: Obj): number | undefined {
	const raw = params.maxAgeMs;
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
		throw new ServerError(-32602, "events maxAgeMs must be a non-negative integer");
	}
	return raw;
}

function readPollParams(params: Obj, defaultMax: number, hardMax: number): {
	name: string;
	args: Obj;
	cursor: string | null;
	maxAgeMs?: number;
	maxEvents: number;
} {
	const base = readSubscription(params);
	const maxAgeMs = readMaxAgeMs(params);
	const rawMax = params.maxEvents;
	let maxEvents = defaultMax;
	if (rawMax !== undefined && rawMax !== null) {
		if (typeof rawMax !== "number" || !Number.isSafeInteger(rawMax) || rawMax < 1) {
			throw new ServerError(-32602, "events maxEvents must be a positive integer");
		}
		maxEvents = Math.min(rawMax, hardMax);
	}
	return { ...base, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}), maxEvents };
}

function readStreamParams(
	params: Obj,
	defaultHeartbeatMs: number,
	minHeartbeatMs: number,
	maxHeartbeatMs: number,
): {
	name: string;
	args: Obj;
	cursor: string | null;
	maxAgeMs?: number;
	heartbeatMs: number;
} {
	const base = readSubscription(params);
	const maxAgeMs = readMaxAgeMs(params);
	const rawHb = params.heartbeatMs;
	let heartbeatMs = defaultHeartbeatMs;
	if (rawHb !== undefined && rawHb !== null) {
		if (typeof rawHb !== "number" || !Number.isSafeInteger(rawHb) || rawHb < 1) {
			throw new ServerError(-32602, "events heartbeatMs must be a positive integer");
		}
		heartbeatMs = Math.min(Math.max(rawHb, minHeartbeatMs), maxHeartbeatMs);
	}
	return { ...base, ...(maxAgeMs !== undefined ? { maxAgeMs } : {}), heartbeatMs };
}
