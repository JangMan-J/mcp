import { describe, expect, it } from "vitest";
import { buildAiCatalog, buildServerCard, parseServerCard, ServerCardError } from "../src/index.js";

describe("buildServerCard", () => {
	it("builds a card whose remotes become connection candidates when parsed", () => {
		const card = buildServerCard({
			name: "roger-wilco",
			version: "0.1.0",
			title: "Roger-Wilco",
			description: "Durable cross-machine mail with push/poll event streams.",
			remotes: [
				{ type: "streamable-http", url: "https://roger.example.net/mcp", supportedVersions: ["2026-07-28"] },
			],
		});
		const parsed = parseServerCard(card, "https://roger.example.net/server-card");
		expect(parsed.connectionCandidates).toEqual([
			{ url: "https://roger.example.net/mcp", supportedVersions: ["2026-07-28"] },
		]);
		expect(parsed.inferredCapabilities).toEqual({});
	});

	it("rejects missing identity and primitive capability fields", () => {
		expect(() => buildServerCard({ name: "", version: "1", description: "x" })).toThrow(ServerCardError);
		expect(() =>
			buildServerCard({ name: "x", version: "1", description: "x", tools: [] } as never),
		).toThrow("card-primitives-not-allowed");
	});

	it("wraps cards in an ai-catalog document", () => {
		const card = buildServerCard({ name: "x", version: "1", description: "x" });
		expect(buildAiCatalog([card])).toEqual({ entries: [{ type: "mcp-server-card", data: card }] });
	});
});
