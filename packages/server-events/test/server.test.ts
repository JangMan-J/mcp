import { describe, expect, it } from "vitest";
import { SubscriptionsServer } from "../src/subscriptions.js";
import { TaskCenter } from "../src/tasks.js";
import { Notices, sendProgress } from "../src/notices.js";
import { EventBus } from "../src/bus.js";
import { FakeChannel } from "./helpers.js";

describe("SubscriptionsServer", () => {
	it("acks grants, fans out only granted changes, and ends gracefully", () => {
		const server = new SubscriptionsServer({
			capabilities: { tools: { listChanged: true }, resources: { subscribe: true } },
		});
		const channel = new FakeChannel(3);
		server.listen(channel, {
			notifications: { toolsListChanged: true, promptsListChanged: true, resourceSubscriptions: ["file:///a"] },
		});
		expect(channel.methods()).toEqual(["notifications/subscriptions/acknowledged"]);
		expect(channel.notifications[0]?.params?.notifications).toEqual({
			toolsListChanged: true,
			promptsListChanged: false,
			resourceSubscriptions: ["file:///a"],
		});
		server.notifyToolsChanged();
		server.notifyPromptsChanged();
		server.notifyResourceUpdated("file:///a");
		server.notifyResourceUpdated("file:///b");
		expect(channel.methods()).toEqual([
			"notifications/subscriptions/acknowledged",
			"notifications/tools/list_changed",
			"notifications/resources/updated",
		]);
		server.end(channel);
		expect(channel.result).toEqual({
			resultType: "complete",
			_meta: { "io.modelcontextprotocol/subscriptionId": 3 },
		});
	});
});

describe("TaskCenter", () => {
	it("runs the working -> input_required -> working -> completed flow with push notices", () => {
		const bus = new EventBus();
		const tasks = new TaskCenter({ bus });
		const channel = new FakeChannel(11);
		tasks.attach(channel);
		const created = tasks.create({ pollIntervalMs: 10 });
		expect(created.status).toBe("working");
		tasks.requestInput(created.taskId, { q: { method: "elicitation/create", params: { message: "?" } } });
		const updated = tasks.update({ taskId: created.taskId, inputResponses: { q: { answer: 42 } } });
		expect(updated.status).toBe("working");
		const done = tasks.complete(created.taskId, { ok: true });
		expect(done.status).toBe("completed");
		expect(channel.methods()).toEqual(Array(4).fill("notifications/tasks"));
		expect(bus.poll("tasks", {}, null, 10).events).toHaveLength(4);
		expect(tasks.cancel({ taskId: created.taskId }).status).toBe("completed");
	});
});

describe("Notices", () => {
	it("publishes notices as ordinary events and sends request-scoped progress", () => {
		const bus = new EventBus();
		const notices = new Notices(bus);
		notices.info("ready", { version: 1 });
		expect(bus.poll("notices", {}, null, 1).events[0]?.data).toEqual({ level: "info", message: "ready", data: { version: 1 } });
		const channel = new FakeChannel(1);
		sendProgress(channel, { progressToken: 1, progress: 2, total: 3 });
		expect(channel.notifications[0]?.method).toBe("notifications/progress");
	});
});
