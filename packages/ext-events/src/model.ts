export type Obj = Record<string, unknown>;
export const object = (x: unknown): x is Obj =>
  typeof x === "object" && x !== null && !Array.isArray(x);
export function cursor(x: unknown): string | null {
  if (x == null || typeof x === "string") return x ?? null;
  throw new Error("Invalid Events cursor");
}
export interface Occurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: unknown;
  cursor: string | null;
}
