export const DEFAULT_STDERR_MAX_BYTES = 64 * 1024; // 64 KiB
export const DEFAULT_STDERR_MAX_LINE_BYTES = 4 * 1024; // 4 KiB

interface RingEntry {
  readonly line: string;
  readonly bytes: number;
}

/**
 * Bounded stderr ring buffer with per-line cap (STDIO-STDERR-1, STDIO-STDERR-2).
 * Never treats stderr as a protocol error.
 */
export class StderrRingBuffer {
  private readonly maxTotalBytes: number;
  private readonly maxLineBytes: number;
  private readonly onLine?: (line: string) => void;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly entries: RingEntry[] = [];
  private totalBytes = 0;
  private pendingChunks: Uint8Array[] = [];
  private pendingBytes = 0;
  private truncated = false;

  constructor(opts?: {
    readonly maxTotalBytes?: number;
    readonly maxLineBytes?: number;
    readonly onLine?: (line: string) => void;
  }) {
    this.maxTotalBytes = opts?.maxTotalBytes ?? DEFAULT_STDERR_MAX_BYTES;
    this.maxLineBytes = opts?.maxLineBytes ?? DEFAULT_STDERR_MAX_LINE_BYTES;
    if (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < 0 ||
        !Number.isSafeInteger(this.maxLineBytes) || this.maxLineBytes < 1) {
      throw new RangeError("stderr limits require a nonnegative total and positive line cap");
    }
    if (opts?.onLine) {
      this.onLine = opts.onLine;
    }
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    let start = 0;
    for (let i = 0; i < chunk.byteLength; i++) {
      if (chunk[i] === 0x0a) {
        const part = chunk.subarray(start, i);
        this.emitBufferedLine(part);
        start = i + 1;
      }
    }
    if (start < chunk.byteLength) {
      const tail = chunk.subarray(start);
      this.truncated ||= this.pendingBytes + tail.byteLength > this.maxLineBytes;
      if (this.pendingBytes < this.maxLineBytes) {
        const take = Math.min(tail.byteLength, this.maxLineBytes - this.pendingBytes);
        const copy = new Uint8Array(take);
        copy.set(tail.subarray(0, take));
        this.pendingChunks.push(copy);
        this.pendingBytes += take;
      }
    }
  }

  flush(): void {
    if (this.pendingBytes > 0) {
      this.emitBufferedLine(new Uint8Array(0));
    }
  }

  snapshot(): readonly string[] {
    return this.entries.map((e) => e.line);
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  private emitBufferedLine(tail: Uint8Array): void {
    const cap = this.maxLineBytes;
    const rawTotal = this.pendingBytes + tail.byteLength;
    const truncated = this.truncated || rawTotal > cap;
    this.truncated = false;
    const takeLen = Math.min(rawTotal, cap);
    const buf = new Uint8Array(takeLen);
    let offset = 0;
    for (const c of this.pendingChunks) {
      const n = Math.min(c.byteLength, takeLen - offset);
      if (n <= 0) break;
      buf.set(c.subarray(0, n), offset);
      offset += n;
    }
    if (offset < takeLen && tail.byteLength > 0) {
      const n = Math.min(tail.byteLength, takeLen - offset);
      buf.set(tail.subarray(0, n), offset);
      offset += n;
    }
    this.pendingChunks = [];
    this.pendingBytes = 0;

    let view = buf;
    if (!truncated && view.byteLength > 0 && view[view.byteLength - 1] === 0x0d) {
      view = view.subarray(0, view.byteLength - 1);
    }
    let text = this.decoder.decode(view, { stream: truncated });
    this.decoder.decode(); // Drop any partial code point at the clipping boundary.
    if (Buffer.byteLength(text, "utf8") > cap) {
      // Lossy decoding of malformed UTF-8 can expand the retained bytes.
      const bytes = Buffer.from(text, "utf8");
      text = this.decoder.decode(bytes.subarray(0, cap), { stream: true });
      this.decoder.decode();
    }
    const storedBytes = Math.max(1, Buffer.byteLength(text, "utf8"));

    this.entries.push({ line: text, bytes: storedBytes });
    this.totalBytes += storedBytes;
    while (this.totalBytes > this.maxTotalBytes && this.entries.length > 0) {
      const evicted = this.entries.shift()!;
      this.totalBytes -= evicted.bytes;
    }
    this.onLine?.(text);
  }
}
