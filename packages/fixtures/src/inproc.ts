import type {
  Exchange,
  ExchangeEnd,
  JsonRpcNotification,
  JsonRpcRequest,
  RequestId,
  Transport,
  TransportCall,
  TransportDiagnostic,
} from "@mcp-client/core";

export interface RecordedOutbound {
  readonly request: JsonRpcRequest;
  readonly rawText: string;
}

export interface InprocMutants {
  readonly allowDuplicateId?: boolean;
  readonly rejectMissingResultType?: boolean;
  readonly ignoreVersionRetry?: boolean;
  readonly sendCancelWhenAbortedBeforeSend?: boolean;
  readonly crossTalkResponses?: boolean;
}

interface PendingExchange {
  readonly req: JsonRpcRequest;
  readonly resolve: (end: ExchangeEnd) => void;
}

export class InprocTransport implements Transport {
  readonly binding = "stdio" as const;
  readonly sent: RecordedOutbound[] = [];
  private readonly pending = new Map<string, PendingExchange>();
  private closed = false;
  private readonly mutants: InprocMutants;

  constructor(mutants: InprocMutants = {}) {
    this.mutants = mutants;
  }

  private keyOf(id: RequestId): string {
    return `${typeof id}:${String(id)}`;
  }

  hasPending(id: RequestId): boolean {
    return this.pending.has(this.keyOf(id));
  }

  latestPendingId(): RequestId | undefined {
    let last: RequestId | undefined;
    for (const entry of this.pending.values()) {
      last = entry.req.id;
    }
    return last;
  }

  start(msg: JsonRpcRequest, _ctx?: TransportCall): Exchange {
    this.sent.push({ request: msg, rawText: JSON.stringify(msg) });
    const notifications: AsyncIterable<JsonRpcNotification> = {
      async *[Symbol.asyncIterator]() {},
    };
    if (this.closed) {
      return {
        notifications,
        done: Promise.resolve({
          kind: "failure",
          failure: { kind: "closed", message: "InprocTransport closed" },
          delivery: "not-sent",
        }),
      };
    }
    const done = new Promise<ExchangeEnd>((resolve) => {
      this.pending.set(this.keyOf(msg.id), { req: msg, resolve });
    });
    return { notifications, done };
  }

  async notify(_msg?: JsonRpcNotification, _ctx?: TransportCall): Promise<void> {}

  deliverResult(targetId: RequestId, result: Record<string, unknown>): void {
    const key = this.keyOf(targetId);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    if (this.mutants.crossTalkResponses && this.pending.size > 0) {
      const firstOther = this.pending.entries().next().value;
      if (firstOther) {
        const [otherKey, otherEntry] = firstOther;
        this.pending.delete(otherKey);
        otherEntry.resolve({
          kind: "response",
          message: { jsonrpc: "2.0", id: otherEntry.req.id, result },
        });
        entry.resolve({
          kind: "response",
          message: { jsonrpc: "2.0", id: entry.req.id, result: { crossTalked: true } },
        });
        return;
      }
    }
    entry.resolve({
      kind: "response",
      message: { jsonrpc: "2.0", id: targetId, result },
    });
  }

  deliverError(targetId: RequestId, code: number, message: string, data?: unknown): void {
    const key = this.keyOf(targetId);
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    entry.resolve({
      kind: "response",
      message: {
        jsonrpc: "2.0",
        id: targetId,
        error: { code, message, ...(data !== undefined ? { data } : {}) },
      },
    });
  }

  async close(_opts?: { readonly graceMs?: number }): Promise<void> {
    this.closed = true;
    for (const [k, entry] of this.pending.entries()) {
      this.pending.delete(k);
      entry.resolve({
        kind: "failure",
        failure: { kind: "closed", message: "transport closed" },
        delivery: "maybe-delivered",
      });
    }
  }

  readonly diagnostics: AsyncIterable<TransportDiagnostic> = {
    async *[Symbol.asyncIterator]() {},
  };
}
