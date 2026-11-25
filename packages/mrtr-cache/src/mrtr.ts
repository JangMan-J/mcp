import {
  systemClock,
  type Clock,
  type MrtrRound,
  type Outcome,
  type OutcomeMeta,
  type RequestOptions,
  type TransportFailure,
} from "@mcp/core";
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
  /** Aborts when the underlying transport closes or fails (EDGE-27); reason may be a TransportFailure. */
  transportClosed?: AbortSignal;
}

export interface MrtrResumeOptions extends RequestOptions {
  readonly params?: Obj;
}

export type MrtrInterim = Extract<Outcome<unknown>, { kind: "mrtr-interim" }>;

interface SessionRunState {
  readonly method: string;
  readonly original: Obj;
  readonly opts: RequestOptions;
  readonly end: number;
  readonly trace: MrtrRound[];
}

interface ParkedContinuation {
  readonly run: SessionRunState;
  readonly requestState: string | undefined;
  readonly inputRequests: Obj | undefined;
  readonly meta: OutcomeMeta;
  used: boolean;
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

/**
 * Coordinates multi round-trip requests (`input_required`). Returns pure JSON-serializable
 * `mrtr-interim` outcomes when parked (in `mrtr: "manual"` mode or when `!inputRequests`
 * would otherwise delay) and exposes `resume(interim, responses?, opts?)` without holding timers.
 */
export class MrtrSession {
  private readonly parkedByInterim = new WeakMap<object, ParkedContinuation>();
  private readonly parkedByKey = new Map<string, ParkedContinuation>();
  private readonly resumedObjects = new WeakSet<object>();

  constructor(
    private readonly request: RequestFn,
    private readonly options: MrtrOptions,
  ) {}

  run(
    method: string,
    params: Obj = {},
    opts: RequestOptions = {},
  ): Promise<Outcome<unknown>> {
    const clock = this.options.clock ?? systemClock;
    const state: SessionRunState = {
      method,
      original: structuredClone(params),
      opts: { ...opts },
      end: clock.now() + (this.options.deadlineMs ?? 300_000),
      trace: [],
    };
    return this.executeRound(state, {});
  }

  /** Resumes a parked pure `mrtr-interim` outcome without mutating caller inputs or holding timers. */
  async resume(
    interim: MrtrInterim,
    responses?: Obj,
    resumeOpts?: MrtrResumeOptions,
  ): Promise<Outcome<unknown>> {
    const config = this.options;
    const clock = config.clock ?? systemClock;
    const parked =
      this.parkedByInterim.get(interim) ??
      this.parkedByKey.get(`${interim.meta.method}:${String(interim.meta.requestId)}`);

    if (this.resumedObjects.has(interim) || parked?.used) {
      return this.violate(parked?.meta ?? interim.meta, "already-resumed");
    }

    const method = parked?.run.method ?? interim.meta.method;
    if (!supported.has(method)) {
      return this.violate(parked?.meta ?? interim.meta, "unsupported-input-required-method", { method });
    }

    const requestState = parked ? parked.requestState : interim.requestState;
    const inputRequests = parked ? parked.inputRequests : interim.inputRequests;
    if (requestState === undefined && !inputRequests) {
      return this.violate(parked?.meta ?? interim.meta, "missing-state-and-inputs");
    }

    const { params: overrideParams, ...overrideRequestOpts } = resumeOpts ?? {};
    const baseOpts = parked ? parked.run.opts : {};
    const combinedSignal = this.combineSignals(baseOpts.signal, overrideRequestOpts.signal);
    const mergedOpts: RequestOptions = {
      ...baseOpts,
      ...overrideRequestOpts,
      ...(combinedSignal ? { signal: combinedSignal } : {}),
    };
    const end = parked ? parked.run.end : clock.now() + (config.deadlineMs ?? 300_000);
    const meta = parked?.meta ?? interim.meta;

    if (clock.now() >= end || combinedSignal?.aborted || config.transportClosed?.aborted) {
      return this.stopOutcome(meta, end);
    }

    const requiredKeys = Object.keys(inputRequests ?? {});
    const responseKeys = Object.keys(responses ?? {});
    if (
      requiredKeys.some((k) => !responses || !Object.hasOwn(responses, k)) ||
      responseKeys.some((k) => !Object.hasOwn(inputRequests ?? {}, k))
    ) {
      return this.violate(meta, "incomplete-input-responses");
    }

    if (parked) parked.used = true;
    this.resumedObjects.add(interim);

    const nextState: SessionRunState = {
      method,
      original:
        overrideParams !== undefined
          ? structuredClone(overrideParams)
          : parked
            ? parked.run.original
            : {},
      opts: mergedOpts,
      end,
      trace: parked ? parked.run.trace : [...(interim.meta.trace ?? [])],
    };

    const extra: Obj = {
      ...(requestState !== undefined ? { requestState } : {}),
      ...(inputRequests ? { inputResponses: structuredClone(responses ?? {}) } : {}),
    };
    return this.executeRound(nextState, extra);
  }

  private combineSignals(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
    const list = [a, b].filter((s): s is AbortSignal => s !== undefined);
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    return AbortSignal.any(list);
  }

