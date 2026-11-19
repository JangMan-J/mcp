import { describe, expect, it } from "vitest";
import { HttpTransport } from "../src/index.js";
import { createHttpTestServer } from "../../fixtures/server/http-main.ts";
import { formatSseComment } from "../../fixtures/server/sse.ts";

describe("http edge cases", () => {
  it("[EDGE-7] abort mid-SSE closes the stream and sends no notifications/cancelled", async () => {
    let closed = false;
    const srv = await createHttpTestServer({
      handler: (req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(formatSseComment());
        req.socket.once("close", () => { closed = true; });
        res.once("close", () => { closed = true; });
      },
    });
    try {
      const t = new HttpTransport({ url: srv.url });
      const ac = new AbortController();
      const ex = t.start({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "w" } }, { signal: ac.signal, idempotent: false, timeoutMs: 60_000 });
      setTimeout(() => ac.abort("user"), 50);
      const end = await ex.done;
      expect(end.kind).toBe("failure");
      await new Promise((r) => setTimeout(r, 100));
      expect(closed).toBe(true);
      expect(srv.requests).toHaveLength(1);
      expect(JSON.stringify(srv.requests)).not.toContain("notifications/cancelled");
    } finally {
      await srv.close();
    }
  });
});
