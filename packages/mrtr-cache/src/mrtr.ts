import {
  systemClock,
  type Clock,
  type MrtrRound,
  type Outcome,
  type OutcomeMeta,
  type RequestOptions,
} from "@mcp-client/core";
import { object, Violation, type Obj, type RequestFn } from "./common.js";
import {
  elicit,
  assertSupported,
  type ElicitationOptions,
} from "./elicitation.js";

export interface MrtrOptions extends ElicitationOptions {
  clock?: Clock;
  deadlineMs?: number;
  maxRounds?: number;
  retryDelay?: number;
}
const supported = new Set(["tools/call", "resources/read", "prompts/get"]);
async function digest(state: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(state),
  );
  return [...new Uint8Array(bytes).slice(0, 8)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
/** Each invocation owns its continuation. Never resume core's closure: it captures the previous round's params. */
export class MrtrSession {
  constructor(
    private readonly request: RequestFn,
    private readonly options: MrtrOptions,
  ) {}
  async run(
    method: string,
    params: Obj = {},
    opts: RequestOptions = {},
  ): Promise<Outcome<unknown>> {
    const original = structuredClone(params),
      config = this.options,
      clock = config.clock ?? systemClock;
    const end = clock.now() + (config.deadlineMs ?? 300_000),
      trace: MrtrRound[] = [];
    const deadline = new AbortController(),
      signal = opts.signal
        ? AbortSignal.any([deadline.signal, opts.signal])
        : deadline.signal;
    let meta: OutcomeMeta = {
      method,
      requestId: "unsent",
      attempts: 0,
      binding: "local",
    };
    const stop = (): Outcome<unknown> =>
      deadline.signal.aborted || clock.now() >= end
        ? { kind: "limit-exceeded", detail: { reason: "mrtr-deadline" }, meta }
        : { kind: "cancelled", phase: "input", wasSent: false, meta };
    const violate = (reason: string, context: Obj = {}): Outcome<unknown> => {
      config.diagnostic?.(reason, context);
      return {
        kind: "protocol-violation",
        detail: { reason, ...context },
        meta,
      };
    };
    const round = async (extra: Obj): Promise<Outcome<unknown>> => {
      if (signal.aborted || clock.now() >= end) return stop();
      const clear = clock.setTimeout(() => deadline.abort(), end - clock.now());
      try {
        let out = await this.request(
          method,
          { ...original, ...extra },
          { ...opts, signal },
        );
        meta = { ...out.meta, trace: [...trace] };
        if (out.kind === "uncertain-write" && trace.length) {
          const uncertain = {
            ...out.uncertain,
            round: trace.length,
            ...(typeof extra.requestState === "string" && {
              requestStateDigest: await digest(extra.requestState),
            }),
          };
          return { ...out, uncertain, meta };
        }
        if (
          out.kind === "ok" &&
          object(out.value) &&
          out.value.resultType === "input_required"
        ) {
          const { requestState, inputRequests } = out.value;
          if (
            (requestState !== undefined && typeof requestState !== "string") ||
            (inputRequests !== undefined && !object(inputRequests))
          )
            return violate("invalid-interim");
          out = {
            kind: "mrtr-interim",
            ...(requestState !== undefined && { requestState }),
            ...(inputRequests !== undefined && { inputRequests }),
            meta,
            resume: () => {
              throw Error("unused");
            },
          };
        }
        if (out.kind !== "mrtr-interim") return { ...out, meta };
        if (!supported.has(method))
          return violate("unsupported-input-required-method", { method });
        const { requestState, inputRequests } = out;
        if (requestState === undefined && !inputRequests)
          return violate("missing-state-and-inputs");
        if (trace.length >= (config.maxRounds ?? 8))
          return {
            kind: "limit-exceeded",
            detail: { reason: "max-rounds" },
            meta,
          };
        const entries = Object.entries(inputRequests ?? {}).map(
          ([key, req]) => {
            const p = object(req) ? req.params : undefined;
            assertSupported(
              object(req) ? req.method : undefined,
              p,
              config,
              key,
            );
            return [key, p] as const;
          },
        );
        trace.push({
          round: trace.length + 1,
          action:
            opts.mrtr === "manual"
              ? "manual"
              : inputRequests
                ? "consent"
                : "auto",
        });
        let used = false;
        const resume = async (responses?: Obj): Promise<Outcome<unknown>> => {
          if (used) return violate("already-resumed");
          if (clock.now() >= end || signal.aborted) return stop();
          if (
            entries.some(([k]) => !responses || !Object.hasOwn(responses, k)) ||
            Object.keys(responses ?? {}).some(
              (k) => !Object.hasOwn(inputRequests ?? {}, k),
            )
          )
            return violate("incomplete-input-responses");
          used = true;
          return round({
            ...(requestState !== undefined && { requestState }),
            ...(inputRequests && { inputResponses: responses ?? {} }),
          });
        };
        if (opts.mrtr === "manual")
          return { ...out, resume, meta: { ...meta, trace: [...trace] } };
        const responses: Obj = Object.create(null);
        for (const [k, p] of entries)
          responses[k] = await elicit(p, config, signal);
        if (!inputRequests && config.retryDelay)
          await new Promise<void>((resolve, reject) => {
            const abort = () => {
              cancel();
              reject(signal.reason);
            };
            const cancel = clock.setTimeout(() => {
              signal.removeEventListener("abort", abort);
              resolve();
            }, config.retryDelay!);
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) abort();
          });
        return resume(responses);
      } catch (e) {
        if (signal.aborted) return stop();
        if (e instanceof Violation) return violate(e.message, e.context);
        return {
          kind: "local-error",
          detail: { reason: "request-or-port-failed" },
          meta,
        };
      } finally {
        clear();
      }
    };
    return round({});
  }
  awaitUserResume(
    interim: Extract<Outcome<unknown>, { kind: "mrtr-interim" }>,
    responses?: Obj,
  ) {
    return interim.resume(responses);
  }
}
