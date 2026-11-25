import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { connect } from "../src/index.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "events-stdio.mjs");

describe("openStream over stdio", () => {
	it("routes events/stream notifications through the subscription listener", async () => {
		const connection = await connect({
			stdio: { command: process.execPath, args: [fixture] },
			discover: true,
		});
		try {
			const subscription = await connection.events.subscribe("mail");
			const next = subscription[Symbol.asyncIterator]().next();
			const received = await next;
			expect(received.done).toBe(false);
			expect(received.value?.eventId).toBe("e1");
			await subscription.close();
		} finally {
			await connection.close();
		}
	}, 15_000);
});
