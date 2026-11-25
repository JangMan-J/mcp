import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "@mcp/core";
import { streamKey, type Obj } from "./types.js";

export interface ServerOccurrence {
	readonly eventId: string;
	readonly name: string;
	readonly timestamp: string;
	readonly data: unknown;
	readonly cursor: string;
}

export interface PollPage {
	readonly events: readonly ServerOccurrence[];
	/** Cursor at the start of the resolved window (used by events/stream active). */
	readonly startCursor: string;
	readonly cursor: string;
	readonly truncated: boolean;
	readonly hasMore: boolean;
}

export interface EventStore {
	load(streamKey: string): readonly ServerOccurrence[];
	append(streamKey: string, event: ServerOccurrence): void;
}

export interface PublishOptions {
	readonly eventId?: string;
	readonly timestamp?: string;
}

export interface PollWindowOptions {
	readonly maxAgeMs?: number;
	readonly filter?: (data: unknown, args: Obj) => boolean;
	readonly filterArgs?: Obj;
}

interface Log {
	readonly name: string;
	readonly args: Obj;
	seq: number;
	evicted: boolean;
	events: ServerOccurrence[];
	readonly index: Map<string, number>;
}

export interface EventBusOptions {
	/** Retained occurrences per name+arguments stream. Default 1000. */
	readonly retain?: number;
	readonly clock?: Clock;
	readonly idGenerator?: () => string;
	readonly store?: EventStore;
}

/**
 * Named, argument-scoped event logs with opaque cursors and bounded retention.
 * Transport-independent: EventsServer and TaskCenter publish into this bus;
 * hosts can also publish directly for application events/notices.
 */
export class EventBus {
	readonly #retain: number;
	readonly #clock: Clock;
	readonly #idGenerator: () => string;
	readonly #store: EventStore | undefined;
	readonly #logs = new Map<string, Log>();
	readonly #listeners = new Map<string, Set<(event: ServerOccurrence) => void>>();

	constructor(opts: EventBusOptions = {}) {
		this.#retain = opts.retain ?? 1000;
		this.#clock = opts.clock ?? systemClock;
		this.#idGenerator = opts.idGenerator ?? randomUUID;
		this.#store = opts.store;
	}

	list(): Array<{ name: string; arguments: Obj }> {
		return [...this.#logs.values()].map((log) => ({ name: log.name, arguments: log.args }));
	}

	#rebuildIndex(log: Log): void {
		log.index.clear();
		for (let i = 0; i < log.events.length; i++) {
			log.index.set(log.events[i]!.cursor, i);
		}
	}

	#log(name: string, args: Obj): Log {
		const key = streamKey(name, args);
		let log = this.#logs.get(key);
		if (!log) {
			const loaded = this.#store ? [...this.#store.load(key)] : [];
			let seq = 0;
			for (const e of loaded) {
				const parsed = Number.parseInt(e.cursor, 10);
				if (Number.isSafeInteger(parsed) && parsed > seq) seq = parsed;
				else seq += 1;
			}
			let evicted = false;
			if (loaded.length > this.#retain) {
				loaded.splice(0, loaded.length - this.#retain);
				evicted = true;
			}
			log = { name, args, seq, evicted, events: loaded, index: new Map() };
			this.#rebuildIndex(log);
			this.#logs.set(key, log);
		}
		return log;
	}

