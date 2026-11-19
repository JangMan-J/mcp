/**
 * Synthetic stdio MCP server driver for Tier B conformance tests (IMPLEMENTATION_PLAN §13.3).
 * Test fixture only — not exported or shipped. Uses only node:* built-ins.
 */
import { appendFileSync } from "node:fs";

interface CliOpts {
  mode: string;
  logPath?: string;
  noiseLines: number;
  oversizeBytes: number;
  ignoreSigterm: boolean;
  partial: boolean;
  longStderr: boolean;
}

function parseArgs(argv: readonly string[]): CliOpts {
  const opts: CliOpts = {
    mode: "echo",
    noiseLines: 3,
    oversizeBytes: 2048,
    ignoreSigterm: false,
    partial: false,
    longStderr: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode" && argv[i + 1]) {
      opts.mode = argv[++i]!;
    } else if (a === "--log" && argv[i + 1]) {
      opts.logPath = argv[++i]!;
    } else if (a === "--noise-lines" && argv[i + 1]) {
      opts.noiseLines = Number(argv[++i]!);
    } else if (a === "--size" && argv[i + 1]) {
      opts.oversizeBytes = Number(argv[++i]!);
    } else if (a === "--ignore-sigterm") {
      opts.ignoreSigterm = true;
    } else if (a === "--partial") {
      opts.partial = true;
    } else if (a === "--long-stderr") {
      opts.longStderr = true;
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

function record(line: string): void {
  if (!opts.logPath) return;
  try {
    appendFileSync(opts.logPath, `${line}\n`, "utf8");
  } catch {
    // ignore log errors on teardown
  }
}

function sendJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

if (opts.mode === "crash-immediately") {
  record("CRASH_IMMEDIATELY");
  process.exit(1);
}

let keepAlive: ReturnType<typeof setInterval> | undefined;
if (opts.mode === "ignore-stdin-close") {
  keepAlive = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => {
    record("SIGNAL:SIGTERM");
    if (!opts.ignoreSigterm) {
      if (keepAlive) clearInterval(keepAlive);
      setTimeout(() => process.exit(0), 15);
    }
  });
}

let reqCounter = 0;
let heldFirst: { id: string | number; method: string; params: Record<string, unknown> } | undefined;
let activeSubReq: { id: string | number; subId: string } | undefined;

function handleMessage(msg: Record<string, unknown>): void {
  const method = typeof msg["method"] === "string" ? msg["method"] : "";
  const hasId = "id" in msg && (typeof msg["id"] === "string" || typeof msg["id"] === "number");
  const id = hasId ? (msg["id"] as string | number) : undefined;
  const params =
    typeof msg["params"] === "object" && msg["params"] !== null
      ? (msg["params"] as Record<string, unknown>)
      : {};

  // Notification from client (e.g., notifications/cancelled)
  if (!hasId) {
    record(`NOTIF:${method}:${JSON.stringify(params)}`);
    return;
  }

  reqCounter += 1;

  if (opts.mode === "crash-on-request") {
    if (opts.partial) {
      process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"trun`);
    }
    process.exit(1);
  }

  if (opts.mode === "split-multibyte") {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { resultType: "complete", text: "Hello 🌍 日本語 café 🚀" },
    });
    const buf = Buffer.from(`${payload}\r\n`, "utf8");
    // Find the 4-byte emoji 🌍 (0xF0 0x9F 0x8C 0x8D) and split right through it
    const emojiIdx = buf.indexOf(Buffer.from("🌍", "utf8"));
    const cut1 = emojiIdx >= 0 ? emojiIdx + 2 : Math.floor(buf.length / 3);
    const cut2 = cut1 + 5;
    process.stdout.write(buf.subarray(0, cut1));
    setTimeout(() => {
      process.stdout.write(buf.subarray(cut1, cut2));
      setTimeout(() => {
        process.stdout.write(buf.subarray(cut2));
      }, 10);
    }, 10);
    return;
  }

  if (opts.mode === "noise") {
    for (let i = 0; i < opts.noiseLines; i++) {
      process.stdout.write(`server debug banner line ${i}\n`);
    }
    sendJson({ jsonrpc: "2.0", id, result: { resultType: "complete", afterNoise: true } });
    return;
  }

  if (opts.mode === "oversize") {
    const filler = "x".repeat(opts.oversizeBytes);
    sendJson({ jsonrpc: "2.0", id, result: { resultType: "complete", filler } });
    return;
  }

  if (opts.mode === "batch") {
    sendJson([{ jsonrpc: "2.0", id, result: { resultType: "complete" } }]);
    return;
  }

  if (opts.mode === "stderr") {
    process.stderr.write("stderr-info-line-1\n");
    process.stderr.write("stderr-info-line-2\r\n");
    if (opts.longStderr) {
      process.stderr.write(`${"E".repeat(6000)}\n`);
    }
    sendJson({ jsonrpc: "2.0", id, result: { resultType: "complete", stderrEmitted: true } });
    return;
  }

  if (opts.mode === "out-of-order") {
    if (reqCounter === 1) {
      heldFirst = { id: id!, method, params };
      return;
    }
    // Reply to second request first, then first request
    sendJson({ jsonrpc: "2.0", id, result: { resultType: "complete", order: "second", name: params["name"] } });
    if (heldFirst) {
      const first = heldFirst;
      heldFirst = undefined;
      setTimeout(() => {
        sendJson({
          jsonrpc: "2.0",
          id: first.id,
          result: { resultType: "complete", order: "first", name: first.params["name"] },
        });
      }, 15);
    }
    return;
  }

  if (opts.mode === "progress") {
    const meta =
      typeof params["_meta"] === "object" && params["_meta"] !== null
        ? (params["_meta"] as Record<string, unknown>)
        : {};
    const token = meta["io.modelcontextprotocol/progressToken"];
    if (token !== undefined) {
      sendJson({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress: 1, total: 3, message: "step 1" },
      });
      sendJson({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress: 2, total: 3, message: "step 2" },
      });
      sendJson({
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress: 3, total: 3, message: "step 3" },
      });
    }
    sendJson({ jsonrpc: "2.0", id, result: { resultType: "complete", progressed: true } });
    return;
  }

  if (opts.mode === "subscription") {
    const meta =
      typeof params["_meta"] === "object" && params["_meta"] !== null
        ? (params["_meta"] as Record<string, unknown>)
        : {};
    const subId =
      typeof meta["io.modelcontextprotocol/subscriptionId"] === "string"
        ? (meta["io.modelcontextprotocol/subscriptionId"] as string)
        : typeof params["subscriptionId"] === "string"
          ? (params["subscriptionId"] as string)
          : undefined;

    if (method === "subscriptions/listen" && subId) {
      activeSubReq = { id: id!, subId };
      sendJson({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "file:///a.txt", _meta: { "io.modelcontextprotocol/subscriptionId": subId } },
      });
      return;
    }

    // Interleaved regular request: emit another sub notification, respond to regular request, then complete sub
    if (activeSubReq) {
      sendJson({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri: "file:///b.txt", _meta: { "io.modelcontextprotocol/subscriptionId": activeSubReq.subId } },
      });
    }
    sendJson({ jsonrpc: "2.0", id, result: { resultType: "complete", interleaved: true } });
    if (activeSubReq) {
      const s = activeSubReq;
      activeSubReq = undefined;
      setTimeout(() => {
        sendJson({ jsonrpc: "2.0", id: s.id, result: { resultType: "complete", ended: "done" } });
      }, 15);
    }
    return;
  }

  if (opts.mode === "cancel-delay") {
    // Hold response so client can cancel while in-flight
    setTimeout(() => {
      sendJson({ jsonrpc: "2.0", id, result: { resultType: "complete", late: true } });
    }, 5000).unref();
    return;
  }

  if (opts.mode === "server-request") {
    sendJson({ jsonrpc: "2.0", id: "srv-ping-1", method: "ping", params: {} });
    setTimeout(() => {
      sendJson({ jsonrpc: "2.0", id, result: { resultType: "complete", afterServerReq: true } });
    }, 30);
    return;
  }

  if (opts.mode === "env-echo") {
    sendJson({ jsonrpc: "2.0", id, result: { resultType: "complete", env: process.env } });
    return;
  }

  // Default echo / discover
  if (method === "server/discover") {
    sendJson({
      jsonrpc: "2.0",
      id,
      result: {
        resultType: "complete",
        cacheScope: "private",
        capabilities: { tools: {} },
        supportedVersions: ["2026-07-28"],
        ttlMs: 60000,
      },
    });
    return;
  }

  sendJson({
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      method,
      params,
      pid: process.pid,
    },
  });
}

let lineBuf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  lineBuf += chunk;
  while (true) {
    const idx = lineBuf.indexOf("\n");
    if (idx < 0) break;
    const rawLine = lineBuf.slice(0, idx).replace(/\r$/, "");
    lineBuf = lineBuf.slice(idx + 1);
    record(`STDIN:${rawLine}`);
    try {
      const parsed = JSON.parse(rawLine) as Record<string, unknown>;
      handleMessage(parsed);
    } catch {
      record(`STDIN_PARSE_ERROR:${rawLine}`);
    }
  }
});

process.stdin.on("end", () => {
  record("STDIN_EOF");
  if (opts.mode !== "ignore-stdin-close") {
    process.exit(0);
  }
});
