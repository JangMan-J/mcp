/**
 * Push-first events facade over @mcp/ext-events.
 *
 * subscribe() returns an AsyncIterable of occurrences backed by the live
 * events/stream (with heartbeat + reconnect); poll() is available explicitly
 * for servers or callers that prefer pull.
 */
import { NotificationQueue, type McpClient } from "@mcp/core";
import {
	createEventsExtension,
	EventsClient,
	type Obj,
	type Occurrence,
} from "@mcp/ext-events";

export type EventsPollResult = Awaited<ReturnType<EventsClient["poll"]>>;

export interface EventSubscription extends AsyncIterable<Occurrence> {
	readonly name: string;
	/** Explicit pull; the async iterable itself is push-based. */
	poll(): Promise<EventsPollResult>;
	close(): Promise<void>;
}

export interface Events {
	/** List event streams offered by the server. */
	list(): Promise<Obj>;
	/** Subscribe to a named event stream; iterate to receive pushed occurrences. */
	subscribe(name: string, args?: Obj): Promise<EventSubscription>;
}

class EventSubscriptionImpl implements EventSubscription {
	readonly #queue = new NotificationQueue<Occurrence>();
	#handle: { close(): void } | undefined;
	#closed = false;

	constructor(
		private readonly events: EventsClient,
		private readonly id: number,
		readonly name: string,
	) {}

	poll(): Promise<EventsPollResult> {
		return this.events.poll(this.id);
	}

	#start(): void {
		if (this.#handle || this.#closed) return;
		this.#handle = this.events.push(this.id, (message) => {
			if (message.type === "event") this.#queue.push(message.event);
			else if (message.type === "terminated" || message.type === "error") this.#queue.close();
		});
	}

	[Symbol.asyncIterator](): AsyncIterator<Occurrence> {
		this.#start();
		return this.#queue[Symbol.asyncIterator]();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#handle?.close();
		this.events.forget(this.id);
		this.#queue.close();
	}
}

export class EventsFacade implements Events {
	#events: EventsClient | undefined;
	#capabilities: unknown;

	constructor(private readonly connection: { readonly client: McpClient }) {}

	setCapabilities(capabilities: unknown): void {
		this.#capabilities = capabilities;
	}

	async #ensure(): Promise<EventsClient> {
		if (this.#events) return this.#events;
		if (this.#capabilities === undefined) {
			const discovered = await this.connection.client.discover();
			this.#capabilities = discovered.kind === "ok" ? discovered.value.capabilities : null;
		}
		this.#events = new EventsClient({
			extension: createEventsExtension({ enabled: true }),
			peerCapabilities: () => this.#capabilities,
			request: (method, params, opts) => this.connection.client.request(method, params, opts),
			openStream: (method, params, opts) => this.connection.client.openStream(method, params, opts),
		});
		return this.#events;
	}

	async list(): Promise<Obj> {
		return (await this.#ensure()).list();
	}

	async subscribe(name: string, args: Obj = {}): Promise<EventSubscription> {
		const events = await this.#ensure();
		return new EventSubscriptionImpl(events, events.subscription(name, args), name);
	}

	dispose(): void {
		this.#events?.dispose();
		this.#events = undefined;
	}
}
