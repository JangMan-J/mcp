import { describe, expect, it } from "vitest";
import { EventBus, type EventStore, type ServerOccurrence } from "../src/bus.js";
import { EventsServer } from "../src/events.js";
import { SubscriptionsServer } from "../src/subscriptions.js";
import { FakeChannel } from "./helpers.js";

describe("EventBus", () => {
	it("polls with opaque cursors, maxAgeMs, unknown-cursor reset, and EventStore durability", () => {
		let now = 10_000;
		const persisted = new Map<string, ServerOccurrence[]>();
		const store: EventStore = {
			load: (k) => persisted.get(k) ?? [],
			append: (k, e) => {
				const arr = persisted.get(k) ?? [];
				arr.push(e);
				persisted.set(k, arr);
			},
		};
		const clock = { now: () => now, setTimeout: () => () => {} };
		const bus = new EventBus({ retain: 2, clock, store });
		bus.publish("mail", { n: 1 }, {}, { eventId: "m-1" });
		now += 1_000;
		bus.publish("mail", { n: 2 }, {}, { eventId: "m-2" });
		now += 1_000;
		bus.publish("mail", { n: 3 }, {}, { eventId: "m-3" });

		const page = bus.poll("mail", {}, "1", 10);
		expect(page.events.map((e) => e.data)).toEqual([{ n: 2 }, { n: 3 }]);
		expect(page.events[0]?.eventId).toBe("m-2");
		expect(page.truncated).toBe(false);

		bus.publish("mail", { n: 4 }, {}, { eventId: "m-4" });
		const evicted = bus.poll("mail", {}, "1", 10);
		expect(evicted.truncated).toBe(true);
		expect(evicted.events.map((e) => e.data)).toEqual([{ n: 3 }, { n: 4 }]);

		const old = bus.poll("mail", {}, "0", 10);
		expect(old.truncated).toBe(false);
		const stale = bus.poll("mail", {}, "2", 1);
		expect(stale.hasMore).toBe(true);

		const unknown = bus.poll("mail", {}, "gone-cursor", 10);
		expect(unknown).toMatchObject({ events: [], cursor: "4", truncated: true, hasMore: false });

		now += 2_000;
		const aged = bus.poll("mail", {}, "0", 10, { maxAgeMs: 500 });
		expect(aged.truncated).toBe(true);
		expect(aged.events).toEqual([]);

		const restored = new EventBus({ retain: 10, clock, store });
		expect(restored.poll("mail", {}, "0", 10).events).toHaveLength(4);
	});
});

