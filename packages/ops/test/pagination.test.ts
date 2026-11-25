import { describe, expect, it } from "vitest";
import type { Outcome } from "@mcp/core";
import { createOps, cursorParams, listAll, nextCursorOf, type Page } from "../src/index.js";
import { installNetworkSpy, makeClient, paramsOf, settle } from "./helpers.js";

installNetworkSpy();

const meta = { requestId: 1, method: "x/list", binding: "test", attempts: 1 };
const page = <T>(items: T[], nextCursor?: string): Outcome<Page<T>> => ({
  kind: "ok",
  value: { items, ...(nextCursor !== undefined ? { nextCursor } : {}) },
  meta,
});

describe("listAll helper", () => {
  it("follows cursors until absent and echoes cursor bytes unchanged (PAGE-1, PAGE-3)", async () => {
    const odd = "  é%2F/+==\u0000~ ";
    const seen: (string | undefined)[] = [];
    const o = await listAll<number>("x/list", async (c) => {
      seen.push(c);
      return c === undefined ? page([1], odd) : c === odd ? page([2], "") : page([3]);
    });
    expect(seen).toEqual([undefined, odd, ""]);
    expect(o).toMatchObject({ kind: "ok", value: { items: [1, 2, 3], pages: 3 } });
  });

  it("treats the empty string as a real cursor (PAGE-2)", () => {
    expect(cursorParams("")).toEqual({ cursor: "" });
    expect(cursorParams(undefined)).toEqual({});
    expect(nextCursorOf({ nextCursor: "" })).toEqual({ ok: true, cursor: "" });
    expect(nextCursorOf({ nextCursor: null })).toEqual({ ok: true, cursor: undefined });
    expect(nextCursorOf({})).toEqual({ ok: true, cursor: undefined });
    expect(nextCursorOf({ nextCursor: 3 })).toEqual({ ok: false });
    expect(nextCursorOf([])).toEqual({ ok: false });
  });

  it("stops on a repeated cursor, even a non-adjacent one (PAGE-5)", async () => {
    const seq = ["a", "b", "a"];
    let i = 0;
    const o = await listAll<number>("x/list", async () => page([i], seq[i++]));
    expect(o).toMatchObject({ kind: "protocol-violation", detail: { reason: "cursor-loop" } });
    expect(i).toBe(3);
  });

  it("caps pages and items (PAGE-5 limits)", async () => {
    let n = 0;
    const pages = await listAll<number>("x/list", async () => page([n], `c${n++}`), { maxPages: 5 });
    expect(pages).toMatchObject({ kind: "limit-exceeded", detail: { limit: "maxPages", max: 5 } });
    expect(n).toBe(5);

    const items = await listAll<number>("x/list", async (c) => page([1, 2, 3], c === undefined ? "n" : undefined), {
      maxItems: 4,
    });
    expect(items).toMatchObject({ kind: "limit-exceeded", detail: { limit: "maxItems", max: 4, observed: 6 } });
  });

  it("surfaces -32602 and restarts once only when asked (PAGE-6)", async () => {
    const invalid: Outcome<Page<number>> = { kind: "jsonrpc-error", code: -32602, message: "Invalid cursor", meta };
    let calls = 0;
    const fetch = async (c: string | undefined) => {
      calls += 1;
      return c === undefined ? page([1], "stale") : invalid;
    };
    expect(await listAll("x/list", fetch)).toMatchObject({ kind: "jsonrpc-error", code: -32602 });
    expect(calls).toBe(2);

    calls = 0;
    expect(await listAll("x/list", fetch, { restartOnInvalidCursor: true })).toMatchObject({
      kind: "jsonrpc-error",
      code: -32602,
    });
    expect(calls).toBe(4);

    calls = 0;
    let first = true;
    const recovers = await listAll<number>(
      "x/list",
      async (c) => {
        calls += 1;
        if (c === undefined) return page([calls], first ? "stale" : undefined);
        first = false;
        return invalid;
      },
      { restartOnInvalidCursor: true },
    );
    expect(recovers).toMatchObject({ kind: "ok", value: { items: [3], pages: 1 } });
  });

  it("does not restart on -32602 for the first page", async () => {
    let calls = 0;
    const o = await listAll(
      "x/list",
      async () => {
        calls += 1;
        return { kind: "jsonrpc-error", code: -32602, message: "bad", meta } as Outcome<Page<number>>;
      },
      { restartOnInvalidCursor: true },
    );
    expect(o.kind).toBe("jsonrpc-error");
    expect(calls).toBe(1);
  });
});

describe("list APIs over the wire", () => {
  it("every listAll sends the opaque cursor verbatim (PAGE-3)", async () => {
    const cursor = "eyJ4IjoxfQ==/%2F?#&";
    const { client, transport } = makeClient((req) => {
      const p = paramsOf(req);
      const key = req.method === "tools/list" ? "tools" : req.method === "prompts/list" ? "prompts" : req.method === "resources/list" ? "resources" : "resourceTemplates";
      return {
        kind: "response",
        message: { jsonrpc: "2.0", id: req.id, result: { [key]: [], ...(p["cursor"] === undefined ? { nextCursor: cursor } : {}) } },
      };
    });
    const ops = createOps(client);
    for (const o of await Promise.all([
      ops.tools.listAll(),
      ops.prompts.listAll(),
      ops.resources.listAll(),
      ops.resources.listAllTemplates(),
    ])) {
      expect(o).toMatchObject({ kind: "ok", value: { pages: 2 } });
    }
    const echoed = transport.sent.filter((s) => paramsOf(s)["cursor"] !== undefined);
    expect(echoed.map((s) => s.method).sort()).toEqual(["prompts/list", "resources/list", "resources/templates/list", "tools/list"]);
    for (const s of echoed) expect(paramsOf(s)["cursor"]).toBe(cursor);
    await client.close();
  });

  it("list pages are sent as idempotent requests and malformed pages are protocol-violation", async () => {
    const { client, transport } = makeClient();
    const ops = createOps(client);
    const p = ops.tools.list({ cursor: "c" });
    await settle();
    expect(paramsOf(transport.sent[0])).toEqual({ cursor: "c" });
    transport.reply({ tools: "nope" });
    expect(await p).toMatchObject({ kind: "protocol-violation" });

    const q = ops.prompts.list();
    await settle();
    transport.reply({ prompts: [], nextCursor: 7 });
    expect(await q).toMatchObject({ kind: "protocol-violation" });
    await client.close();
  });
});
