import { expect, test } from "vitest";
import { createDeferredToolRegistry } from "./registry.ts";

function readinessGate() {
  let open!: () => void;
  const ready = new Promise<void>(resolve => { open = resolve; });
  return { ready, open };
}

test("tool_search waits for readiness, then declares only matching deferred tools once", async () => {
  const gate = readinessGate();
  const declared: string[] = [];
  let listed = false;
  const registry = createDeferredToolRegistry([{
    server: "library",
    ready: () => gate.ready,
    async listDeferredTools() {
      listed = true;
      return [{ name: "find", description: "Look up books" }, { name: "members" }];
    },
  }], tool => declared.push(tool.name));

  expect(declared).toEqual([]);
  const pending = registry.search("Books");
  await Promise.resolve();
  expect(listed).toBe(false);
  expect(declared).toEqual([]);

  gate.open();
  expect(await pending).toMatchObject([{ name: "mcp__library__find", server: "library", tool: { name: "find" } }]);
  expect(await registry.search("find")).toHaveLength(1);
  expect(declared).toEqual(["mcp__library__find"]);
});

test("an aborted search cannot declare tools when readiness arrives late", async () => {
  const gate = readinessGate();
  const request = new AbortController();
  const declared: string[] = [];
  const registry = createDeferredToolRegistry([{
    server: "library",
    ready: () => gate.ready,
    async listDeferredTools() { return [{ name: "find" }]; },
  }], tool => declared.push(tool.name));

  const pending = registry.search("find", request.signal);
  request.abort(new Error("search cancelled"));
  gate.open();
  await expect(pending).rejects.toThrow("search cancelled");
  expect(declared).toEqual([]);
});
