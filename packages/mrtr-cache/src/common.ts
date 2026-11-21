import type { Outcome, RequestOptions } from "@mcp-client/core";
export { withAbort } from "@mcp-client/core";
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
