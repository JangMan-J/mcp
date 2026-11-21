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
  | { status: "interrupted"; classification?: UncertainWrite };

/** Intent identity read from a request descriptor (MCP metadata). */
export interface RequestIntent {
  method: string;
  server?: string;
  name?: string;
  digest?: string;
  requestId?: string | number;
}
export interface UncertainWrite {
  kind: "uncertain-write";
  evidence: "host-restart";
  intent?: RequestIntent;
}
/** Explicit read-only list methods that may replay on restart (not every list method). */
export const DEFAULT_REPLAY_METHODS: readonly string[] = [
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
];
const IDENTITY = ["method", "server", "name", "digest"] as const;

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
  /** Reads MCP intent from a request; absent/undefined means generic request. */
  describe?: (request: Req) => RequestIntent | undefined;
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
      let attempts = 1;
      const describe = (r: Req | undefined) =>
        r === undefined ? undefined : opts.describe?.(r);
      const conflicts = (a?: RequestIntent, b?: RequestIntent) =>
        !!a && !!b && IDENTITY.some((f) => a[f] !== b[f]);
      if (existing) {
        const prior = describe(existing.request);
        const current = describe(request);
        if (conflicts(prior, current)) throw new Error("conflicting intent identity");
        if (existing.status === "completed")
          return { status: "completed", result: existing.result as Res };
        const intent = current ?? prior;
        const tool = opts.tool ?? (intent?.method === "tools/call" ? intent.name : undefined);
        const readOnly =
          (!!tool && !!opts.readOnlyTools?.includes(tool)) ||
          (!!intent?.method && intent.method !== "tools/call" &&
            DEFAULT_REPLAY_METHODS.includes(intent.method));
        const known = !!tool || (!!intent?.method && !readOnly);
        attempts = (existing.meta?.attempts ?? 1) + 1;
        const override = tool ? opts.toolOverrides?.[tool] : undefined;
        const replay =
          override !== undefined
            ? override === "replay"
            : !!opts.acceptDuplicate || readOnly;
        if (!replay || attempts - 1 > (opts.restartLimit ?? 1))
          return known && !readOnly
            ? {
                status: "interrupted",
                classification: {
                  kind: "uncertain-write",
                  evidence: "host-restart",
                  ...(intent ? { intent } : {}),
                },
              }
            : { status: "interrupted" };
        request = opts.restartRequest?.(request, attempts) ?? request;
        const next = describe(request);
        if (conflicts(intent, next)) throw new Error("conflicting intent identity");
        if (
          prior?.requestId !== undefined &&
          next?.requestId !== undefined &&
          prior.requestId === next.requestId
        )
          throw new Error("stale restart request id");
      }
      await this.deps.store.commitIntent(key, request, { attempts });
      const result = await send(request);
      await this.deps.store.commitOutcome(key, result);
      return { status: "completed", result };
    });
  }
}
