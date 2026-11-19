import type { TransportDiagnostic } from "@mcp-client/core";

export const DEFAULT_MAX_DIAGNOSTICS = 1000; // LIM-DIAG-1

interface Waiter {
  readonly resolve: (res: IteratorResult<TransportDiagnostic>) => void;
}

/**
 * Bounded diagnostic ring buffer with AsyncIterable streaming (LIM-DIAG-1).
 */
export class DiagnosticChannel implements AsyncIterable<TransportDiagnostic> {
  private readonly maxEvents: number;
  private readonly ring: TransportDiagnostic[] = [];
  private readonly liveQueue: TransportDiagnostic[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  constructor(maxEvents = DEFAULT_MAX_DIAGNOSTICS) {
    this.maxEvents = maxEvents;
  }

  emit(diag: TransportDiagnostic): void {
    this.ring.push(diag);
    if (this.ring.length > this.maxEvents) {
      this.ring.shift();
    }
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value: diag, done: false });
    } else {
      this.liveQueue.push(diag);
      if (this.liveQueue.length > this.maxEvents) {
        this.liveQueue.shift();
      }
    }
  }

  snapshot(): readonly TransportDiagnostic[] {
    return [...this.ring];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TransportDiagnostic> {
    return {
      next: (): Promise<IteratorResult<TransportDiagnostic>> => {
        if (this.liveQueue.length > 0) {
          const value = this.liveQueue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<TransportDiagnostic>>((resolve) => {
          this.waiters.push({ resolve });
        });
      },
    };
  }
}
