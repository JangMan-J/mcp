import { describe, expect, it } from "vitest";
import { normalizeContent } from "../../../dist/ops/index.js";
import { convertBlocks, MAX_TEXT_CHARS, truncateText } from "../content.ts";

describe("truncateText", () => {
	it("keeps short text", () => {
		expect(truncateText("hi")).toBe("hi");
	});
	it("truncates long text with a marker", () => {
		const long = "x".repeat(MAX_TEXT_CHARS + 100);
		const out = truncateText(long);
		expect(out).toContain("100 chars truncated");
		expect(out.length).toBeLessThan(long.length + 60);
	});
});

describe("convertBlocks", () => {
	it("passes text through", () => {
		const blocks = normalizeContent([{ type: "text", text: "hello" }]);
		expect(convertBlocks(blocks)).toEqual([{ type: "text", text: "hello" }]);
	});

	it("maps images to pi image blocks", () => {
		const blocks = normalizeContent([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
		expect(convertBlocks(blocks)).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
	});

	it("flattens embedded text resources", () => {
		const blocks = normalizeContent([
			{ type: "resource", resource: { uri: "file:///x.txt", text: "contents" } },
		]);
		expect(convertBlocks(blocks)).toEqual([{ type: "text", text: "contents" }]);
	});

	it("maps image blobs in resources to image blocks", () => {
		const blocks = normalizeContent([
			{ type: "resource", resource: { uri: "file:///x.png", blob: "aGk=", mimeType: "image/png" } },
		]);
		const out = convertBlocks(blocks);
		expect(out[0]).toEqual({ type: "image", data: "aGk=", mimeType: "image/png" });
	});

	it("degrades unknown blocks to text", () => {
		const blocks = normalizeContent([{ type: "future-block", x: 1 }]);
		const out = convertBlocks(blocks);
		expect(out[0]?.type).toBe("text");
	});

	it("never returns an empty content array", () => {
		expect(convertBlocks([])).toEqual([{ type: "text", text: "(no content)" }]);
	});
});
