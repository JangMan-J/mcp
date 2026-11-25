import { describe, expect, it } from "vitest";
import { connect } from "@mcp/client";
import { InMemoryTransport } from "@mcp/testing";
import { EventsServer } from "../src/events.js";
import type { Obj, PushChannel } from "../src/types.js";

describe("server-events <-> client interop", () => {
	it("delivers a published occurrence to connection.events", async () => {
		const events = new EventsServer({ heartbeatMs: 1000 });
		const transport = new InMemoryTransport((msg) => {
			switch (msg.method) {
				case "server/discover":
					return {
						cacheScope: "public",
						capabilities: { ...events.capabilities() },
						supportedVersions: ["2026-07-28"],
					};
				case "events/list":
					return events.list();
				case "events/poll":
					return events.poll((msg.params ?? {}) as Obj);
				case "events/stream": {
					let resolve!: (result: Obj) => void;
					const done = new Promise<Obj>((r) => {
						resolve = r;
					});
					const channel: PushChannel = {
						id: msg.id,
						notify: (n) => {
							transport.push(n, msg.id);
						},
						finish: (result) => resolve(result),
						onClose: () => {},
					};
					events.stream(channel, (msg.params ?? {}) as Obj);
					return done;
				}
				default:
					throw new Error(`unexpected method: ${msg.method}`);
			}
		});
		const connection = await connect({ transport, discover: true });
		try {
			const subscription = await connection.events.subscribe("mail");
			const next = subscription[Symbol.asyncIterator]().next();
			events.bus.publish("mail", { subject: "hello" });
			const received = await next;
			expect(received.done).toBe(false);
			expect(received.value?.data).toEqual({ subject: "hello" });
			await subscription.close();
		} finally {
			await connection.close();
		}
	}, 10_000);
});
