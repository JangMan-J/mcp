import { randomUUID } from "node:crypto";
import { notFoundError, type EventsServer } from "@mcp/server-events";

export interface SessionHandleEntry<T> {
	readonly handle: string;
	readonly key?: string;
	readonly state: T;
}

export interface SessionHandleRegistryOptions<T> {
	readonly events?: EventsServer;
	readonly idGenerator?: () => string;
	readonly onClose?: (entry: SessionHandleEntry<T>, reason: string) => void;
}

/**
 * SEP-2567 explicit application session handle table for stateless 2026-07-28
 * servers: mints opaque handles, supersedes prior handles sharing a key,
 * resolves handles with -32023 NotFound (kind: "session"), and terminates
 * matching SEP-3415 push streams on close.
 */
export class SessionHandleRegistry<T> {
	readonly #byHandle = new Map<string, SessionHandleEntry<T>>();
	readonly #byKey = new Map<string, string>();
	readonly #events: EventsServer | undefined;
	readonly #idGenerator: () => string;
	readonly #onClose: ((entry: SessionHandleEntry<T>, reason: string) => void) | undefined;

	constructor(opts: SessionHandleRegistryOptions<T> = {}) {
		this.#events = opts.events;
		this.#idGenerator = opts.idGenerator ?? (() => `sess_${randomUUID()}`);
		this.#onClose = opts.onClose;
	}

	register(state: T, key?: string): SessionHandleEntry<T> {
		if (key !== undefined) {
			const existing = this.#byKey.get(key);
			if (existing !== undefined) this.close(existing, "superseded");
		}
		const handle = this.#idGenerator();
		const entry: SessionHandleEntry<T> = {
			handle,
			...(key !== undefined ? { key } : {}),
			state,
		};
		this.#byHandle.set(handle, entry);
		if (key !== undefined) this.#byKey.set(key, handle);
		return entry;
	}

	get(handle: unknown): SessionHandleEntry<T> | undefined {
		if (typeof handle !== "string" || handle === "") return undefined;
		return this.#byHandle.get(handle);
	}

	require(handle: unknown): SessionHandleEntry<T> {
		const found = this.get(handle);
		if (!found) {
			throw notFoundError("session", `unknown or expired session handle ${String(handle ?? "")}`);
		}
		return found;
	}

	close(handle: string, reason = "session closed"): boolean {
		const entry = this.#byHandle.get(handle);
		if (!entry) return false;
		this.#byHandle.delete(handle);
		if (entry.key !== undefined && this.#byKey.get(entry.key) === handle) {
			this.#byKey.delete(entry.key);
		}
		if (this.#events) {
			const err = notFoundError("session", "NotFound", { reason });
			for (const ev of (this.#events.list().events as Array<{ name?: unknown }> | undefined) ?? []) {
				if (typeof ev?.name === "string") {
					this.#events.terminate(ev.name, { session: handle }, { code: err.code, message: err.message, data: err.data });
				}
			}
		}
		this.#onClose?.(entry, reason);
		return true;
	}

	get size(): number {
		return this.#byHandle.size;
	}
}
