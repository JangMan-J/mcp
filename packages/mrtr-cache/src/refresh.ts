import { systemClock, type Clock } from "@mcp/core";
/** Explicit host opt-in; TTL alone never schedules work. The task returns false on a retryable failure. */
export function autoRefresh(
  task: (signal: AbortSignal) => Promise<boolean>,
  options: {
    intervalMs: number;
    maxBackoffMs?: number;
    clock?: Clock;
    random?: () => number;
  },
): () => void {
  const { intervalMs } = options,
    max = options.maxBackoffMs ?? Math.max(60000, intervalMs);
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs <= 0 ||
    !Number.isFinite(max) ||
    max < intervalMs
  )
    throw RangeError("invalid refresh interval");
  const clock = options.clock ?? systemClock,
    random = options.random ?? Math.random,
    controller = new AbortController();
  let delay = intervalMs,
    cancel = () => {};
  function schedule() {
    if (controller.signal.aborted) return;
    cancel = clock.setTimeout(
      () => {
        void Promise.resolve()
          .then(() => task(controller.signal))
          .catch(() => false)
          .then((ok) => {
            delay = ok ? intervalMs : Math.min(max, delay * 2);
            schedule();
          });
      },
      Math.max(1, Math.floor(delay * (0.5 + random() * 0.5))),
    );
  }
  schedule();
  return () => {
    controller.abort();
    cancel();
  };
}
