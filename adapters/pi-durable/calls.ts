export interface CallRecord<Req = unknown, Res = unknown> {
  status: "intent" | "completed";
  request?: Req;
  result?: Res;
  meta?: { attempts: number };
}
export interface DurableCallStore<Req = unknown, Res = unknown> {
  get(key: string): Promise<CallRecord<Req, Res> | undefined>;
  commitIntent(key: string, request: Req, meta?: { attempts: number }): Promise<void>;
  commitOutcome(key: string, result: Res): Promise<void>;
}
export interface PerKeyMutex {
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
export type Send<Req, Res> = (request: Req) => Promise<Res>;
export type CallOutcome<Res> =
  | { status: "completed"; result: Res }
  | { status: "interrupted" };

export class DurableCalls<Req = unknown, Res = unknown> {
  constructor(
    private readonly deps: {
      store: DurableCallStore<Req, Res>;
      mutex: PerKeyMutex;
    },
  ) {}
  async execute(
    key: string,
    request: Req,
    send: Send<Req, Res>,
    opts: { acceptDuplicate?: boolean; restartLimit?: number } = {},
  ): Promise<CallOutcome<Res>> {
    return this.deps.mutex.withLock(key, async () => {
      const existing = await this.deps.store.get(key);
      if (existing?.status === "completed")
        return { status: "completed", result: existing.result as Res };
      let attempts = 1;
      if (existing) {
        attempts = (existing.meta?.attempts ?? 1) + 1;
        if (!opts.acceptDuplicate || attempts - 1 > (opts.restartLimit ?? 1))
          return { status: "interrupted" };
      }
      await this.deps.store.commitIntent(key, request, { attempts });
      const result = await send(request);
      await this.deps.store.commitOutcome(key, result);
      return { status: "completed", result };
    });
  }
}
