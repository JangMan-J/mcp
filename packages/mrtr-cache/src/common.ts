import type { Outcome, RequestOptions } from "@mcp-client/core";
export type Obj = Record<string, unknown>;
export const object = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export type RequestFn = (
  method: string,
  params: Obj,
  options: RequestOptions,
) => PromiseLike<Outcome<unknown>>;
export type Diagnostic = (reason: string, detail?: Obj) => void;
export class Violation extends Error {
  constructor(
    reason: string,
    readonly context: Obj = {},
  ) {
    super(reason);
  }
}
export function withAbort<T>(
  work: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
