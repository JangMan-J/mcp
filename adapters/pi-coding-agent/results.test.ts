import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, it } from "vitest";
import { renderOutcome } from "./results.js";

const meta = { requestId: 1, method: "tools/call", binding: "http", attempts: 1 };

it("middle-cuts multibyte text across blocks and spills the complete text privately [PICA-6]", async () => {
  const parts = ["head" + "🙂".repeat(3000), "中".repeat(4000) + "tail"];
  const value = { content: parts.map(text => ({ type: "text", text })), structuredContent: [1, 2] };
  const outcome = { kind: "ok", value, meta } as const;
  const result = await renderOutcome(outcome);
  const path = result.details.spillPath!;
  try {
    const { text } = result.content[0]!;
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20 * 1024);
    expect(text).toMatch(/^head🙂/);
    expect(text).toMatch(/中tail$/);
    expect(text).not.toContain("\uFFFD");
    expect(text).toContain(path);
    expect(await readFile(path, "utf8")).toBe(parts.join("\n"));
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect((await stat(dirname(path))).mode & 0o077).toBe(0);
    expect(result.details.outcome).toBe(outcome);
    expect(result.isError).toBe(false);
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

it("returns tool-isError as an error result, not an exception; exact limit stays inline", async () => {
  const text = "é".repeat(10 * 1024);
  const outcome = { kind: "tool-isError", result: { content: [{ type: "text", text }], isError: true }, meta } as const;
  const rendered = await renderOutcome(outcome);
  expect(rendered.isError).toBe(true);
  expect(rendered.details.outcome).toBe(outcome);
  expect(rendered.details.spillPath).toBeUndefined();
  expect(rendered.content).toEqual([{ type: "text", text }]);
});

it("warns against blind retries when the write may have run", async () => {
  const result = await renderOutcome({ kind: "uncertain-write", meta, uncertain: {
    requestId: 1, method: "tools/call", argsDigest: "abc", sentAt: 0, binding: "http", evidence: "timeout",
  } });
  expect(result.isError).toBe(true);
  expect(result.content[0]!.text).toMatch(/may or may not have run; do not retry blindly/i);
});
