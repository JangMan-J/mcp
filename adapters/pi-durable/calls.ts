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
  | { status: "interrupted"; diagnostic?: "host-restart-uncertain-write" };

export interface ExecuteOptions<Req> {
  acceptDuplicate?: boolean;
  restartLimit?: number;
  /** Tool name used for policy lookup. */
  tool?: string;
  /** Tools known read-only: restart is safe without acceptDuplicate. */
  readOnlyTools?: readonly string[];
  /** Operator per-tool override; wins over readOnlyTools and acceptDuplicate. */
  toolOverrides?: Readonly<Record<string, "replay" | "interrupt">>;
  /** Builds the request for a restart attempt (e.g. fresh actual request ID). */
  restartRequest?: (request: Req, attempt: number) => Req;
}

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
    opts: ExecuteOptions<Req> = {},
  ): Promise<CallOutcome<Res>> {
    return this.deps.mutex.withLock(key, async () => {
      const existing = await this.deps.store.get(key);
      if (existing?.status === "completed")
        return { status: "completed", result: existing.result as Res };
      let attempts = 1;
      if (existing) {
        attempts = (existing.meta?.attempts ?? 1) + 1;
        const override = opts.tool ? opts.toolOverrides?.[opts.tool] : undefined;
        const replay =
          override !== undefined
            ? override === "replay"
            : !!opts.acceptDuplicate ||
              (!!opts.tool && !!opts.readOnlyTools?.includes(opts.tool));
        if (!replay || attempts - 1 > (opts.restartLimit ?? 1))
          return opts.tool && !opts.readOnlyTools?.includes(opts.tool)
            ? { status: "interrupted", diagnostic: "host-restart-uncertain-write" }
            : { status: "interrupted" };
        request = opts.restartRequest?.(request, attempts) ?? request;
      }
      await this.deps.store.commitIntent(key, request, { attempts });
      const result = await send(request);
      await this.deps.store.commitOutcome(key, result);
      return { status: "completed", result };
    });
  }
}
