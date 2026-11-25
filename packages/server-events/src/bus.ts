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
	readonly cursor: string;
	readonly truncated: boolean;
	readonly hasMore: boolean;
}

interface Log {
	readonly name: string;
	readonly args: Obj;
	seq: number;
	events: ServerOccurrence[];
}

export interface EventBusOptions {
	/** Retained occurrences per name+arguments stream. Default 1000. */
	readonly retain?: number;
	readonly clock?: Clock;
	readonly idGenerator?: () => string;
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
	readonly #logs = new Map<string, Log>();
	readonly #listeners = new Map<string, Set<(event: ServerOccurrence) => void>>();

	constructor(opts: EventBusOptions = {}) {
		this.#retain = opts.retain ?? 1000;
		this.#clock = opts.clock ?? systemClock;
		this.#idGenerator = opts.idGenerator ?? randomUUID;
	}

	list(): Array<{ name: string; arguments: Obj }> {
		return [...this.#logs.values()].map((log) => ({ name: log.name, arguments: log.args }));
	}

	#log(name: string, args: Obj): Log {
		const key = streamKey(name, args);
		let log = this.#logs.get(key);
		if (!log) {
			log = { name, args, seq: 0, events: [] };
			this.#logs.set(key, log);
		}
		return log;
	}

	publish(name: string, data: unknown, args: Obj = {}): ServerOccurrence {
		const log = this.#log(name, args);
		log.seq += 1;
		const event: ServerOccurrence = {
			eventId: this.#idGenerator(),
			name,
			timestamp: new Date(this.#clock.now()).toISOString(),
			data,
			cursor: String(log.seq),
		};
		log.events.push(event);
		if (log.events.length > this.#retain) log.events.splice(0, log.events.length - this.#retain);
		for (const fn of this.#listeners.get(streamKey(name, args)) ?? []) fn(event);
		return event;
	}

	/** Current end cursor: subscribers starting here receive only new events. */
	endCursor(name: string, args: Obj = {}): string {
		return String(this.#log(name, args).seq);
	}

	poll(name: string, args: Obj, cursor: string | null, limit: number): PollPage {
		const log = this.#log(name, args);
		const after = cursor === null ? 0 : Number.parseInt(cursor, 10);
		if (!Number.isSafeInteger(after) || after < 0) throw new Error("invalid events cursor");
		const oldest = log.events.length > 0 ? Number.parseInt(log.events[0]!.cursor, 10) : log.seq + 1;
		const truncated = after > 0 && after + 1 < oldest;
		const matched = log.events.filter((e) => Number.parseInt(e.cursor, 10) > after);
		const events = matched.slice(0, limit);
		return {
			events,
			cursor: events.length > 0 ? events[events.length - 1]!.cursor : String(log.seq),
			truncated,
			hasMore: matched.length > events.length,
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
