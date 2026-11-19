import { describe, expect, it } from "vitest";
import {
  RequestManager,
  type Clock,
  type ExchangeEnd,
  type JsonRpcNotification,
  type ProgressEvent,
  type Transport,
  type TransportDiagnostic,
} from "../src/index.js";

function makeFakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void; live: boolean }[] = [];
  const clock: Clock = {
    now: () => now,
    setTimeout(fn, ms) {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      due.fn();
    }
    timers = timers.filter((t) => t.live);
    now = target;
  };
  return { clock, advance };
}

describe("[LIM-PROG-1] progress delivery rate limit", () => {
  it("[LIM-PROG-1] 200 notifications in 1 s fake time -> <=51 callbacks, monotonic, final delivered", async () => {
    const fc = makeFakeClock();
    const transport: Transport = {
      binding: "stdio",
      start(req) {
        let resolve!: (e: ExchangeEnd) => void;
        const done = new Promise<ExchangeEnd>((r) => (resolve = r));
        const token = (req.params?.["_meta"] as Record<string, unknown>)["io.modelcontextprotocol/progressToken"];
        const notifications: AsyncIterable<JsonRpcNotification> = {
          async *[Symbol.asyncIterator]() {
            for (let i = 1; i <= 200; i++) {
              fc.advance(5);
              yield {
                jsonrpc: "2.0",
                method: "notifications/progress",
                params: { progressToken: token as string, progress: i, total: 200 },
              };
            }
            resolve({ kind: "response", message: { jsonrpc: "2.0", id: req.id, result: {} } });
          },
        };
        return { notifications, done };
      },
      async notify() {},
      async close() {},
      diagnostics: { async *[Symbol.asyncIterator](): AsyncIterator<TransportDiagnostic> {} },
    };
    const client = new RequestManager({ transport, clientInfo: false, ports: { clock: fc.clock } });
    const seen: { at: number; p: number }[] = [];
    const out = await client.request("tools/list", {}, {
      idempotent: true,
      onProgress: (e: ProgressEvent) => seen.push({ at: fc.clock.now(), p: e.progress }),
    });
    expect(out.kind).toBe("ok");
    expect(seen.length).toBeLessThanOrEqual(51);
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.p).toBeGreaterThan(seen[i - 1]!.p);
      if (i < seen.length - 1) expect(seen[i]!.at - seen[i - 1]!.at).toBeGreaterThanOrEqual(20);
    }
    expect(seen[seen.length - 1]!.p).toBe(200);
  });
});