  private stopOutcome(meta: OutcomeMeta, end: number, deadlineAborted = false): Outcome<unknown> {
    const config = this.options;
    const clock = config.clock ?? systemClock;
    const closed = config.transportClosed;
    if (closed?.aborted) {
      return {
        kind: "transport-failure",
        failure:
          object(closed.reason) && typeof closed.reason.kind === "string"
            ? (closed.reason as unknown as TransportFailure)
            : { kind: "closed", message: "transport closed during MRTR wait" },
        safeToRetry: false,
        meta,
      };
    }
    if (deadlineAborted || clock.now() >= end) {
      return { kind: "limit-exceeded", detail: { reason: "mrtr-deadline" }, meta };
    }
    return { kind: "cancelled", phase: "input", wasSent: false, meta };
  }

  private violate(meta: OutcomeMeta, reason: string, context: Obj = {}): Outcome<unknown> {
    this.options.diagnostic?.(reason, context);
    return {
      kind: "protocol-violation",
      detail: { reason, ...context },
      meta,
    };
  }

  private async executeRound(state: SessionRunState, extra: Obj): Promise<Outcome<unknown>> {
    const config = this.options;
    const clock = config.clock ?? systemClock;
    const closed = config.transportClosed;
    const deadline = new AbortController();
    const signal = AbortSignal.any(
      [deadline.signal, state.opts.signal, closed].filter(
        (s): s is AbortSignal => s !== undefined,
      ),
    );
    let meta: OutcomeMeta = {
      method: state.method,
      requestId: "unsent",
      attempts: 0,
      binding: "local",
    };

    if (signal.aborted || clock.now() >= state.end) {
      return this.stopOutcome(meta, state.end, deadline.signal.aborted);
    }

    const clear = clock.setTimeout(() => deadline.abort(), state.end - clock.now());
    try {
      let out = await this.request(
        state.method,
        { ...state.original, ...extra },
        { ...state.opts, signal },
      );
      meta = { ...out.meta, method: state.method, trace: [...state.trace] };
      if (out.kind === "uncertain-write" && state.trace.length) {
        const uncertain = {
          ...out.uncertain,
          round: state.trace.length,
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
        ) {
          return this.violate(meta, "invalid-interim");
        }
        out = {
          kind: "mrtr-interim",
          ...(requestState !== undefined ? { requestState } : {}),
          ...(inputRequests !== undefined ? { inputRequests: structuredClone(inputRequests) } : {}),
          meta,
        };
      }
      if (out.kind !== "mrtr-interim") return { ...out, meta };
      if (!supported.has(state.method)) {
        return this.violate(meta, "unsupported-input-required-method", { method: state.method });
      }
      const { requestState, inputRequests } = out;
      if (requestState === undefined && !inputRequests) {
        return this.violate(meta, "missing-state-and-inputs");
      }
      if (state.trace.length >= (config.maxRounds ?? 8)) {
        return {
          kind: "limit-exceeded",
          detail: { reason: "max-rounds" },
          meta,
        };
      }
      const entries = Object.entries(inputRequests ?? {}).map(([key, req]) => {
        const p = object(req) ? req.params : undefined;
        assertSupported(object(req) ? req.method : undefined, p, config, key);
        return [key, p] as const;
      });
      state.trace.push({
        round: state.trace.length + 1,
        action:
          state.opts.mrtr === "manual"
            ? "manual"
            : inputRequests
              ? "consent"
              : "auto",
      });
      const interimMeta: OutcomeMeta = { ...meta, trace: [...state.trace] };
      const interim: MrtrInterim = {
        kind: "mrtr-interim",
        ...(requestState !== undefined ? { requestState } : {}),
        ...(inputRequests !== undefined ? { inputRequests: structuredClone(inputRequests) } : {}),
        meta: interimMeta,
      };
      // Park without holding any timer when manual mode is requested or when !inputRequests has retryDelay.
      if (state.opts.mrtr === "manual" || (!inputRequests && Boolean(config.retryDelay))) {
        const parked: ParkedContinuation = {
          run: state,
          requestState,
          inputRequests: inputRequests ? structuredClone(inputRequests) : undefined,
          meta: interimMeta,
          used: false,
        };
        this.parkedByInterim.set(interim, parked);
        this.parkedByKey.set(`${state.method}:${String(interimMeta.requestId)}`, parked);
        return interim;
      }
      const responses: Obj = Object.create(null);
      for (const [k, p] of entries) {
        responses[k] = await elicit(p, config, signal);
      }
      if (signal.aborted || clock.now() >= state.end) {
        return this.stopOutcome(interimMeta, state.end, deadline.signal.aborted);
      }
      clear();
      return await this.executeRound(state, {
        ...(requestState !== undefined ? { requestState } : {}),
        ...(inputRequests ? { inputResponses: responses } : {}),
      });
    } catch (e) {
      if (signal.aborted) return this.stopOutcome(meta, state.end, deadline.signal.aborted);
      if (e instanceof Violation) return this.violate(meta, e.message, e.context);
      return {
        kind: "local-error",
        detail: { reason: "request-or-port-failed" },
        meta,
      };
    } finally {
      clear();
    }
  }
}
