/**
 * Incremental WHATWG Server-Sent Events parser (§7.5).
 * Chunk-boundary invariant: for any byte stream and any split into chunks,
 * push(chunk) sequences yield exactly the same dispatched events.
 */

export interface SseEvent {
  readonly event: string; // "" when absent (treated as "message" by consumers)
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

export const DEFAULT_MAX_SSE_EVENT_BYTES = 4 * 1024 * 1024;

export class SseEventTooLargeError extends Error {
  constructor(readonly observed: number, readonly max: number) {
    super(`SSE event size ${observed} exceeds max ${max}`);
    this.name = "SseEventTooLargeError";
  }
}

export class SseParser {
  private readonly decoder: TextDecoder;
  private readonly maxEventBytes: number;
  private lineBuffer = "";
  private dataBuffer = "";
  private eventType = "";
  private lastId: string | undefined;
  private lastRetry: number | undefined;
  private started = false;

  constructor(maxEventBytes = DEFAULT_MAX_SSE_EVENT_BYTES) {
    if (!Number.isInteger(maxEventBytes) || maxEventBytes <= 0) throw new RangeError("maxEventBytes must be positive");
    this.maxEventBytes = maxEventBytes;
    this.decoder = new TextDecoder("utf-8", { ignoreBOM: false });
  }

  push(chunk: Uint8Array | string): SseEvent[] {
    let text: string;
    if (typeof chunk === "string") {
      text = chunk;
    } else {
      text = this.decoder.decode(chunk, { stream: true });
    }
    if (!this.started) {
      this.started = true;
      if (text.startsWith("\uFEFF")) text = text.slice(1);
    }
    this.lineBuffer += text;
    const events: SseEvent[] = [];
    for (;;) {
      const line = this.takeLine();
      if (line === undefined) break;
      const ev = this.processLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  /** Flush the decoder. A pending unterminated line is processed; no event is dispatched without a blank line. */
  end(): SseEvent[] {
    const tail = this.decoder.decode();
    if (tail) {
      this.lineBuffer += tail;
    }
    const events: SseEvent[] = [];
    if (this.lineBuffer.length > 0) {
      let line = this.lineBuffer;
      this.lineBuffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      const ev = this.processLine(line);
      if (ev) events.push(ev);
    }
    return events;
  }

  private takeLine(): string | undefined {
    const buf = this.lineBuffer;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i]!;
      if (ch === "\n") {
        this.lineBuffer = buf.slice(i + 1);
        return buf.slice(0, i);
      }
      if (ch === "\r") {
        if (i === buf.length - 1) return undefined; // could be \r\n split across chunks: wait
        this.lineBuffer = buf.slice(buf[i + 1] === "\n" ? i + 2 : i + 1);
        return buf.slice(0, i);
      }
    }
    return undefined;
  }

  private processLine(line: string): SseEvent | undefined {
    if (line === "") {
      // Dispatch
      const data = this.dataBuffer;
      const evType = this.eventType;
      const id = this.lastId;
      const retry = this.lastRetry;
      this.dataBuffer = "";
      this.eventType = "";
      this.lastId = undefined;
      this.lastRetry = undefined;
      if (data === "") return undefined;
      const trimmed = data.endsWith("\n") ? data.slice(0, -1) : data;
      return {
        event: evType,
        data: trimmed,
        ...(id !== undefined ? { id } : {}),
        ...(retry !== undefined ? { retry } : {}),
      };
    }
    if (line.startsWith(":")) return undefined; // comment / keep-alive (HTTP-SSE-1)
    let field: string;
    let value: string;
    const colon = line.indexOf(":");
    if (colon === -1) {
      field = line;
      value = "";
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    switch (field) {
      case "data": {
        this.dataBuffer += `${value}\n`;
        const bytes = new TextEncoder().encode(this.dataBuffer).byteLength;
        if (bytes > this.maxEventBytes) throw new SseEventTooLargeError(bytes, this.maxEventBytes);
        break;
      }
      case "event":
        this.eventType = value;
        break;
      case "id":
        if (!value.includes("\0")) this.lastId = value; // parsed, discarded by transport (HTTP-SSE-3)
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.lastRetry = Number(value);
        break;
      default:
        break; // unknown fields ignored per WHATWG grammar
    }
    return undefined;
  }
}
