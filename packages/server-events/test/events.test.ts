import { describe, expect, it } from "vitest";
import { EventBus } from "../src/bus.js";
import { EventsServer } from "../src/events.js";
import { FakeChannel } from "./helpers.js";

describe("EventBus", () => {
	it("polls with opaque cursors and reports truncation", () => {
		const bus = new EventBus({ retain: 2 });
		bus.publish("mail", { n: 1 });
		bus.publish("mail", { n: 2 });
		bus.publish("mail", { n: 3 });
		const page = bus.poll("mail", {}, "1", 10);
		expect(page.events.map((e) => e.data)).toEqual([{ n: 2 }, { n: 3 }]);
		expect(page.truncated).toBe(false);
		const old = bus.poll("mail", {}, "0", 10);
		expect(old.truncated).toBe(false); // cursor 0 means "from retained start"
		const stale = bus.poll("mail", {}, "1", 1);
		expect(stale.hasMore).toBe(true);
	});
});

describe("EventsServer", () => {
	it("serves list/poll and pushes active, event, and heartbeat notices", async () => {
		const events = new EventsServer({ heartbeatMs: 5 });
		events.bus.publish("mail", { subject: "before" });
		expect(events.list()).toEqual({ events: [{ name: "mail", arguments: {} }] });
		const polled = events.poll({ name: "mail", arguments: {}, cursor: null });
		expect(polled.events).toHaveLength(1);

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
