import { describe, expect, it, vi } from "vitest";
import type { AuthProvider } from "@mcp-client/core";
import {
  StatefulClient,
  type FormRequest,
  type RequestFn,
  type UrlConsentRequest,
} from "../src/index.js";

const meta = { binding: "test", requestId: 1, method: "tools/call", attempts: 1 };
const URL_ = "https://xn--bcher-kva.example/login/path?q=1&token=from-url#frag";
const urlRound = {
  resultType: "input_required",
  requestState: "s1",
  inputRequests: {
    visit: { method: "elicitation/create", params: { mode: "url", message: "Sign in", url: URL_ } },
  },
};
const schema = {
  type: "object",
  properties: { city: { type: "string", minLength: 1, default: "Oslo" } },
  required: ["city"],
};
const formRound = {
  resultType: "input_required",
  requestState: "s1",
  inputRequests: { pick: { method: "elicitation/create", params: { message: "Choose a city", requestedSchema: schema } } },
};

function wire(first: unknown) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const request = vi.fn<RequestFn>(async (method, params) => {
    sent.push({ method, params: structuredClone(params) as Record<string, unknown> });
    return {
      kind: "ok",
      value: sent.length === 1 ? first : { resultType: "complete", content: [] },
      meta,
    } as never;
  });
  return { sent, request };
}

describe("CONSENT-5", () => {
  it.each(["accept", "decline"] as const)(
    "[CONSENT-5] url-elicitation payload carries full URL, highlighted host, punycode warning; no pre-fetch; no open before accept (%s)",
    async (decision) => {
      const events: string[] = [];
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      const prompts: UrlConsentRequest[] = [];
      const { sent, request } = wire(urlRound);
      const client = new StatefulClient({
        request,
        serverRef: "srv",
        serverLabel: "Configured Server",
        port: {
          url: async (p) => {
            events.push("prompt");
            prompts.push(p);
            return decision;
          },
        },
        browser: { open: async (u) => void events.push(`open ${u}`) },
      });
      const out = await client.request("tools/call", { name: "t" });
      expect(out.kind).toBe("ok");
      expect(prompts).toEqual([
        {
          serverLabel: "Configured Server",
          message: "Sign in",
          url: URL_,
          hostHighlight: "xn--bcher-kva.example",
          punycodeWarning: true,
        },
      ]);
      expect(events).toEqual(decision === "accept" ? ["prompt", `open ${URL_}`] : ["prompt"]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sent.map((s) => s.method)).toEqual(["tools/call", "tools/call"]);
      expect(sent[1]!.params.inputResponses).toEqual({ visit: { action: decision } });
      fetchSpy.mockRestore();
    },
  );
  it("[CONSENT-5] control: ASCII host has no punycode warning", async () => {
    const prompts: UrlConsentRequest[] = [];
    const ascii = structuredClone(urlRound);
    ascii.inputRequests.visit.params.url = "https://books.example/a";
    const client = new StatefulClient({
      request: wire(ascii).request,
      serverRef: "srv",
      serverLabel: "S",
      port: { url: async (p) => (prompts.push(p), "cancel") },
      browser: { open: async () => {} },
    });
    await client.request("tools/call", { name: "t" });
    expect(prompts[0]).toMatchObject({ hostHighlight: "books.example", punycodeWarning: false });
  });
});

describe("CONSENT-7", () => {
  it("[CONSENT-7] form-elicitation payload carries server label, message, schema; the user's modified content is what is sent", async () => {
    const prompts: FormRequest[] = [];
    const { sent, request } = wire(formRound);
    const client = new StatefulClient({
      request,
      serverRef: "srv",
      serverLabel: "Configured Server",
      port: {
        form: async (p) => {
          prompts.push(structuredClone(p));
          // The user reviews the prefilled default and edits it before sending.
          return { action: "accept", content: { ...p.defaults, city: "Bergen" } };
        },
      },
    });
    const out = await client.request("tools/call", { name: "t" });
    expect(out.kind).toBe("ok");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({
      serverLabel: "Configured Server",
      message: "Choose a city",
      schema,
      defaults: { city: "Oslo" },
    });
    expect(sent[1]!.params.inputResponses).toEqual({ pick: { action: "accept", content: { city: "Bergen" } } });
  });
});

describe("AUTH-SEP-1", () => {
  it("[AUTH-SEP-1] an accepted URL elicitation never touches the auth provider and the bearer stays the same", async () => {
    const auth = {
      contextId: vi.fn(() => "grant-1"),
      headerFor: vi.fn(async () => ({ authorization: "Bearer original", contextId: "grant-1", credentialVersion: {} })),
      onChallenge: vi.fn(async () => true),
    } satisfies Pick<AuthProvider, "contextId" | "headerFor" | "onChallenge">;
    const headers: (string | undefined)[] = [];
    const { sent, request: inner } = wire(urlRound);
    const request: RequestFn = async (method, params, opts) => {
      headers.push((await auth.headerFor())?.authorization);
      return inner(method, params, opts);
    };
    const opened: string[] = [];
    const client = new StatefulClient({
      request,
      serverRef: "srv",
      serverLabel: "S",
      auth,
      port: { url: async () => "accept" },
      browser: { open: async (u) => void opened.push(u) },
    });
    const out = await client.request("tools/call", { name: "t" });
    expect(out.kind).toBe("ok");
    expect(opened).toEqual([URL_]);
    expect(headers).toEqual(["Bearer original", "Bearer original"]);
    expect(auth.onChallenge).not.toHaveBeenCalled();
    expect(auth.contextId.mock.results.map((r) => r.value)).toEqual(["grant-1", "grant-1"]);
    // Nothing from the URL (including its token query) is sent back as a credential.
    expect(JSON.stringify(sent[1])).not.toContain("from-url");
    expect(sent[1]!.params.inputResponses).toEqual({ visit: { action: "accept" } });
  });
});