describe("EventsServer", () => {
	it("serves list/poll (SEP-3415 null vs 0 cursor) and pushes active, event, and heartbeat notices", async () => {
		const events = new EventsServer({ heartbeatMs: 5 });
		events.bus.publish("mail", { subject: "before" });
		expect(events.list()).toEqual({
			resultType: "complete",
			events: [{ name: "mail", delivery: ["push", "poll"] }],
		});
		// SEP-3415: cursor: null starts from now; cursor: "0" replays retained backlog.
		const fromNow = events.poll({ name: "mail", arguments: {}, cursor: null });
		expect(fromNow).toMatchObject({ resultType: "complete", events: [], cursor: "1", truncated: false, hasMore: false });
		const replayed = events.poll({ name: "mail", arguments: {}, cursor: "0" });
		const items = replayed.events as Record<string, unknown>[];
		expect(items).toHaveLength(1);
		expect("cursor" in items[0]!).toBe(false);

		const channel = new FakeChannel(7);
		events.stream(channel, { name: "mail", arguments: {}, cursor: null });
		expect(channel.methods()).toEqual(["notifications/events/active"]);
		events.bus.publish("mail", { subject: "live" });
		expect(channel.methods()).toContain("notifications/events/event");
		await new Promise((r) => setTimeout(r, 15));
		expect(channel.methods()).toContain("notifications/events/heartbeat");
		channel.close();
		events.bus.publish("mail", { subject: "after-close" });
		expect(channel.notifications.filter((n) => n.method === "notifications/events/event")).toHaveLength(1);
	});

	it("supports static catalog before publish, delivery-mode -32026, unknown -32023, filters, and heartbeat reset", () => {
		let now = 1_000;
		const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
		const clock = {
			now: () => now,
			setTimeout(fn: () => void, ms: number) {
				const entry = { at: now + ms, fn, cancelled: false };
				timers.push(entry);
				return () => { entry.cancelled = true; };
			},
		};
		const subs = new SubscriptionsServer({ capabilities: { events: { listChanged: true } } });
		const listenCh = new FakeChannel(1);
		subs.listen(listenCh, { notifications: { eventsListChanged: true } });

		const events = new EventsServer({
			clock,
			subscriptions: subs,
			heartbeatMs: 30_000,
			minHeartbeatMs: 1_000,
			maxHeartbeatMs: 60_000,
			events: [
				{
					name: "roger.mail",
					description: "Durable mail",
					delivery: ["push", "poll"],
					inputSchema: { type: "object", properties: { kind: { type: "string" } } },
					filter: (data, args) => typeof args.kind !== "string" || (data as { kind?: string })?.kind === args.kind,
				},
				{
					name: "roger.board",
					delivery: ["push"],
				},
			],
		});

		// Available immediately at startup before any bus.publish()
		const listed = events.list();
		expect((listed.events as Array<{ name: string }>).map((e) => e.name)).toEqual(["roger.board", "roger.mail"]);

		// Push-only event rejects poll with -32026 Unsupported (deliveryMode=poll)
		expect(() => events.poll({ name: "roger.board", arguments: {}, cursor: null })).toThrowError(
			expect.objectContaining({ code: -32026, data: { feature: "deliveryMode", value: "poll" } }),
		);
		// Unknown event rejects with -32023 NotFound (kind=event)
		expect(() => events.poll({ name: "roger.missing", arguments: {}, cursor: null })).toThrowError(
			expect.objectContaining({ code: -32023, data: { kind: "event" } }),
		);
		// Webhook rejects with -32026 Unsupported (deliveryMode=webhook)
		expect(() => events.unsupportedWebhook({ name: "roger.mail" })).toThrowError(
			expect.objectContaining({ code: -32026, data: { feature: "deliveryMode", value: "webhook" } }),
		);

		// Stream clamps heartbeatMs and resets timer on live event
		const streamCh = new FakeChannel("sub-str-1");
		events.stream(streamCh, { name: "roger.mail", arguments: { kind: "directed" }, cursor: null, heartbeatMs: 500 });
		expect(streamCh.notifications[0]?.params).toMatchObject({ heartbeatMs: 1_000, cursor: "0", truncated: false });

		now = 1_600; // 600ms elapsed (< 1000ms)
		events.bus.publish("roger.mail", { kind: "broadcast", body: "skip" });
		expect(streamCh.notifications.filter((n) => n.method === "notifications/events/event")).toHaveLength(0);
		events.bus.publish("roger.mail", { kind: "directed", body: "deliver" });
		expect(streamCh.notifications.filter((n) => n.method === "notifications/events/event")).toHaveLength(1);
		// Earlier timer at 2000ms was cancelled and rescheduled to 2600ms
		expect(timers[0]?.cancelled).toBe(true);
		const activeTimer = timers.find((t) => !t.cancelled);
		expect(activeTimer?.at).toBe(2_600);

		// Dynamic registerEvent notifies eventsListChanged; unregisterEvent terminates stream with -32023
		events.registerEvent({ name: "roger.registration", delivery: ["push"] });
		expect(listenCh.methods()).toContain("notifications/events/list_changed");
		events.unregisterEvent("roger.mail");
		expect(streamCh.methods()).toContain("notifications/events/terminated");
	});

	it("replays retained occurrences after a supplied cursor", () => {
		const events = new EventsServer();
		const first = events.bus.publish("mail", { n: 1 });
		events.bus.publish("mail", { n: 2 });
		const channel = new FakeChannel(9);
		events.stream(channel, { name: "mail", arguments: {}, cursor: first.cursor });
		expect(channel.methods()).toEqual(["notifications/events/active", "notifications/events/event"]);
		const replay = channel.notifications[1]!;
		expect(replay.params).toMatchObject({ eventId: expect.any(String), cursor: "2" });
		expect(replay.params?._meta).toEqual({ "io.modelcontextprotocol/subscriptionId": 9 });
	});
});
