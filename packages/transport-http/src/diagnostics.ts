import type { JsonRpcNotification, TransportDiagnostic } from "@mcp-client/core";

export const DEFAULT_MAX_DIAGNOSTICS = 1000;

export class DiagnosticChannel implements AsyncIterable<TransportDiagnostic> {
  private readonly ring: TransportDiagnostic[] = [];
  private readonly live: TransportDiagnostic[] = [];
  private readonly waiters: Array<(r: IteratorResult<TransportDiagnostic>) => void> = [];
  private closed = false;
  constructor(private readonly max = DEFAULT_MAX_DIAGNOSTICS) {}
  emit(d: TransportDiagnostic): void {
    this.ring.push(d);
    if (this.ring.length > this.max) this.ring.shift();
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: d, done: false });
    else {
      this.live.push(d);
      if (this.live.length > this.max) this.live.shift();
    }
  }
  snapshot(): readonly TransportDiagnostic[] {
    return [...this.ring];
  }
  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<TransportDiagnostic> {
    return {
      next: () => {
        if (this.live.length) return Promise.resolve({ value: this.live.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export class NotificationQueue implements AsyncIterable<JsonRpcNotification> {
  private readonly items: JsonRpcNotification[] = [];
  private readonly waiters: Array<(r: IteratorResult<JsonRpcNotification>) => void> = [];
  private ended = false;
  droppedUnrelated = 0;
  push(n: JsonRpcNotification): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: n, done: false });
    else this.items.push(n);
  }
  close(): void {
    this.ended = true;
    while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<JsonRpcNotification> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}
