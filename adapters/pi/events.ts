/**
 * SEP-3415 push-event wiring for the Pi MCP bridge.
 *
 * Subscribes to server-advertised `events/list` streams matching `subscribe`,
 * deduplicates `eventId`s, carries `cursor` across stream reconnects within the
 * session, formats `<mcp_event>` blocks with UTF-8-safe bounding, and delivers
 * occurrences to Pi via `pi.sendMessage(..., { triggerTurn: true })`.
 */

import type { McpClient } from "@jangmanj/mcp/core";
import {
	EventsClient,
	type EventsExtension,
	type PushMessage,
} from "@jangmanj/mcp/ext-events";
import type { McpSubscriptionSpecEntry } from "./pi-api.ts";

export interface McpEvent {
	readonly server: string;
	readonly name: string;
	readonly eventId: string;
	readonly timestamp: string;
	readonly data: unknown;
}

export type McpSubscribeItem = string | McpSubscriptionSpecEntry;

const DATA_LIMIT = 16 * 1024;
const TRUNCATED = "…(truncated)";
const MAX_SEEN_EVENT_IDS = 4_096;

function escapeAttr(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

export function formatMcpEvent(event: McpEvent): string {
	let data = JSON.stringify(event.data, null, 2) ?? "null";
	if (Buffer.byteLength(data) > DATA_LIMIT) {
		const bytes = Buffer.from(data);
		let end = DATA_LIMIT - Buffer.byteLength(TRUNCATED);
		while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
		data = bytes.subarray(0, end).toString("utf8") + TRUNCATED;
	}
	return `<mcp_event server="${escapeAttr(event.server)}" name="${escapeAttr(event.name)}" event_id="${escapeAttr(event.eventId)}" timestamp="${escapeAttr(event.timestamp)}">\n${data}\n</mcp_event>`;
}

function patternMatches(name: string, pattern: string): boolean {
	if (pattern === "*") return true;
	if (pattern.endsWith("*")) return name.startsWith(pattern.slice(0, -1));
	return name === pattern;
}

export function matchSubscription(
	name: string,
	subscribe: boolean | readonly McpSubscribeItem[] | undefined,
): McpSubscriptionSpecEntry | undefined {
	if (subscribe === undefined || subscribe === false) return undefined;
	if (subscribe === true) return { name };
	for (const item of subscribe) {
		if (typeof item === "string") {
			if (patternMatches(name, item)) return { name };
		} else if (patternMatches(name, item.name)) {
			return { ...item, name };
		}
	}
	return undefined;
}

export interface StartPiMcpEventsOptions {
	readonly serverName: string;
	readonly subscribe: boolean | readonly McpSubscribeItem[];
	readonly client: McpClient;
	readonly extension: EventsExtension;
	readonly peerCapabilities: () => unknown;
	/** Session-scoped cursor map (`<server>:<eventName> -> cursor`) surviving server reconnects. */
	readonly cursors: Map<string, string>;
	/** Session-scoped bounded dedup set (`<server>:<eventId>`) surviving server reconnects. */
	readonly seenEventIds: Set<string>;
	deliver(text: string, event: McpEvent): Promise<void> | void;
}

export interface PiMcpEventsHandle {
	readonly subscribed: readonly string[];
	readonly advertised: readonly string[];
	close(): Promise<void>;
}

function rememberEventId(seen: Set<string>, key: string): boolean {
	if (seen.has(key)) return false;
	seen.add(key);
	while (seen.size > MAX_SEEN_EVENT_IDS) {
		const oldest = seen.values().next().value;
		if (oldest === undefined) break;
		seen.delete(oldest);
	}
	return true;
}

export async function startPiMcpEvents(options: StartPiMcpEventsOptions): Promise<PiMcpEventsHandle> {
	if (options.subscribe === false) {
		return { subscribed: [], advertised: [], close: async () => {} };
	}

	let chain = Promise.resolve();
	const streams: Array<{ close(): void }> = [];
	const specsByName = new Map<string, McpSubscriptionSpecEntry>();
	const subscribed: string[] = [];
	const advertised: string[] = [];
	let events: EventsClient | undefined;

	try {
		events = new EventsClient({
			extension: options.extension,
			peerCapabilities: options.peerCapabilities,
			request: (method, params, opts) => options.client.request(method, params, opts),
			openStream: (method, params, opts) => {
				const subName = typeof params.name === "string" ? params.name : "";
				const subKey = `${options.serverName}:${subName}`;
				const spec = specsByName.get(subName);
				const liveCursor =
					typeof params.cursor === "string" && params.cursor.length > 0 ? params.cursor : undefined;
				const storedCursor = !liveCursor && subName ? options.cursors.get(subKey) : undefined;
				const effectiveCursor = liveCursor ?? storedCursor;
				return options.client.openStream(
					method,
					{
						...params,
						...(effectiveCursor ? { cursor: effectiveCursor } : {}),
						...(spec?.maxAgeMs !== undefined ? { maxAgeMs: spec.maxAgeMs } : {}),
						heartbeatMs: spec?.heartbeatMs ?? 30_000,
					},
					{ ...opts, stream: true, timeoutMs: 0 },
				);
			},
		});

		let page: string | undefined;
		do {
			let listed: Record<string, unknown>;
			try {
				listed = await events.list(page);
			} catch {
				// Server does not advertise io.modelcontextprotocol/events — valid no-op.
				events.dispose();
				return { subscribed: [], advertised: [], close: async () => {} };
			}
			const entries = Array.isArray(listed.events) ? listed.events : [];
			for (const entry of entries) {
				if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
					advertised.push((entry as { name: string }).name);
				}
			}
			page = typeof listed.nextCursor === "string" ? listed.nextCursor : undefined;
		} while (page);

		const deliverFor = (subName: string) => (message: PushMessage) => {
			if (message.type === "active") {
				if (typeof message.cursor === "string" && message.cursor.length > 0) {
					options.cursors.set(`${options.serverName}:${subName}`, message.cursor);
				}
				return;
			}
			if (message.type !== "event") return;
			chain = chain
				.then(async () => {
					const e = message.event;
					if (
						typeof e.name !== "string" ||
						e.name.length === 0 ||
						typeof e.eventId !== "string" ||
						typeof e.timestamp !== "string" ||
						Number.isNaN(Date.parse(e.timestamp))
					) {
						return;
					}
					if (typeof e.cursor === "string" && e.cursor.length > 0) {
						options.cursors.set(`${options.serverName}:${e.name}`, e.cursor);
					}
					const dedupeKey = `${options.serverName}:${e.eventId}`;
					if (!rememberEventId(options.seenEventIds, dedupeKey)) return;

					let data: unknown = e.data;
					try {
						const json = JSON.stringify(data);
						data = json === undefined ? null : JSON.parse(json);
					} catch {
						data = null;
					}
					const event: McpEvent = {
						server: options.serverName,
						name: e.name,
						eventId: e.eventId,
						timestamp: e.timestamp,
						data,
					};
					await options.deliver(formatMcpEvent(event), event);
				})
				.catch(() => {});
		};

		for (const name of advertised) {
			const spec = matchSubscription(name, options.subscribe);
			if (!spec) continue;
			specsByName.set(name, spec);
			subscribed.push(name);
			const id = events.subscription(name, (spec.arguments ?? {}) as Record<string, unknown>);
			streams.push(events.push(id, deliverFor(name)));
		}
	} catch (error) {
		for (const stream of streams) stream.close();
		events?.dispose();
		throw error;
	}

	return {
		subscribed,
		advertised,
		close: async () => {
			for (const stream of streams) stream.close();
			await chain;
			events?.dispose();
		},
	};
}
