import {
  EraCache,
  classifyDiscoverOutcome,
  McpClient,
  NotificationQueue,
  ProgressRegistry,
  type Clock,
  type ClientRequest,
  type EraState,
  type Extension,
  type JsonRpcNotification,
  type LifecycleContext,
  type McpClientLifecycleOptions,
  type Outcome,
  type ProgressToken,
  type RequestId,
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
  /** S1.1: push a server notification onto the exchange of request `id` (even after it settled). */
  notify?(id: RequestId, notification: JsonRpcNotification): void;
}

export interface HarnessSetup {
  readonly timeoutMs?: number;
  readonly supportedVersions?: readonly string[];
  readonly mutant?: string;
  /** S1.1: `false` disables clientInfo. */
  readonly clientInfo?: false;
  /** S1.1: extensions to register, each advertising the given capabilities. */
  readonly extensions?: readonly { readonly id: string; readonly capabilities: Record<string, Record<string, unknown>> }[];
}

/** S1.1 mutants: deliberately broken lifecycle variants that wire/ver/prog fixtures must catch. */
class LaxProgressRegistry extends ProgressRegistry {
  override accept(params: unknown): ReturnType<ProgressRegistry["accept"]> {
    const p = (params ?? {}) as Record<string, unknown>;
    return {
      accept: true,
      event: { progressToken: p["progressToken"] as ProgressToken, progress: Number(p["progress"]) },
    };
  }
}

class StickyProgressRegistry extends ProgressRegistry {
  override release(): void {}
}

class IntegerOnlyProgressRegistry extends ProgressRegistry {
  override accept(params: unknown, expected?: ProgressToken): ReturnType<ProgressRegistry["accept"]> {
    const p = (params ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(p["progress"])) return { accept: false, reason: "invalid" };
    return super.accept(params, expected);
  }
}

class ForgetfulEraCache extends EraCache {
  override set(): void {}
}

function lifecycleMutant(mutant: string | undefined): McpClientLifecycleOptions {
  switch (mutant) {
    case "lax-progress-registry":
      return { progressRegistry: new LaxProgressRegistry() };
    case "keep-token-after-complete":
      return { progressRegistry: new StickyProgressRegistry() };
    case "integer-only-progress":
      return { progressRegistry: new IntegerOnlyProgressRegistry() };
    case "pass-all-notifications":
      return { hooks: { filterNotification: () => "deliver" } };
    case "no-settle-on-abort":
      return { settleOnAbort: false };
    case "treat-all-methods-read-only":
      return { readOnlyMethods: ["tools/call", "tools/list", "prompts/list", "resources/read", "server/discover"] };
    case "treat-no-methods-read-only":
      return { readOnlyMethods: [] };
    case "drop-error-refinement":
      return {
        hooks: {
          mapOutcome<T>(o: Outcome<T>): Outcome<T> {
            if (o.kind !== "jsonrpc-error") return o;
            const { refined: _r, ...rest } = o;
            return rest;
          },
        },
      };
    case "no-unsupported-version-mapping":
      return { hooks: { mapOutcome: <T>(o: Outcome<T>): Outcome<T> => o } };
    case "classify-any-discover-reply-modern":
      return {
        hooks: {
          classifyDiscover: (_o: Outcome<unknown>, ctx: LifecycleContext): EraState => ({
            era: "modern",
            version: ctx.supportedVersions[0] ?? "",
            supported: ctx.supportedVersions,
          }),
        },
      };
    case "branch-on-server-info":
      return {
        hooks: {
          classifyDiscover: (o: Outcome<unknown>, ctx: LifecycleContext): EraState => {
            const info = o.kind === "ok" ? JSON.stringify(o.value) : "";
            if (info.includes("legacy")) {
              return {
                era: "legacy-or-unresponsive",
                diagnostic: {
                  binding: ctx.binding,
                  endpointOrCommand: ctx.endpointOrCommand,
                  requested: ctx.supportedVersions[0] ?? "",
                  observed: "other-error",
                  evidence: "serverInfo looked legacy",
                  advice: "",
                },
              };
            }
            return classifyDiscoverOutcome(o, ctx);
          },
        },
      };
    case "no-era-cache":
      return { eraCache: new ForgetfulEraCache() };
    default:
      return {};
  }
}

function catchAllExtension(resultType: string): Extension {
  return {
    id: "mutant/catch-all",
    capabilities: () => ({}),
    attach: (host) => host.registerResultType(resultType, (result) => ({
      kind: "ok",
      value: result,
      meta: { requestId: 0, method: "mutant", binding: "stdio", attempts: 1 },
    })),
  };
}

function stripMeta(msg: Parameters<Transport["start"]>[0], key: string, replacement?: unknown) {
  const params = msg.params ?? {};
  const meta = { ...((params["_meta"] as Record<string, unknown> | undefined) ?? {}) };
  if (replacement === undefined) delete meta[key];
  else meta[key] = replacement;
  return { ...msg, params: { ...params, _meta: meta } };
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
      const queues = new Map<string, NotificationQueue<JsonRpcNotification>>();
      const keyOf = (id: RequestId) => `${typeof id}:${String(id)}`;

      const wrappedTransport: Transport = {
        binding: transport.binding,
        start(rawMsg, ctx) {
          let msg = rawMsg;
          if (setup.mutant === "omit-protocol-version") {
            msg = stripMeta(msg, "io.modelcontextprotocol/protocolVersion");
          }
          const inner = transport.start(msg, ctx);
          // S1.1: a per-exchange queue lets fixtures inject server notifications for any request.
          const queue = new NotificationQueue<JsonRpcNotification>();
          queues.set(keyOf(msg.id), queue);
          const ex = { notifications: queue, done: inner.done };
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
        close: (o) => {
          for (const q of queues.values()) q.close();
          return transport.close(o);
        },
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
        ...(setup.supportedVersions && setup.mutant === "claim-unimplemented-version"
          ? { supportedVersions: [...setup.supportedVersions, "2025-11-25"] }
          : {}),
        ...((setup.clientInfo === false && setup.mutant !== "client-info-default-on") || setup.mutant === "client-info-off"
          ? { clientInfo: false as const }
          : {}),
        lifecycle: lifecycleMutant(setup.mutant),
      });
      if (setup.extensions && setup.mutant !== "ignore-extension-registry") {
        for (const ext of setup.extensions) {
          client.use({ id: ext.id, capabilities: () => ext.capabilities, attach: () => ({ dispose() {} }) });
        }
      }
      if (setup.mutant === "register-catchall-resulttype") {
        client.use(catchAllExtension("mystery_type"));
      }

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
          let callOpts = opts;
          if (setup.mutant === "ignore-per-request-timeout" && callOpts) {
            const { timeoutMs: _t, ...rest } = callOpts;
            callOpts = rest;
          }
          if (setup.mutant === "always-mint-progress-token" && !callOpts?.onProgress) {
            callOpts = { ...callOpts, onProgress: () => {} };
          }
          return client.request(method, params, callOpts);
        },
        notify(id, notification) {
          queues.get(keyOf(id))?.push(notification);
        },
        outcomeJson(outcome) {
          return outcome as unknown as Record<string, unknown>;
        },
      };
    },
  };
}
