// PICD-4: typed durable handles. Host owns persistence (snapshot data) and transport (send); this module owns handle shape and dispatch.
export type TaskHandle = { kind: "task"; taskId: string; expiresAt?: number };
export type MrtrHandle = {
  kind: "mrtr"; id: string; method: string; requestState: unknown;
  inputRequests: Readonly<Record<string, unknown>>; // local prompt data, never sent
  inputResponses?: Readonly<Record<string, unknown>>; // wire retry payload
};
export type SubscriptionHandle = {
  kind: "subscription"; subscriptions: readonly unknown[];
};
export type DurableHandle = TaskHandle | MrtrHandle | SubscriptionHandle;
export type Request = { id: string; method: string; params?: unknown };
export interface DurableHost {
  storage: { read(): unknown; write(data: unknown): void | Promise<void> };
  send(request: Request): Promise<unknown>;
  newId?: () => string;
  now?: () => number;
}
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
export function parseHandle(data: unknown): DurableHandle | null {
  if (!isObj(data)) return null;
  if (data.kind === "task" && typeof data.taskId === "string" &&
    (data.expiresAt === undefined || typeof data.expiresAt === "number"))
    return { kind: "task", taskId: data.taskId, ...(data.expiresAt !== undefined ? { expiresAt: data.expiresAt } : {}) };
  if (data.kind === "mrtr" && typeof data.id === "string" && typeof data.method === "string" &&
    "requestState" in data && isObj(data.inputRequests))
    return { kind: "mrtr", id: data.id, method: data.method, requestState: data.requestState, inputRequests: { ...data.inputRequests },
      ...(isObj(data.inputResponses) ? { inputResponses: { ...data.inputResponses } } : {}) };
  if (data.kind === "subscription" && Array.isArray(data.subscriptions))
    return { kind: "subscription", subscriptions: [...data.subscriptions] };
  return null;
}
export class DurableHandles {
  constructor(private host: DurableHost) {}
  private newId() { return this.host.newId?.() ?? crypto.randomUUID(); }
  private now() { return this.host.now?.() ?? Date.now(); }
  async save(handle: DurableHandle): Promise<void> {
    const parsed = parseHandle(structuredClone(handle));
    if (!parsed) throw new TypeError("invalid durable handle");
    await this.host.storage.write(parsed);
  }
  async load(): Promise<DurableHandle | null> {
    return parseHandle(await this.host.storage.read());
  }
  async dispatch(handle: DurableHandle): Promise<unknown> {
    switch (handle.kind) {
      case "task": {
        if (handle.expiresAt !== undefined && this.now() >= handle.expiresAt)
          throw new Error(`task handle expired: ${handle.taskId}`);
        return this.host.send({ id: this.newId(), method: "tasks/get", params: { taskId: handle.taskId } });
      }
      case "mrtr":
        // Retry is a new request: fresh distinct id, never the stored one.
        return this.host.send({
          id: this.newId(), method: handle.method,
          params: {
            requestState: handle.requestState,
            ...(handle.inputResponses ? { inputResponses: { ...handle.inputResponses } } : {}),
          },
        });
      case "subscription":
        // Fresh listen descriptor each time; deliberately no `resume` field.
        return this.host.send({
          id: this.newId(), method: "subscriptions/listen",
          params: { subscriptions: [...handle.subscriptions] },
        });
    }
  }
  async restore(): Promise<unknown> {
    const handle = await this.load();
    return handle ? this.dispatch(handle) : null;
  }
}
