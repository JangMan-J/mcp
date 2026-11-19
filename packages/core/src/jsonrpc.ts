import type { RequestId } from "./schema/index.js";

export type { RequestId };

export const JSONRPC_VERSION = "2.0" as const;
export const SUPPORTED_PROTOCOL_VERSION = "2026-07-28" as const;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: RequestId;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: RequestId;
  readonly result: Record<string, unknown>;
}

export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: RequestId | null;
  readonly error: JsonRpcErrorBody;
}

export type JsonRpcInbound = JsonRpcResponse | JsonRpcErrorResponse | JsonRpcNotification | JsonRpcRequest;

export type IdGenerator = () => RequestId;

/**
 * Per-client monotonic integer id generator keeping all values strictly < 2^53 (EDGE-12).
 */
export function createMonotonicIdGenerator(start = 1): IdGenerator {
  let next = start;
  return () => {
    if (!Number.isSafeInteger(next) || next >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("RequestId exhausted safe integer range");
    }
    const id = next;
    next += 1;
    return id;
  };
}

export function isValidRequestId(id: unknown): id is RequestId {
  if (typeof id === "string") return id.length > 0;
  if (typeof id === "number") return Number.isFinite(id) && Number.isInteger(id);
  return false;
}

/**
 * Validates that an outbound object is a JSON-RPC request (never a response envelope, WIRE-DIR-1).
 */
export function assertOutboundRequest(msg: unknown): asserts msg is JsonRpcRequest {
  if (typeof msg !== "object" || msg === null) {
    throw new TypeError("Outbound JSON-RPC request must be an object");
  }
  const rec = msg as Record<string, unknown>;
  if ("result" in rec || "error" in rec) {
    throw new TypeError("Clients MUST NOT send JSON-RPC response envelopes (WIRE-DIR-1)");
  }
  if (rec["jsonrpc"] !== JSONRPC_VERSION) {
    throw new TypeError("Outbound request jsonrpc must be '2.0'");
  }
  if (!isValidRequestId(rec["id"])) {
    throw new TypeError("Outbound request id must be non-empty string or integer, never null (WIRE-ID-1)");
  }
  if (typeof rec["method"] !== "string" || rec["method"].length === 0) {
    throw new TypeError("Outbound request method must be a non-empty string");
  }
}

export interface ParsedInbound {
  readonly kind: "response" | "error" | "notification" | "server-request";
  readonly message: JsonRpcInbound;
  readonly diagnostics: readonly string[];
}

export function parseInboundMessage(raw: unknown): ParsedInbound | { readonly error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "JSON-RPC message must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  if (obj["jsonrpc"] !== JSONRPC_VERSION) {
    return { error: "jsonrpc must equal '2.0'" };
  }
  const diagnostics: string[] = [];
  if ("id" in obj) {
    const id = obj["id"];
    if (typeof id === "number" && !Number.isSafeInteger(id)) {
      diagnostics.push(`unsafe-integer-id:${String(id)}`);
    }
    if (typeof obj["method"] === "string") {
      return { kind: "server-request", message: obj as unknown as JsonRpcRequest, diagnostics };
    }
    if ("error" in obj && typeof obj["error"] === "object" && obj["error"] !== null) {
      if (id === null) {
        diagnostics.push("error-response-null-id");
      }
      return { kind: "error", message: obj as unknown as JsonRpcErrorResponse, diagnostics };
    }
    if ("result" in obj && typeof obj["result"] === "object" && obj["result"] !== null) {
      if (!isValidRequestId(id)) {
        return { error: "Response id must be string or integer" };
      }
      return { kind: "response", message: obj as unknown as JsonRpcResponse, diagnostics };
    }
    return { error: "Invalid JSON-RPC message with id" };
  }
  if (typeof obj["method"] === "string") {
    return { kind: "notification", message: obj as unknown as JsonRpcNotification, diagnostics };
  }
  return { error: "Notification missing string method" };
}