	publish(name: string, data: unknown, args: Obj = {}, opts?: PublishOptions): ServerOccurrence {
		const key = streamKey(name, args);
		const log = this.#log(name, args);
		log.seq += 1;
		const event: ServerOccurrence = {
			eventId: opts?.eventId ?? this.#idGenerator(),
			name,
			timestamp: opts?.timestamp ?? new Date(this.#clock.now()).toISOString(),
			data,
			cursor: String(log.seq),
		};
		this.#store?.append(key, event);
		log.events.push(event);
		if (log.events.length > this.#retain) {
			log.events.splice(0, log.events.length - this.#retain);
			log.evicted = true;
			this.#rebuildIndex(log);
		} else {
			log.index.set(event.cursor, log.events.length - 1);
		}
		for (const fn of this.#listeners.get(key) ?? []) fn(event);
		return event;
	}

	/** Current end cursor: subscribers starting here receive only new events. */
	endCursor(name: string, args: Obj = {}): string {
		const log = this.#log(name, args);
		return log.events.length > 0 ? log.events[log.events.length - 1]!.cursor : String(log.seq);
	}

	poll(name: string, args: Obj, cursor: string | null, limit: number, opts?: PollWindowOptions): PollPage {
		const log = this.#log(name, args);
		const tail = log.events.length > 0 ? log.events[log.events.length - 1]!.cursor : String(log.seq);
		let start = 0;
		let truncated = false;

		if (cursor === null || cursor === "0") {
			start = 0;
		} else {
			const idx = log.index.get(cursor);
			if (idx !== undefined) {
				start = idx + 1;
			} else if (/^\d+$/u.test(cursor)) {
				const num = Number.parseInt(cursor, 10);
				const oldest = log.events.length > 0 ? Number.parseInt(log.events[0]!.cursor, 10) : log.seq + 1;
				if (Number.isSafeInteger(num) && num > 0 && num < oldest) {
					// Cursor precedes retained floor: truncated only when at least one intermediate item was evicted.
					start = 0;
					truncated = num + 1 < oldest || (log.events.length === 0 && log.evicted);
				} else {
					// Unknown cursor ahead of or outside log: reset to tail with truncated: true (SEP-3415).
					return { events: [], startCursor: tail, cursor: tail, truncated: true, hasMore: false };
				}
			} else {
				// Unknown opaque cursor: reset to tail with truncated: true (SEP-3415).
				return { events: [], startCursor: tail, cursor: tail, truncated: true, hasMore: false };
			}
		}

		if (opts?.maxAgeMs !== undefined) {
			const floor = this.#clock.now() - opts.maxAgeMs;
			while (start < log.events.length) {
				const ts = Date.parse(log.events[start]!.timestamp);
				if (!Number.isNaN(ts) && ts >= floor) break;
				start += 1;
				truncated = true;
			}
		}

		const startCursor = start === 0 ? "0" : log.events[start - 1]!.cursor;
		const matched: ServerOccurrence[] = [];
		let lastMatchedIdx: number | undefined;
		let hasMore = false;
		const pred = opts?.filter;
		const filterArgs = opts?.filterArgs ?? args;

		for (let i = start; i < log.events.length; i++) {
			const entry = log.events[i]!;
			if (pred && !pred(entry.data, filterArgs)) continue;
			if (matched.length === limit) {
				hasMore = true;
				break;
			}
			matched.push(entry);
			lastMatchedIdx = i;
		}

		const nextCursor = hasMore
			? (lastMatchedIdx !== undefined ? log.events[lastMatchedIdx]!.cursor : startCursor)
			: start < log.events.length
				? tail
				: startCursor === "0" && cursor !== null && cursor !== "0"
					? cursor
					: tail;

		return {
			events: matched,
			startCursor,
			cursor: matched.length > 0 && hasMore ? nextCursor : (matched.length > 0 ? (hasMore ? nextCursor : tail) : nextCursor),
			truncated,
			hasMore,
		};
	}

	/** Live subscription; returns an unsubscribe function. */
	subscribe(name: string, args: Obj, fn: (event: ServerOccurrence) => void): () => void {
		const key = streamKey(name, args);
		let set = this.#listeners.get(key);
		if (!set) {
			set = new Set();
			this.#listeners.set(key, set);
		}
		set.add(fn);
		return () => {
			set.delete(fn);
			if (set.size === 0) this.#listeners.delete(key);
		};
	}
}
