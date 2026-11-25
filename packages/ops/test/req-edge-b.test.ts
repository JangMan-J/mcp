import { describe, expect, it } from "vitest";
import type { Outcome } from "@mcp/core";
import { listAll, nextCursorOf, type Page } from "../src/index.js";

const meta = { requestId: 1, method: "x/list", binding: "test", attempts: 1 };
const page = <T>(items: T[], nextCursor?: string): Outcome<Page<T>> => ({
  kind: "ok",
  value: { items, ...(nextCursor !== undefined ? { nextCursor } : {}) },
  meta,
});

describe("edge cases part 2 (ops)", () => {
  it("[EDGE-17] nextCursor empty string is not the end of the list", async () => {
    expect(nextCursorOf({ nextCursor: "" })).toEqual({ ok: true, cursor: "" });
    const seen: (string | undefined)[] = [];
    const o = await listAll<number>("x/list", async (c) => {
      seen.push(c);
      return c === undefined ? page([1], "") : page([2]);
    });
    expect(seen).toEqual([undefined, ""]);
    expect(o).toMatchObject({ kind: "ok", value: { items: [1, 2], pages: 2 } });
  });
});
