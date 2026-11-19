/**
 * Synthetic HTTP MCP server for transport-http tests (IMPLEMENTATION_PLAN §13).
 * Test fixture only — not exported or shipped. Uses only node:* built-ins.
 * Records every request so tests can wire-scan method/headers (no GET, no
 * Last-Event-ID, no Mcp-Session-Id ever expected from the client).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { formatSseComment, formatSseJson } from "./sse.js";

export interface RecordedHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  readonly json?: unknown;
}

export type HttpTestMode =
  | "json"
  | "sse-progress"
  | "sse-comment"
  | "sse-multiline"
  | "sse-id-retry"
  | "sse-break"
  | "status-500"
  | "status-202"
  | "empty-200"
  | "bad-content-type";

export type HttpTestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  recorded: RecordedHttpRequest,
) => void | Promise<void>;

export interface HttpTestServer {
  readonly server: Server;
  readonly url: string;
  readonly port: number;
  readonly requests: RecordedHttpRequest[];
  close(): Promise<void>;
}

export function respondJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

export function respondResult(res: ServerResponse, id: string | number, result: Record<string, unknown>): void {
  respondJson(res, 200, { jsonrpc: "2.0", id, result });
}

export function respondError(
  res: ServerResponse,
  status: number,
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): void {
  respondJson(res, status, {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

function defaultHandler(mode: HttpTestMode): HttpTestHandler {
  return (req, res, recorded) => {
    const msg = (recorded.json ?? {}) as Record<string, unknown>;
    const hasId = "id" in msg && (typeof msg["id"] === "string" || typeof msg["id"] === "number");
    const id = hasId ? (msg["id"] as string | number) : null;
    const params = (msg["params"] ?? {}) as Record<string, unknown>;

    if (!hasId) {
      res.writeHead(202);
      res.end();
      return;
    }
    switch (mode) {
      case "status-500":
        res.writeHead(500, { "content-type": "text/plain", "retry-after": "7" });
        res.end("boom");
        return;
      case "status-202":
        res.writeHead(202);
        res.end();
        return;
      case "empty-200":
        res.writeHead(200, { "content-type": "application/json" });
        res.end();
        return;
      case "bad-content-type":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("hello");
        return;
      case "sse-progress": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const meta = (params["_meta"] ?? {}) as Record<string, unknown>;
        const token = meta["io.modelcontextprotocol/progressToken"] ?? id;
        res.write(
          formatSseJson({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: token, progress: 1, total: 2 },
          }),
        );
        setTimeout(() => {
          res.write(formatSseJson({ jsonrpc: "2.0", id, result: { resultType: "complete", via: "sse" } }));
          res.end();
        }, 5);
        return;
      }
      case "sse-comment": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(formatSseComment("ping"));
        res.write(formatSseJson({ jsonrpc: "2.0", id, result: { resultType: "complete", via: "sse-comment" } }));
        res.end();
        return;
      }
      case "sse-multiline": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        // Multi-line data: joined with \n by the parser, yielding valid JSON split at a token boundary.
        res.write(`data: {"jsonrpc":"2.0",\ndata: "id":${JSON.stringify(id)},"result":{"resultType":"complete","via":"multiline"}}\n\n`);
        res.end();
        return;
      }
      case "sse-id-retry": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(formatSseJson({ jsonrpc: "2.0", id, result: { resultType: "complete", via: "sse-id" } }, { id: "evt-9", retry: 3000 }));
        res.end();
        return;
      }
      case "sse-break": {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(formatSseComment("before-break"));
        // Destroy the socket mid-stream: no final response.
        setTimeout(() => res.socket?.destroy(), 5);
        return;
      }
      case "json":
      default:
        respondResult(res, id!, {
          resultType: "complete",
          method: typeof msg["method"] === "string" ? msg["method"] : "",
          params,
        });
        return;
    }
  };
}

export async function createHttpTestServer(
  opts: { readonly mode?: HttpTestMode; readonly handler?: HttpTestHandler } = {},
): Promise<HttpTestServer> {
  const requests: RecordedHttpRequest[] = [];
  const handler = opts.handler ?? defaultHandler(opts.mode ?? "json");
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      const recorded: RecordedHttpRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body,
        ...(json !== undefined ? { json } : {}),
      };
      requests.push(recorded);
      void Promise.resolve(handler(req, res, recorded)).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// Standalone entry (manual debugging only; tests import createHttpTestServer).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env["MCP_HTTP_TEST_PORT"] ?? 0);
  const srv = await createHttpTestServer({ mode: "json" });
  if (port) srv.server.listen(port, "127.0.0.1");
  console.log(`synthetic http server at ${srv.url}`);
}
