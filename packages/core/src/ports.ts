import type { JsonRpcErrorResponse, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "./jsonrpc.js";
import type { TransportFailure } from "./outcome.js";
import type { TelemetryPort } from "./telemetry.js";

export interface TransportDiagnostic {
  readonly kind: "stderr" | "noise" | "violation" | "lifecycle";
  readonly message: string;
  readonly atMs: number;
}

export interface TransportCall {
  readonly signal: AbortSignal;
  readonly idempotent: boolean;
  readonly headersHint?: {
    readonly name?: string;
    readonly params?: Readonly<Record<string, string | number | boolean>>;
  };
  readonly timeoutMs: number;
  readonly consent?: ConsentPort;
  readonly serverLabel?: string;
}

export type ExchangeEnd =
  | { readonly kind: "response"; readonly message: JsonRpcResponse | JsonRpcErrorResponse }
  | {
      readonly kind: "failure";
      readonly failure: TransportFailure;
      readonly delivery: "not-sent" | "maybe-delivered" | "delivered-no-response";
    };

export interface Exchange {
  /** Current delivery evidence if interrupted before done settles. */
  abortDelivery?(): Extract<ExchangeEnd, { kind: "failure" }>["delivery"];
  readonly notifications: AsyncIterable<JsonRpcNotification>;
  readonly done: Promise<ExchangeEnd>;
}

export interface Transport {
  readonly binding: "stdio" | "streamable-http" | (string & {});
  start(msg: JsonRpcRequest, ctx: TransportCall): Exchange;
  notify(msg: JsonRpcNotification, ctx: TransportCall): Promise<void>;
  close(opts?: { readonly graceMs?: number }): Promise<void>;
  readonly diagnostics: AsyncIterable<TransportDiagnostic>;
}

export interface ProgressEvent {
  readonly progressToken: string | number;
  readonly progress: number;
  readonly total?: number;
  readonly message?: string;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = globalThis.setTimeout(fn, ms);
    return () => globalThis.clearTimeout(t);
  },
};

export interface RandomPort {
  bytes(len: number): Uint8Array;
}

export interface LoggerPort {
  debug(msg: string, detail?: Record<string, unknown>): void;
  warn(msg: string, detail?: Record<string, unknown>): void;
  error(msg: string, detail?: Record<string, unknown>): void;
}

export interface ConsentPrompt {
  readonly kind: "auth" | "authorize" | "client-info" | "url-elicitation" | "form-elicitation" | "tool-call";
  readonly serverLabel: string;
  readonly issuer?: string;
  readonly issuerHost?: string;
  readonly resource?: string;
  readonly scopes?: readonly string[];
  readonly redirectUri?: string;
  readonly redirectHost?: string;
  readonly localhostWarning?: boolean;
  readonly url?: string;
  readonly message?: string;
  readonly schema?: Record<string, unknown>;
}

export type ConsentResult =
  | { readonly decision: "accept"; readonly content?: Record<string, unknown> }
  | { readonly decision: "decline" | "cancel" };

export interface ConsentPort {
  request(prompt: ConsentPrompt, signal: AbortSignal): Promise<ConsentResult>;
}

export interface BrowserPort {
  open(url: string, signal: AbortSignal): Promise<void>;
}

export interface RedirectPort {
  awaitCallback(state: string, signal: AbortSignal): Promise<{ readonly code: string; readonly state: string }>;
}

export interface CredentialStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface IdentityPort {
  clientInfo(): { readonly name: string; readonly version: string; readonly title?: string };
}

export interface FetchPort {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

export interface CacheStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PortRegistry {
  readonly consent?: ConsentPort;
  readonly browser?: BrowserPort;
  readonly redirect?: RedirectPort;
  readonly credentials?: CredentialStore;
  readonly identity?: IdentityPort;
  readonly fetch?: FetchPort;
  readonly telemetry?: TelemetryPort;
  readonly cache?: CacheStore;
  readonly clock?: Clock;
  readonly random?: RandomPort;
  readonly logger?: LoggerPort;
}
