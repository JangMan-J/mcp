import type { Clock, ProgressEvent } from "./ports.js";

/**
 * Progress registry (S1.1, IMPLEMENTATION_PLAN.md §5.6; PROG-1..PROG-5).
 *
 * Tokens are registered when a request that carries a progressToken is started and released
 * when the request settles. Notifications are accepted only for active tokens (PROG-3), only
 * when the progress value strictly increases per token (PROG-2), and never after the request
 * settled (PROG-4). progress/total may be any finite number (PROG-5). Every drop is counted.
 */

export type ProgressToken = string | number;

export type ProgressDropReason = "inactive" | "after-complete" | "non-monotonic" | "invalid" | "foreign";

export type ProgressDecision =
  | { readonly accept: true; readonly event: ProgressEvent }
  | { readonly accept: false; readonly reason: ProgressDropReason };

export interface ProgressStats {
  readonly active: number;
  readonly delivered: number;
  readonly inactive: number;
  readonly afterComplete: number;
  readonly nonMonotonic: number;
  readonly invalid: number;
  readonly foreign: number;
  readonly collisions: number;
}

export interface ProgressRegistryOptions {
  /** How many released tokens are remembered to classify late notifications as after-complete. */
  readonly recentLimit?: number;
}

export function isProgressToken(v: unknown): v is ProgressToken {
  if (typeof v === "string") return v.length > 0;
  return typeof v === "number" && Number.isSafeInteger(v);
}

export function progressTokenKey(token: ProgressToken): string {
  return `${typeof token}:${String(token)}`;
}

/** Parses notifications/progress params; returns undefined when the shape is invalid. */
export function parseProgressParams(params: unknown): ProgressEvent | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const p = params as Record<string, unknown>;
  const token = p["progressToken"];
  const progress = p["progress"];
  const total = p["total"];
  const message = p["message"];
  if (!isProgressToken(token)) return undefined;
  if (typeof progress !== "number" || !Number.isFinite(progress)) return undefined;
  if (total !== undefined && (typeof total !== "number" || !Number.isFinite(total))) return undefined;
  if (message !== undefined && typeof message !== "string") return undefined;
  return {
    progressToken: token,
    progress,
    ...(total !== undefined ? { total } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

interface ActiveToken {
  last: number | undefined;
}

export class ProgressRegistry {
  private readonly active = new Map<string, ActiveToken>();
  private readonly recent: string[] = [];
  private readonly recentSet = new Set<string>();
  private readonly recentLimit: number;
  private readonly counters = {
    delivered: 0,
    inactive: 0,
    afterComplete: 0,
    nonMonotonic: 0,
    invalid: 0,
    foreign: 0,
    collisions: 0,
  };

  constructor(opts: ProgressRegistryOptions = {}) {
    this.recentLimit = Math.max(0, opts.recentLimit ?? 256);
  }

  /** Registers a token for an in-flight request. Returns false when the token is already active (PROG-1). */
  register(token: ProgressToken): boolean {
    const key = progressTokenKey(token);
    if (this.active.has(key)) {
      this.counters.collisions += 1;
      return false;
    }
    if (this.recentSet.has(key)) {
      this.recentSet.delete(key);
      const i = this.recent.indexOf(key);
      if (i >= 0) this.recent.splice(i, 1);
    }
    this.active.set(key, { last: undefined });
    return true;
  }

  isActive(token: ProgressToken): boolean {
    return this.active.has(progressTokenKey(token));
  }

  get activeCount(): number {
    return this.active.size;
  }

  /**
   * Decides whether a notifications/progress params object is delivered.
   * When `expected` is given, a notification naming another token is dropped as foreign.
   */
  accept(params: unknown, expected?: ProgressToken): ProgressDecision {
    const ev = parseProgressParams(params);
    if (!ev) {
      this.counters.invalid += 1;
      return { accept: false, reason: "invalid" };
    }
    const key = progressTokenKey(ev.progressToken);
    const entry = this.active.get(key);
    if (!entry) {
      if (this.recentSet.has(key)) {
        this.counters.afterComplete += 1;
        return { accept: false, reason: "after-complete" };
      }
      this.counters.inactive += 1;
      return { accept: false, reason: "inactive" };
    }
    if (expected !== undefined && progressTokenKey(expected) !== key) {
      this.counters.foreign += 1;
      return { accept: false, reason: "foreign" };
    }
    if (entry.last !== undefined && !(ev.progress > entry.last)) {
      this.counters.nonMonotonic += 1;
      return { accept: false, reason: "non-monotonic" };
    }
    entry.last = ev.progress;
    this.counters.delivered += 1;
    return { accept: true, event: ev };
  }

  /** Releases a token when its request settles; later notifications count as after-complete (PROG-4). */
  release(token: ProgressToken): void {
    const key = progressTokenKey(token);
    if (!this.active.delete(key)) return;
    if (this.recentLimit === 0) return;
    this.recent.push(key);
    this.recentSet.add(key);
    while (this.recent.length > this.recentLimit) {
      const old = this.recent.shift();
      if (old !== undefined) this.recentSet.delete(old);
    }
  }

  stats(): ProgressStats {
    return { active: this.active.size, ...this.counters };
  }
}

/**
 * Single-consumer async push queue. `close()` ends iteration after buffered items drain;
 * pushes after close are ignored and reported by the return value.
 */
export class NotificationQueue<T> implements AsyncIterable<T> {
  private readonly buf: T[] = [];
  private waiter: ((r: IteratorResult<T>) => void) | undefined;
  private closedFlag = false;

  get closed(): boolean {
    return this.closedFlag;
  }

  push(item: T): boolean {
    if (this.closedFlag) return false;
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      w({ value: item, done: false });
    } else {
      this.buf.push(item);
    }
    return true;
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buf.length > 0) {
          return Promise.resolve({ value: this.buf.shift() as T, done: false });
        }
        if (this.closedFlag) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.close();
        this.buf.length = 0;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/**
 * LIM-PROG-1: rate-limits progress delivery to one callback per `intervalMs` (default 20 ms,
 * i.e. 50/s). Faster events are coalesced to the latest; `flush()` delivers the pending latest
 * value so the final progress is always observed before settlement. Uses the injected Clock.
 */
export class ProgressThrottle<T> {
  private lastEmit: number | undefined;
  private pending: { value: T } | undefined;
  private cancelTimer: (() => void) | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly emit: (v: T) => void,
    private readonly intervalMs = 20,
  ) {}

  push(v: T): void {
    const now = this.clock.now();
    if (this.cancelTimer === undefined && (this.lastEmit === undefined || now - this.lastEmit >= this.intervalMs)) {
      this.lastEmit = now;
      this.emit(v);
      return;
    }
    this.pending = { value: v };
    if (this.cancelTimer === undefined) {
      const wait = Math.max(0, (this.lastEmit ?? now) + this.intervalMs - now);
      this.cancelTimer = this.clock.setTimeout(() => {
        this.cancelTimer = undefined;
        this.deliverPending();
      }, wait);
    }
  }

  flush(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.deliverPending();
  }

  private deliverPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = undefined;
    this.lastEmit = this.clock.now();
    this.emit(p.value);
  }
}
