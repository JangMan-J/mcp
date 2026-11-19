import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, vi } from "vitest";
import {
  McpClient,
  type Exchange,
  type ExchangeEnd,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type Transport,
  type TransportCall,
  type TransportDiagnostic,
} from "@mcp-client/core";

const emptyNotifications: AsyncIterable<JsonRpcNotification> = {
  async *[Symbol.asyncIterator]() {},
};

interface Pending {
  readonly req: JsonRpcRequest;
  readonly resolve: (end: ExchangeEnd) => void;
}

/** In-proc scripted transport. Requests wait until the test answers them. */
export class ScriptTransport implements Transport {
  readonly binding = "stdio" as const;
  readonly sent: JsonRpcRequest[] = [];
  readonly pending: Pending[] = [];
  readonly diagnostics: AsyncIterable<TransportDiagnostic> = {
    async *[Symbol.asyncIterator]() {},
  };
  /** Optional auto-responder; when set, requests are answered immediately. */
  constructor(private readonly auto?: (req: JsonRpcRequest) => ExchangeEnd | undefined) {}

  start(msg: JsonRpcRequest, ctx?: TransportCall): Exchange {
    this.sent.push(msg);
    let resolve!: (end: ExchangeEnd) => void;
    const done = new Promise<ExchangeEnd>((r) => (resolve = r));
    const auto = this.auto?.(msg);
    if (auto) {
      resolve(auto);
      return { notifications: emptyNotifications, done };
    }
    const entry: Pending = { req: msg, resolve };
    this.pending.push(entry);
    // Like a real transport, an aborted exchange ends without a response.
    ctx?.signal?.addEventListener(
      "abort",
      () => {
        const i = this.pending.indexOf(entry);
        if (i < 0) return;
        this.pending.splice(i, 1);
        resolve({ kind: "failure", failure: { kind: "closed", message: "aborted" }, delivery: "maybe-delivered" });
      },
      { once: true },
    );
    return { notifications: emptyNotifications, done };
  }

  async notify(): Promise<void> {}

  async close(): Promise<void> {
    this.failAll();
  }

  /** Answer the oldest pending request. */
  reply(result: Record<string, unknown>): void {
    const p = this.take();
    p.resolve({ kind: "response", message: { jsonrpc: "2.0", id: p.req.id, result } });
  }

  replyError(error: { code: number; message: string; data?: unknown }): void {
    const p = this.take();
    p.resolve({ kind: "response", message: { jsonrpc: "2.0", id: p.req.id, error } });
  }

  failAll(): void {
    for (const p of this.pending.splice(0)) {
      p.resolve({ kind: "failure", failure: { kind: "closed", message: "script ended" }, delivery: "not-sent" });
    }
  }

  private take(): Pending {
    const p = this.pending.shift();
    if (!p) throw new Error("no pending request to answer");
    return p;
  }
}

export const ok = (result: Record<string, unknown>) => (req: JsonRpcRequest): ExchangeEnd => ({
  kind: "response",
  message: { jsonrpc: "2.0", id: req.id, result },
});

export const err = (code: number, message = "error", data?: unknown) => (req: JsonRpcRequest): ExchangeEnd => ({
  kind: "response",
  message: { jsonrpc: "2.0", id: req.id, error: { code, message, ...(data !== undefined ? { data } : {}) } },
});

export function makeClient(auto?: (req: JsonRpcRequest) => ExchangeEnd | undefined): {
  client: McpClient;
  transport: ScriptTransport;
} {
  const transport = new ScriptTransport(auto);
  const client = new McpClient({ transport, server: { key: "test" } });
  return { client, transport };
}

/** Params as sent, without the core-owned _meta. */
export function paramsOf(req: JsonRpcRequest | undefined): Record<string, unknown> {
  const { _meta, ...rest } = (req?.params ?? {}) as Record<string, unknown>;
  void _meta;
  return rest;
}

export async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

/**
 * Network spy for OPS-RES-5 / OPS-SCHEMA-4: ops must reach the network only through the
 * Transport. Any call to fetch or the node socket/http/dns APIs fails the file.
 */
export function installNetworkSpy(): void {
  const require = createRequire(import.meta.url);
  const spies: { name: string; spy: ReturnType<typeof vi.fn> }[] = [];
  const restore: (() => void)[] = [];
  const trap = (obj: Record<string, unknown>, key: string, label: string): void => {
    if (typeof obj[key] !== "function") return;
    const original = obj[key];
    const spy = vi.fn(() => {
      throw new Error(`network access attempted: ${label}`);
    });
    obj[key] = spy;
    spies.push({ name: label, spy });
    restore.push(() => {
      obj[key] = original;
    });
  };
  beforeAll(() => {
    trap(globalThis as unknown as Record<string, unknown>, "fetch", "fetch");
    for (const mod of ["node:net", "node:tls"]) {
      const m = require(mod) as Record<string, unknown>;
      trap(m, "connect", `${mod}.connect`);
      trap(m, "createConnection", `${mod}.createConnection`);
    }
    for (const mod of ["node:http", "node:https"]) {
      const m = require(mod) as Record<string, unknown>;
      trap(m, "request", `${mod}.request`);
      trap(m, "get", `${mod}.get`);
    }
    const dns = require("node:dns") as Record<string, unknown>;
    trap(dns, "lookup", "node:dns.lookup");
    trap(dns, "resolve", "node:dns.resolve");
  });
  afterAll(() => {
    for (const r of restore.splice(0)) r();
    const used = spies.filter((s) => s.spy.mock.calls.length > 0).map((s) => s.name);
    expect(used, "ops must not touch the network").toEqual([]);
  });
}
