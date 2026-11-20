import { expect, it } from "vitest";
import type { ClientRequest, Outcome, RequestOptions } from "@mcp-client/core";
import { ResourcesApi } from "../../packages/ops/src/resources.ts";
import { createResourceTools } from "./resources.ts";

it("routes each native tool through ready ops, preserving alias, cursor and URI semantics", async () => {
  const uri = "https://example.test/manual";
  const signal = new AbortController().signal;
  const activeSignal = new AbortController().signal;
  const requests: unknown[] = [];
  const replies = new Map([
    ["resources/list", { resources: [{ uri, name: "manual" }], nextCursor: "next" }],
    ["resources/templates/list", { resourceTemplates: [{ uriTemplate: "doc:{id}", name: "template" }] }],
    ["resources/read", { contents: [{ uri, text: "instructions" }] }],
  ]);
  const tools = createResourceTools(alias => alias === "docs" || alias === undefined ? ["library"] : [],
    async (server, operation, requestSignal) => operation(new ResourcesApi({
      request<T>(method: string, params?: Record<string, unknown>, opts?: RequestOptions): ClientRequest<T> {
        requests.push([server, method, params, requestSignal, opts?.signal]);
        const outcome: Outcome<T> = { kind: "ok", value: replies.get(method) as T,
          meta: { requestId: 1, method, binding: "stdio", attempts: 1 } };
        return Object.assign(Promise.resolve(outcome), { id: 1, progress: (async function* () {})(),
          notifications: (async function* () {})(), cancel() {}, signal });
      },
    }), activeSignal));
  expect(tools.map(tool => tool.name)).toEqual(["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"]);
  const [list, templates, read] = tools;
  expect((await list.execute("1", { server: "docs", cursor: "" }, signal)).structuredContent).toEqual({
    server: "library", resources: [{ server: "library", uri, name: "manual" }], nextCursor: "next",
  });
  expect((await templates.execute("2", {}, signal)).structuredContent).toMatchObject({ resourceTemplates: [{ server: "library", name: "template" }] });
  expect((await read.execute("3", { server: "docs", uri }, signal)).structuredContent).toEqual({ server: "library", uri, contents: [{ uri, text: "instructions" }] });
  await expect(read.execute("4", { server: "missing", uri }, signal)).rejects.toThrow("Unknown MCP resource server: missing");
  expect(requests).toEqual([["library", "resources/list", { cursor: "" }, signal, activeSignal],
    ["library", "resources/templates/list", {}, signal, activeSignal],
    ["library", "resources/read", { uri }, signal, activeSignal]]);
});
