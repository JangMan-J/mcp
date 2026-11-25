/**
 * High-level consumer API: connect to an MCP server and call tools without
 * assembling McpClient/ops/transports or matching on Outcome for every call.
 *
 * Simple mode (this module): list()/call() return values or throw
 * McpOutcomeError. Full mode: use `connection.ops` directly and match on
 * Outcome kinds (mrtr-interim, task-handle, uncertain-write, ...).
 */
import {
	McpClient,
	unwrapOutcome,
	type McpClientOptions,
	type ServerRef,
	type Transport,
} from "@mcp/core";
import {
	createOps,
	type Ops,
	type ToolCallOptions,
	type ToolCallResult,
	type ToolEntry,
} from "@mcp/ops";
import { HttpTransport, type HttpTransportOptions } from "@mcp/transport-http";
import { StdioTransport, type StdioTransportOptions } from "@mcp/transport-stdio";
import { createEventsExtension } from "@mcp/ext-events";
import {
	SubscriptionManager,
	type ListenFilter,
	type Subscription,
} from "@mcp/mrtr-cache";
import { EventsFacade, type Events } from "./events.js";

export interface ConnectBaseOptions {
	/** Server identity; defaults to the command or URL. */
	readonly server?: ServerRef;
	readonly clientInfo?: McpClientOptions["clientInfo"];
	/** Per-request timeout; defaults to the library default. */
	readonly timeoutMs?: number;
	/** Probe server/discover during connect and throw on failure. Default false. */
	readonly discover?: boolean;
	/** Declare the events extension and expose connection.events. Default true. */
	readonly events?: boolean;
	/**
	 * Rebuild the connection and retry once after a dropped connection
	 * (connect/closed/stream-broken/process-exit). Requires a transport factory
	 * or stdio/http options; a bare Transport instance cannot be rebuilt.
	 */
	readonly reconnectOnDrop?: boolean;
}

export type ConnectOptions = ConnectBaseOptions &
	(
		| { readonly transport: Transport | (() => Transport) }
		| { readonly stdio: StdioTransportOptions }
		| { readonly http: HttpTransportOptions }
	);

export interface SimpleTools {
	/** All tools, following pagination. Throws McpOutcomeError on failure. */
	list(): Promise<ToolEntry[]>;
	/** Call a tool. Throws McpOutcomeError on protocol/transport failure or isError. */
	call(name: string, args?: unknown, opts?: ToolCallOptions): Promise<ToolCallResult>;
}

export interface Connection {
	readonly client: McpClient;
	readonly ops: Ops;
	readonly tools: SimpleTools;
	/** Push-based event subscriptions (events extension). */
	readonly events: Events;
	/** Standard MCP subscriptions/listen (list_changed, resource updates). */
	listen(filter: ListenFilter): Subscription;
	/** Tear down and rebuild the underlying client (new transport). */
	reconnect(): Promise<void>;
	close(opts?: { readonly graceMs?: number }): Promise<void>;
}

const RETRY_KINDS = new Set(["connect", "closed", "stream-broken", "process-exit"]);

class ConnectionImpl implements Connection {
	#current: { client: McpClient; ops: Ops };
	readonly #options: ConnectOptions;
	readonly events: EventsFacade;
	#binding: "stdio" | "http" = "http";
	#manager: SubscriptionManager | undefined;
	readonly #subscriptions = new Set<Subscription>();

	constructor(options: ConnectOptions) {
		this.#options = options;
		this.#current = this.#build();
		this.events = new EventsFacade(this);
	}

	get client(): McpClient {
		return this.#current.client;
	}
	get ops(): Ops {
		return this.#current.ops;
	}

	#transport(): Transport {
		if ("transport" in this.#options) {
			const t = this.#options.transport;
			return typeof t === "function" ? t() : t;
		}
		if ("stdio" in this.#options) return new StdioTransport(this.#options.stdio);
		return new HttpTransport(this.#options.http);
	}

	listen(filter: ListenFilter): Subscription {
		this.#manager ??= new SubscriptionManager({
			open: (method, params) => this.client.openStream(method, params),
			binding: this.#binding,
			serverRef: this.client.server.key,
			reconnect: "on-abrupt",
		});
		const subscription = this.#manager.listen(filter);
		this.#subscriptions.add(subscription);
		return subscription;
	}

	#build(): { client: McpClient; ops: Ops } {
		const transport = this.#transport();
		this.#binding = transport.binding === "stdio" ? "stdio" : "http";
		const server =
			this.#options.server ??
			("stdio" in this.#options
				? { key: this.#options.stdio.command }
				: "http" in this.#options
					? { key: this.#options.http.url }
					: { key: "mcp" });
		const client = new McpClient({
			transport,
			server,
			...(this.#options.events === false
				? {}
				: { extensions: [createEventsExtension({ enabled: true })] }),
			...(this.#options.clientInfo !== undefined ? { clientInfo: this.#options.clientInfo } : {}),
			...(this.#options.timeoutMs !== undefined
				? { defaults: { timeoutMs: this.#options.timeoutMs } }
				: {}),
		});
		return { client, ops: createOps(client) };
	}

	async reconnect(): Promise<void> {
		const previous = this.#current;
		this.#current = this.#build();
		this.#manager?.reconnected();
		try {
			await previous.client.close({ graceMs: 500 });
		} catch {
			// best-effort close of the dropped connection
		}
	}

	async close(opts?: { readonly graceMs?: number }): Promise<void> {
		this.events.dispose();
		for (const subscription of this.#subscriptions) subscription.close();
		this.#subscriptions.clear();
		await this.#current.client.close(opts);
	}

	readonly tools: SimpleTools = {
		list: async (): Promise<ToolEntry[]> => {
			const outcome = await this.ops.tools.listAll();
			return unwrapOutcome(outcome).items;
		},
		call: async (name, args, opts): Promise<ToolCallResult> => {
			let outcome = await this.ops.tools.call(name, args, opts);
			if (
				this.#options.reconnectOnDrop &&
				outcome.kind === "transport-failure" &&
				RETRY_KINDS.has(outcome.failure.kind) &&
				!(opts?.signal?.aborted ?? false)
			) {
				await this.reconnect();
				outcome = await this.ops.tools.call(name, args, opts);
			}
			return unwrapOutcome(outcome);
		},
	};
}

/** Connect to an MCP server over stdio, streamable HTTP, or a custom transport. */
export async function connect(options: ConnectOptions): Promise<Connection> {
	const connection = new ConnectionImpl(options);
	if (options.discover) {
		try {
			const discovered = unwrapOutcome(await connection.client.discover());
			connection.events.setCapabilities(discovered.capabilities);
		} catch (error) {
			await connection.close().catch(() => {});
			throw error;
		}
	}
	return connection;
}

export { McpOutcomeError, unwrapOutcome } from "@mcp/core";
export type { ToolCallOptions, ToolCallResult, ToolEntry } from "@mcp/ops";
export type { Events, EventSubscription, EventsPollResult } from "./events.js";
export type { Occurrence } from "@mcp/ext-events";
export type { ListenFilter, Subscription, ChangeEvent, Acknowledgment } from "@mcp/mrtr-cache";
