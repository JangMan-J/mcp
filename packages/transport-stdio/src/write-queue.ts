import type { Writable } from "node:stream";

export type WriteState = "queued" | "writing" | "sent";

export interface QueuedWrite {
  readonly payload: string;
  readonly key?: string;
  readonly priority: boolean;
  state: WriteState;
  readonly onStateChange?: (state: WriteState) => void;
  readonly onComplete: (err?: Error) => void;
}

/**
 * Serialized single-writer outbound queue with backpressure (`drain`) and priority lane
 * for `notifications/cancelled` (STDIO-WRITE-1, STDIO-CANCEL-1).
 */
export class WriteQueue {
  private readonly priorityQueue: QueuedWrite[] = [];
  private readonly normalQueue: QueuedWrite[] = [];
  private stdin: Writable | undefined;
  private pumping = false;
  private active: QueuedWrite | undefined;

  attach(stdin: Writable): void {
    this.stdin = stdin;
    this.pump();
  }

  detach(reason: Error): void {
    this.stdin = undefined;
    this.pumping = false;
    this.active = undefined;
    // Fail all remaining queued writes that were never written.
    const remaining = [...this.priorityQueue, ...this.normalQueue];
    this.priorityQueue.length = 0;
    this.normalQueue.length = 0;
    for (const item of remaining) {
      item.onComplete(reason);
    }
  }

  enqueue(opts: {
    readonly payload: string;
    readonly key?: string;
    readonly priority?: boolean;
    readonly onStateChange?: (state: WriteState) => void;
  }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const item: QueuedWrite = {
        payload: opts.payload,
        ...(opts.key !== undefined ? { key: opts.key } : {}),
        priority: opts.priority ?? false,
        state: "queued",
        ...(opts.onStateChange ? { onStateChange: opts.onStateChange } : {}),
        onComplete: (err) => {
          if (err) reject(err);
          else resolve();
        },
      };
      if (item.priority) {
        this.priorityQueue.push(item);
      } else {
        this.normalQueue.push(item);
      }
      this.pump();
    });
  }

  /**
   * Removes a queued normal write before it has started writing (STDIO-CANCEL-1).
   * Returns true if the item was still queued and removed without writing any bytes.
   */
  removeQueued(key: string): boolean {
    const idx = this.normalQueue.findIndex((item) => item.key === key && item.state === "queued");
    if (idx < 0) return false;
    const [removed] = this.normalQueue.splice(idx, 1);
    removed?.onComplete(new Error("removed-from-queue"));
    return true;
  }

  get queuedCount(): number {
    return this.priorityQueue.length + this.normalQueue.length;
  }

  get isWriting(): boolean {
    return this.active !== undefined;
  }

  private nextItem(): QueuedWrite | undefined {
    if (this.priorityQueue.length > 0) {
      return this.priorityQueue.shift();
    }
    return this.normalQueue.shift();
  }

  private pump(): void {
    if (this.pumping || !this.stdin) return;
    const item = this.nextItem();
    if (!item) return;

    const stdin = this.stdin;
    if (stdin.destroyed || stdin.writableEnded) {
      item.onComplete(new Error("stdin is closed"));
      this.pump();
      return;
    }

    this.pumping = true;
    this.active = item;
    item.state = "writing";
    item.onStateChange?.("writing");

    let settled = false;
    let writeDone = false;
    let needsDrain = false;
    let drained = false;

    const cleanup = () => {
      stdin.off("drain", onDrain);
      stdin.off("error", onStreamErr);
      stdin.off("close", onStreamClose);
    };

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (this.active === item) {
        this.active = undefined;
      }
      this.pumping = false;
      if (!err) {
        item.state = "sent";
        item.onStateChange?.("sent");
      }
      item.onComplete(err);
      this.pump();
    };

    const maybeFinishOk = () => {
      if (writeDone && (!needsDrain || drained)) {
        finish();
      }
    };

    const onDrain = () => {
      drained = true;
      maybeFinishOk();
    };

    const onStreamErr = (err: Error) => {
      finish(err);
    };

    const onStreamClose = () => {
      finish(new Error("stdin closed during write"));
    };

    stdin.once("error", onStreamErr);
    stdin.once("close", onStreamClose);

    try {
      const ok = stdin.write(item.payload, "utf8", (err) => {
        if (err) {
          finish(err);
          return;
        }
        writeDone = true;
        maybeFinishOk();
      });
      if (!ok) {
        needsDrain = true;
        stdin.once("drain", onDrain);
      }
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
