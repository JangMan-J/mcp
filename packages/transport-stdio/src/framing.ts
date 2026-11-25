import {
  assertOutboundRequest,
  JSONRPC_VERSION,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "@mcp/core";

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024; // 16 MiB (STDIO-LIMIT-1)

/**
 * Validates that an outbound notification is a valid JSON-RPC 2.0 notification
 * (never a response envelope, WIRE-DIR-1 / STDIO-STDIN-1).
 */
export function assertOutboundNotification(msg: unknown): asserts msg is JsonRpcNotification {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    throw new TypeError("Outbound JSON-RPC notification must be an object");
  }
  const rec = msg as Record<string, unknown>;
  if ("result" in rec || "error" in rec) {
    throw new TypeError("Clients MUST NOT send JSON-RPC response envelopes (WIRE-DIR-1)");
  }
  if ("id" in rec) {
    throw new TypeError("Outbound JSON-RPC notification must not carry an id");
  }
  if (rec["jsonrpc"] !== JSONRPC_VERSION) {
    throw new TypeError("Outbound notification jsonrpc must be '2.0'");
  }
  if (typeof rec["method"] !== "string" || rec["method"].length === 0) {
    throw new TypeError("Outbound notification method must be a non-empty string");
  }
}

/**
 * Encodes an outbound JSON-RPC request or notification as a single UTF-8 line
 * terminated by `\n`, asserting no embedded raw newline or carriage return (STDIO-FRAME-1).
 */
export function encodeStdioMessage(msg: JsonRpcRequest | JsonRpcNotification): string {
  if ("id" in msg) {
    assertOutboundRequest(msg);
  } else {
    assertOutboundNotification(msg);
  }
  const json = JSON.stringify(msg);
  if (json.includes("\n") || json.includes("\r")) {
    throw new Error("Encoded JSON-RPC message must not contain embedded CR/LF (STDIO-FRAME-1)");
  }
  return `${json}\n`;
}

export type LineSplitterEvent =
  | { readonly kind: "line"; readonly text: string; readonly byteLength: number }
  | { readonly kind: "invalid-utf8"; readonly byteLength: number; readonly preview: string }
  | { readonly kind: "oversize"; readonly byteLength: number; readonly maxLineBytes: number };

/**
 * Incremental byte-safe newline-delimited UTF-8 splitter (STDIO-FRAME-2, STDIO-LIMIT-1).
 * Handles multi-byte UTF-8 sequences split across arbitrary chunk boundaries, trims
 * trailing `\r` from `\r\n`, detects invalid UTF-8 (EDGE-11), and enforces `maxLineBytes`.
 */
export class LineSplitter {
  private readonly maxLineBytes: number;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private chunks: Uint8Array[] = [];
  private bufferedBytes = 0;
  private failedOversize = false;

  constructor(maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
    if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) {
      throw new RangeError("maxLineBytes must be a positive integer");
    }
    this.maxLineBytes = maxLineBytes;
  }

  get pendingBytes(): number {
    return this.bufferedBytes;
  }

  push(chunk: Uint8Array): LineSplitterEvent[] {
    if (this.failedOversize || chunk.byteLength === 0) {
      return [];
    }
    const events: LineSplitterEvent[] = [];
    let start = 0;

    for (let i = 0; i < chunk.byteLength; i++) {
      if (chunk[i] === 0x0a) {
        // Complete line from start..i (excluding 0x0a)
        const slice = chunk.subarray(start, i);
        const lineByteLength = this.bufferedBytes + slice.byteLength;
        if (lineByteLength > this.maxLineBytes) {
          this.failedOversize = true;
          this.chunks = [];
          this.bufferedBytes = 0;
          events.push({ kind: "oversize", byteLength: lineByteLength, maxLineBytes: this.maxLineBytes });
          return events;
        }
        const combined = this.concatWith(slice, lineByteLength);
        this.chunks = [];
        this.bufferedBytes = 0;
        events.push(this.decodeLine(combined));
        start = i + 1;
      }
    }

    if (start < chunk.byteLength) {
      const tail = chunk.subarray(start);
      const nextTotal = this.bufferedBytes + tail.byteLength;
      if (nextTotal > this.maxLineBytes) {
        this.failedOversize = true;
        this.chunks = [];
        this.bufferedBytes = 0;
        events.push({ kind: "oversize", byteLength: nextTotal, maxLineBytes: this.maxLineBytes });
        return events;
      }
      // Copy tail to avoid retaining oversized parent slabs
      const copy = new Uint8Array(tail.byteLength);
      copy.set(tail);
      this.chunks.push(copy);
      this.bufferedBytes = nextTotal;
    }

    return events;
  }

  /**
   * Returns any buffered partial line bytes on EOF as a lossy UTF-8 preview (for crash diagnostics).
   */
  flushRemainderPreview(maxPreviewBytes = 256): { readonly byteLength: number; readonly preview: string } | undefined {
    if (this.bufferedBytes === 0) return undefined;
    const total = this.bufferedBytes;
    const combined = this.concatWith(new Uint8Array(0), total);
    this.chunks = [];
    this.bufferedBytes = 0;
    const sliced = combined.byteLength > maxPreviewBytes ? combined.subarray(0, maxPreviewBytes) : combined;
    const preview = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
    return { byteLength: total, preview };
  }

  reset(): void {
    this.chunks = [];
    this.bufferedBytes = 0;
    this.failedOversize = false;
  }

  private concatWith(tail: Uint8Array, totalLength: number): Uint8Array {
    if (this.chunks.length === 0) {
      return tail;
    }
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    if (tail.byteLength > 0) {
      out.set(tail, offset);
    }
    return out;
  }

  private decodeLine(raw: Uint8Array): LineSplitterEvent {
    let view = raw;
    if (view.byteLength > 0 && view[view.byteLength - 1] === 0x0d) {
      view = view.subarray(0, view.byteLength - 1);
    }
    try {
      const text = this.decoder.decode(view);
      return { kind: "line", text, byteLength: raw.byteLength };
    } catch {
      const sliced = view.byteLength > 256 ? view.subarray(0, 256) : view;
      const preview = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
      return { kind: "invalid-utf8", byteLength: raw.byteLength, preview };
    }
  }
}
