import {
  McpClient,
  type Clock,
  type ClientRequest,
  type Outcome,
  type RequestOptions,
  type Transport,
} from "@mcp-client/core";
import { InprocTransport, type InprocMutants } from "@mcp-client/fixtures";

export interface HarnessClock extends Clock {
  advance(ms: number): void;
}

export function createFakeClock(startMs = 1_700_000_000_000): HarnessClock {
  let nowMs = startMs;
  let nextTimer = 1;
  const timers = new Map<number, { due: number; fn: () => void }>();

  return {
    now: () => nowMs,
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { due: nowMs + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      nowMs += ms;
      for (const [id, t] of Array.from(timers.entries())) {
        if (t.due <= nowMs) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

export interface HarnessInstance {
  readonly client: McpClient;
  readonly transport: InprocTransport;
  readonly clock: HarnessClock;
  call(method: string, params: Record<string, unknown>, opts?: RequestOptions): ClientRequest<unknown>;
  outcomeJson(outcome: Outcome<unknown>): Record<string, unknown>;
}

export interface HarnessSetup {
  readonly timeoutMs?: number;
  readonly supportedVersions?: readonly string[];
  readonly mutant?: string;
}

export interface HarnessAdapter {
  create(setup: HarnessSetup): HarnessInstance;
}

export function createCoreAdapter(): HarnessAdapter {
  return {
    create(setup) {
      const clock = createFakeClock();
      const mutantFlags: InprocMutants = {
        ...(setup.mutant === "allow-duplicate-id" ? { allowDuplicateId: true } : {}),
        ...(setup.mutant === "reject-missing-resulttype" ? { rejectMissingResultType: true } : {}),
        ...(setup.mutant === "ignore-version-retry" ? { ignoreVersionRetry: true } : {}),
        ...(setup.mutant === "send-cancel-when-aborted-before-send"
          ? { sendCancelWhenAbortedBeforeSend: true }
          : {}),
        ...(setup.mutant === "cross-talk-responses" ? { crossTalkResponses: true } : {}),
      };
      const transport = new InprocTransport(mutantFlags);

      const wrappedTransport: Transport = {
        binding: transport.binding,
        start(msg, ctx) {
          const ex = transport.start(msg, ctx);
          if (!mutantFlags.rejectMissingResultType) {
            return ex;
          }
          return {
            notifications: ex.notifications,
            done: ex.done.then((end) => {
              if (end.kind === "response" && "result" in end.message && end.message.result["resultType"] === undefined) {
                return {
                  kind: "response" as const,
                  message: {
                    ...end.message,
                    result: { ...end.message.result, resultType: "mutant_unknown" },
                  },
                };
              }
              return end;
            }),
          };
        },
        notify: (m, c) => transport.notify(m, c),
        close: (o) => transport.close(o),
        diagnostics: transport.diagnostics,
      };

      const client = new McpClient({
        transport: wrappedTransport,
        server: { key: "conformance-inproc" },
        ports: { clock },
        ...(mutantFlags.allowDuplicateId ? { idGenerator: () => 1 } : {}),
        ...(mutantFlags.ignoreVersionRetry
          ? { supportedVersions: [] }
          : setup.supportedVersions
            ? { supportedVersions: setup.supportedVersions }
            : {}),
        ...(setup.timeoutMs !== undefined ? { defaults: { timeoutMs: setup.timeoutMs } } : {}),
      });

      return {
        client,
        transport,
        clock,
        call(method, params, opts) {
          if (mutantFlags.sendCancelWhenAbortedBeforeSend && opts?.signal?.aborted) {
            wrappedTransport.start(
              { jsonrpc: "2.0", id: 999, method: "notifications/cancelled", params: { requestId: 999 } },
              { signal: new AbortController().signal, idempotent: true, timeoutMs: 1000 },
            );
          }
          return client.request(method, params, opts);
        },
        outcomeJson(outcome) {
          return outcome as unknown as Record<string, unknown>;
        },
      };
    },
  };
}
