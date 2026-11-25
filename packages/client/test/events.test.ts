import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@mcp/testing";
import { connect } from "../src/index.js";

function eventsTransport() {
	let streamId: string | number | undefined;
	const transport = new InMemoryTransport((msg) => {
		switch (msg.method) {
			case "server/discover":
				return {
					cacheScope: "public",
					capabilities: {
						tools: {},
						extensions: { "io.modelcontextprotocol/events": { revision: "2026-07-28" } },
					},
					supportedVersions: ["2026-07-28"],
				};
			case "events/list":
				return { events: [{ name: "mail" }] };
			case "events/poll":
				return {
					events: [
						{ eventId: "e1", name: "mail", timestamp: "2026-01-01T00:00:00Z", data: { subject: "pulled" }, cursor: "c1" },
					],
					cursor: "c1",
				};
			case "events/stream":
				streamId = msg.id;
				return new Promise(() => {}); // held open; test pushes notifications
			default:
				throw new Error(`unexpected method: ${msg.method}`);
		}
	});
	return { transport, streamId: () => streamId };
}

describe("connection.listen (standard subscriptions/listen)", () => {
	it("acknowledges a filter and pushes list_changed events", async () => {
		let listenId: string | number | undefined;
		const transport = new InMemoryTransport((msg) => {
			if (msg.method === "subscriptions/listen") {
				listenId = msg.id;
				return new Promise(() => {});
			}
			throw new Error(`unexpected method: ${msg.method}`);
		});
		const connection = await connect({ transport });
		try {
			const subscription = connection.listen({ tools: true });
			for (let i = 0; i < 50 && listenId === undefined; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			expect(listenId).toBeDefined();
			transport.push(
				{
					jsonrpc: "2.0",
					method: "notifications/subscriptions/acknowledged",
					params: {
						notifications: { toolsListChanged: true },
						_meta: { "io.modelcontextprotocol/subscriptionId": listenId },
					},
				},
				listenId,
			);
			const ack = await subscription.acknowledged;
			expect(ack.granted.toolsListChanged).toBe(true);

			const next = subscription.events[Symbol.asyncIterator]().next();
			transport.push(
				{
					jsonrpc: "2.0",
					method: "notifications/tools/list_changed",
					params: { _meta: { "io.modelcontextprotocol/subscriptionId": listenId } },
				},
				listenId,
			);
			const change = await next;
			expect(change.done).toBe(false);
			expect(change.value?.method).toBe("notifications/tools/list_changed");
			subscription.close();
		} finally {
			await connection.close();
		}
	}, 10_000);
});

describe("connection.events (push-first)", () => {
	it("polls explicitly and receives pushed occurrences via async iteration", async () => {
		const { transport, streamId } = eventsTransport();
		const connection = await connect({ transport, discover: true });
		try {
			expect(await connection.events.list()).toEqual({ events: [{ name: "mail" }] });
			const subscription = await connection.events.subscribe("mail");

			const pulled = await subscription.poll();
			expect(pulled.events.map((e) => e.eventId)).toEqual(["e1"]);

			const iterator = subscription[Symbol.asyncIterator]();
			const next = iterator.next();
			for (let i = 0; i < 50 && streamId() === undefined; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			const id = streamId();
			expect(id).toBeDefined();
			transport.push(
				{
					jsonrpc: "2.0",
					method: "notifications/events/active",
					params: { heartbeatMs: 1000, cursor: "c0", _meta: { "io.modelcontextprotocol/subscriptionId": id } },
				},
				id,
			);
			transport.push(
				{
					jsonrpc: "2.0",
					method: "notifications/events/event",
					params: {
						eventId: "e2",
						name: "mail",
						timestamp: "2026-01-01T00:00:01Z",
						data: { subject: "pushed" },
						cursor: "c2",
						_meta: { "io.modelcontextprotocol/subscriptionId": id },
					},
				},
				id,
			);
			const received = await next;
			expect(received.done).toBe(false);
			expect(received.value?.eventId).toBe("e2");
			expect(received.value?.data).toEqual({ subject: "pushed" });
			await subscription.close();
		} finally {
			await connection.close();
		}
	}, 10_000);
});
