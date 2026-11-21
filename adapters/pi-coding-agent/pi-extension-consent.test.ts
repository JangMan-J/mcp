// PICA (plan 15.2 adapter responsibilities), ELIC-URL-3/ELIC-URL-4: MRTR URL elicitation reaches the consent port with the full URL.
import { describe, expect, it } from "vitest";
import { JSONRPC_VERSION, type ConsentPort, type ConsentPrompt, type ConsentResult, type ExchangeEnd, type JsonRpcRequest, type Transport } from "@mcp-client/core";
import { createLiveMcpServerRuntime } from "./pi-extension.js";
import { renderOutcome } from "./results.js";

const URL_ASKED = "https://auth.example.com/consent?session=abc123&scope=files";
const emptyIter = <T>(): AsyncIterable<T> => ({ async *[Symbol.asyncIterator]() {} });
const respond = (msg: JsonRpcRequest, result: Record<string, unknown>): ExchangeEnd => ({ kind: "response", message: { jsonrpc: JSONRPC_VERSION, id: msg.id, result } });

function fakeServer(calls: Record<string, unknown>[]): Transport {
  const handler = (msg: JsonRpcRequest): ExchangeEnd => {
    if (msg.method === "server/discover") return respond(msg, { resultType: "complete", cacheScope: "public", ttlMs: 60_000, supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
    if (msg.method !== "tools/call") return respond(msg, {});
    const params = (msg.params ?? {}) as Record<string, any>;
    calls.push(params);
    const responses = params.inputResponses as Record<string, { action: string }> | undefined;
    if (!responses) {
      return respond(msg, {
        resultType: "input_required",
        requestState: "state-1",
        inputRequests: { auth: { method: "elicitation/create", params: { mode: "url", message: "Authorize access", url: URL_ASKED } } },
      });
    }
    const action = responses.auth?.action;
    if (action === "accept") return respond(msg, { resultType: "complete", content: [{ type: "text", text: "retried-ok" }] });
    return respond(msg, { resultType: "complete", isError: true, content: [{ type: "text", text: `user ${action}` }] });
  };
  return {
    binding: "stdio",
    diagnostics: emptyIter(),
    start(msg) { return { notifications: emptyIter(), done: Promise.resolve().then(() => handler(msg)) }; },
    async notify() {},
    async close() {},
  };
}

async function run(decision: ConsentResult["decision"]) {
  const prompts: ConsentPrompt[] = [];
  const calls: Record<string, unknown>[] = [];
  const consent: ConsentPort = { async request(p) { prompts.push(p); return { decision }; } };
  const rt = await createLiveMcpServerRuntime(
    { name: "srv", source: "global", trusted: true, transport: "stdio", enabled: true, exposure: "direct", command: "fake" },
    { consent, createTransport: () => fakeServer(calls) },
  );
  await rt.ready();
  const outcome = await rt.ops.tools.call("login", {});
  await rt.close();
  return { prompts, calls, outcome, rendered: await renderOutcome<unknown>(outcome.kind === "ok" ? { ...outcome, value: outcome.value.raw } : outcome, { server: "srv" }) };
}

describe("createLiveMcpServerRuntime URL elicitation consent", () => {
  it("accept: consent sees the full URL and the retried result is returned", async () => {
    const { prompts, calls, outcome, rendered } = await run("accept");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ kind: "url-elicitation", serverLabel: "srv", url: URL_ASKED });
    expect(calls).toHaveLength(2);
    expect(outcome.kind).toBe("ok");
    expect(rendered.isError).toBe(false);
    expect(rendered.content[0]).toMatchObject({ text: expect.stringContaining("retried-ok") });
  });

  it.each(["decline", "cancel"] as const)("%s: rendered as a tool error, never mrtr-interim", async (decision) => {
    const { prompts, outcome, rendered } = await run(decision);
    expect(prompts).toHaveLength(1);
    expect(outcome.kind).not.toBe("mrtr-interim");
    expect(rendered.isError).toBe(true);
    const text = (rendered.content[0] as { text: string }).text;
    expect(text).toContain(`user ${decision}`);
    expect(text).not.toContain("mrtr-interim");
  });
});
