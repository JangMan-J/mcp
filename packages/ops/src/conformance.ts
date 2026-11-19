/** Scripted in-process driver for the Ops conformance exchanges. */
import { McpClient, type ClientRequest, type JsonRpcRequest, type Outcome, type Exchange, type ExchangeEnd, type JsonRpcNotification, type Transport, type TransportCall, type TransportDiagnostic } from "@mcp-client/core";
import {
  createBuiltinValidator,
  createOps,
  type Ops,
  type OpsClient,
  type OpsOptions,
  type SchemaValidator,
} from "./index.js";

export class OpsObservationMismatch extends Error {}

const emptyNotifications: AsyncIterable<JsonRpcNotification> = {
  async *[Symbol.asyncIterator]() {},
};

interface Pending {
  readonly req: JsonRpcRequest;
  readonly resolve: (end: ExchangeEnd) => void;
}

export interface TranscriptFrame {
  readonly direction: "client" | "server";
  readonly message: unknown;
}

export interface ExchangeResult {
  readonly frames: readonly TranscriptFrame[];
  readonly zeroWire?: true;
}

/** In-proc scripted transport. Requests wait until the test answers them. */
class ScriptTransport implements Transport {
  readonly binding = "stdio" as const;
  readonly sent: JsonRpcRequest[] = [];
  readonly pending: Pending[] = [];
  readonly frames: TranscriptFrame[] = [];
  readonly diagnostics: AsyncIterable<TransportDiagnostic> = {
    async *[Symbol.asyncIterator]() {},
  };

  start(msg: JsonRpcRequest, ctx?: TransportCall): Exchange {
    this.sent.push(msg);
    this.frames.push({ direction: "client", message: structuredClone(msg) });
    let resolve!: (end: ExchangeEnd) => void;
    const done = new Promise<ExchangeEnd>((r) => (resolve = r));
    const entry: Pending = { req: msg, resolve };
    this.pending.push(entry);
    // Like a real transport, an aborted exchange ends without a response.
    ctx?.signal?.addEventListener(
      "abort",
      () => {
        const i = this.pending.indexOf(entry);
        if (i < 0) return;
        this.pending.splice(i, 1);
        resolve({ kind: "failure", failure: { kind: "closed", message: "aborted" }, delivery: "maybe-delivered" });
      },
      { once: true },
    );
    return { notifications: emptyNotifications, done };
  }

  async notify(msg: JsonRpcNotification): Promise<void> {
    this.frames.push({ direction: "client", message: structuredClone(msg) });
  }

  async close(): Promise<void> {
    this.failAll();
  }

  /** Answer the oldest pending request. */
  reply(result: Record<string, unknown>): void {
    const p = this.take();
    const message = { jsonrpc: "2.0" as const, id: p.req.id, result: structuredClone(result) };
    this.frames.push({ direction: "server", message: structuredClone(message) });
    p.resolve({ kind: "response", message });
  }

  replyError(error: { code: number; message: string; data?: unknown }): void {
    const p = this.take();
    const message = { jsonrpc: "2.0" as const, id: p.req.id, error: structuredClone(error) };
    this.frames.push({ direction: "server", message: structuredClone(message) });
    p.resolve({ kind: "response", message });
  }

  failAll(): void {
    for (const p of this.pending.splice(0)) {
      p.resolve({ kind: "failure", failure: { kind: "closed", message: "script ended" }, delivery: "not-sent" });
    }
  }

  private take(): Pending {
    const p = this.pending.shift();
    if (!p) throw new Error("no pending request to answer");
    return p;
  }
}

/** Params as sent, without the core-owned _meta. */
function paramsOf(req: JsonRpcRequest | undefined): Record<string, unknown> {
  const { _meta, ...rest } = (req?.params ?? {}) as Record<string, unknown>;
  void _meta;
  return rest;
}

async function settle(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

type Step =
  | { do: "call"; as: string; op: string; args?: unknown[] }
  | { server: "result"; result: Record<string, unknown> }
  | { server: "error"; error: { code: number; message: string; data?: unknown } };

export interface OpsFixture {
  id: string;
  requirements: string[];
  server?: { capabilities?: Record<string, unknown> };
  script: Step[];
  expect: {
    outcome?: Record<string, Record<string, unknown>>;
    wire?: {
      totalRequests?: number;
      methods?: string[];
      params?: Record<string, Record<string, unknown>>;
      never?: string[];
    };
  };
  mutants: string[];
}

// ---------------------------------------------------------------- mutants

// Mutation operators poke at arbitrary outcome shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOutcome = any;

interface Mutant {
  /** Change the options ops is built with (validator, capabilities). */
  readonly opts?: (o: OpsOptions) => OpsOptions;
  /** Simulate ops sending or reading the wire differently. */
  readonly request?: (method: string, params: Record<string, unknown>) => [string, Record<string, unknown>];
  readonly result?: (method: string, outcome: AnyOutcome) => AnyOutcome;
  /** Patch this fixture's API instances only. */
  readonly patch?: (ops: Ops) => void;
  /** Simulate ops mapping an outcome wrongly. */
  readonly post?: (op: string, outcome: AnyOutcome) => AnyOutcome;
}

const permissive: SchemaValidator = {
  compile: () => ({ ok: true, validate: () => ({ valid: true, errors: [] }) }),
};

/** Builtin validator over a schema with some keywords deleted everywhere. */
function stripping(...keys: string[]): SchemaValidator {
  const inner = createBuiltinValidator();
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).filter(([k]) => !keys.includes(k)).map(([k, x]) => [k, strip(x)]));
    }
    return v;
  };
  return { compile: (s) => inner.compile(strip(s)) };
}

/** Force an option into a list/call method's options argument at index `at`. */
function forceOpt<T extends object>(api: T, name: keyof T, at: number, extra: Record<string, unknown>): void {
  const original = api[name] as (...args: unknown[]) => unknown;
  api[name] = ((...args: unknown[]) => {
    args[at] = { ...(args[at] as object | undefined), ...extra };
    return original.apply(api, args);
  }) as T[keyof T];
}

function forceListOpt(ops: Ops, extra: Record<string, unknown>): void {
  forceOpt(ops.tools, "listAll", 0, extra);
  forceOpt(ops.prompts, "listAll", 0, extra);
  forceOpt(ops.resources, "listAll", 0, extra);
  forceOpt(ops.resources, "listAllTemplates", 0, extra);
}

const MUTANTS: Record<string, Mutant> = {
  "ignore-capability-gate": {
    opts: ({ capabilities: _c, ...rest }) => rest,
  },
  "no-32601-mapping": {
    post: (_op, o) =>
      o.kind === "capability-absent" && o.detail?.code === -32601
        ? { kind: "jsonrpc-error", code: -32601, message: String(o.detail.message), meta: o.meta }
        : o,
  },
  "no-32602-invalid-arguments": {
    post: (_op, o) =>
      o.kind === "invalid-arguments" && o.detail?.code === -32602
        ? { kind: "jsonrpc-error", code: -32602, message: String(o.detail.message), meta: o.meta }
        : o,
  },
  "no-completion-truncation": {
    post: (op, o) =>
      op === "completion.complete" && o.kind === "ok" && o.value.truncated
        ? {
            ...o,
            value: {
              ...o.value,
              truncated: false,
              values: [...o.value.values, ...Array.from({ length: o.value.originalCount - o.value.values.length }, () => "")],
            },
          }
        : o,
  },
  "accept-invalid-base64": {
    post: (op, o) =>
      op === "tools.call" && o.kind === "ok"
        ? {
            ...o,
            value: {
              ...o.value,
              content: o.value.content.map((b: { issues: string[] }) => ({
                ...b,
                issues: b.issues.filter((i) => i !== "invalid-base64" && i !== "invalid-mimeType"),
              })),
            },
          }
        : o,
  },
  "accept-invalid-media": {
    post: (op, o) =>
      op === "prompts.get" && o.kind === "protocol-violation" && o.detail?.reason === "invalid-media"
        ? { kind: "ok", value: { raw: {}, messages: [] }, meta: o.meta }
        : o,
  },
  "drop-unknown-blocks": {
    post: (op, o) =>
      op === "tools.call" && o.kind === "ok"
        ? { ...o, value: { ...o.value, content: o.value.content.filter((b: { type: string }) => b.type !== "unknown") } }
        : o,
  },
  "restart-on-invalid-cursor": {
    patch: (ops) => forceListOpt(ops, { restartOnInvalidCursor: true }),
  },
  "stop-after-first-page": {
    patch: (ops) => forceListOpt(ops, { maxPages: 1 }),
  },
  "rewrite-cursor": {
    request: (m, p) => [m, typeof p["cursor"] === "string" ? { ...p, cursor: encodeURIComponent(p["cursor"]) } : p],
  },
  "no-cursor-loop-guard": {
    // A helper without the guard keeps going; emulate by making every cursor look fresh.
    result: (_m, o) =>
      o.kind === "ok" && typeof o.value?.nextCursor === "string"
        ? { ...o, value: { ...o.value, nextCursor: `${o.value.nextCursor}#${o.meta.requestId}` } }
        : o,
  },
  "empty-cursor-is-end": {
    result: (_m, o) => {
      if (o.kind !== "ok" || o.value?.nextCursor !== "") return o;
      const { nextCursor: _n, ...rest } = o.value;
      return { ...o, value: rest };
    },
  },
  "drop-embedded-resource": {
    post: (op, o) =>
      op === "prompts.get" && o.kind === "ok"
        ? {
            ...o,
            value: {
              ...o.value,
              messages: o.value.messages.map((m: { content: { type: string; raw: unknown } }) =>
                m.content.type === "resource" ? { ...m, content: { type: "unknown", raw: m.content.raw, issues: ["unknown-type"] } } : m,
              ),
            },
          }
        : o,
  },
  "error-to-protocol-violation": {
    post: (_op, o) => (o.kind === "jsonrpc-error" ? { kind: "protocol-violation", detail: { code: o.code }, meta: o.meta } : o),
  },
  "drop-prompt-arguments": {
    request: (m, p) => {
      if (m !== "prompts/get") return [m, p];
      const { arguments: _a, ...rest } = p;
      return [m, rest];
    },
  },
  "sort-list": {
    post: (op, o) => {
      if (o.kind !== "ok") return o;
      const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
      if (op === "tools.list") return { ...o, value: { ...o.value, tools: [...o.value.tools].sort(byName) } };
      if (op === "prompts.list") return { ...o, value: { ...o.value, prompts: [...o.value.prompts].sort(byName) } };
      return o;
    },
  },
  "drop-flagged-items": {
    post: (op, o) =>
      op === "resources.list" && o.kind === "ok"
        ? { ...o, value: { ...o.value, items: o.value.items.filter((i: { issues: string[] }) => i.issues.length === 0) } }
        : o,
  },
  "drop-annotation-check": {
    post: (op, o) =>
      op === "resources.list" && o.kind === "ok"
        ? {
            ...o,
            value: {
              ...o.value,
              items: o.value.items.map((i: { issues: string[] }) => ({
                ...i,
                issues: i.issues.filter((x) => !x.startsWith("annotation-")),
              })),
            },
          }
        : o,
  },
  "empty-is-not-found": {
    post: (op, o) =>
      op === "resources.read" && o.kind === "ok" && o.value.empty
        ? { kind: "jsonrpc-error", code: -32602, message: "inferred", refined: "resource-not-found", meta: o.meta }
        : o,
  },
  "skip-blob-check": {
    post: (op, o) =>
      op === "resources.read" && o.kind === "ok"
        ? {
            ...o,
            value: {
              ...o.value,
              contents: o.value.contents.map((c: { issues: string[] }) => ({ ...c, issues: c.issues.filter((i) => i !== "invalid-base64") })),
            },
          }
        : o,
  },
  "no-not-found-refinement": {
    post: (_op, o) => {
      if (o.kind !== "jsonrpc-error") return o;
      const { refined: _r, ...rest } = o;
      return rest as AnyOutcome;
    },
  },
  "accept-text-and-blob": {
    result: (m, o) =>
      m === "resources/read" && o.kind === "ok" && Array.isArray(o.value?.contents)
        ? {
            ...o,
            value: {
              ...o.value,
              contents: o.value.contents.map((c: Record<string, unknown>) => {
                if (!("text" in c && "blob" in c)) return c;
                const { blob: _b, ...rest } = c;
                return rest;
              }),
            },
          }
        : o,
  },
  "templates-wrong-method": {
    request: (m, p) => [m === "resources/templates/list" ? "resources/list" : m, p],
  },
  "permissive-validator": {
    opts: (o) => ({ ...o, validator: permissive }),
  },
  "unbounded-validator": {
    opts: (o) => ({
      ...o,
      validator: createBuiltinValidator({ bounds: { maxDepth: 1e9, maxSubschemas: 1e9, maxBytes: 1e12 } }),
    }),
  },
  "ignore-dialect": {
    opts: (o) => ({ ...o, validator: stripping("$schema") }),
  },
  "ignore-prefixItems": {
    opts: (o) => ({ ...o, validator: stripping("prefixItems") }),
  },
  "ignore-external-ref": {
    opts: (o) => ({ ...o, validator: stripping("$ref") }),
  },
  "skip-input-validation": {
    patch: (ops) => forceOpt(ops.tools, "call", 2, { validateInput: false }),
  },
  "allow-unvalidated-default": {
    patch: (ops) => forceOpt(ops.tools, "call", 2, { allowUnvalidated: true }),
  },
  "ignore-strict-output": {
    patch: (ops) => forceOpt(ops.tools, "call", 2, { strictOutput: false }),
  },
  "isError-as-ok": {
    post: (op, o) => (op === "tools.call" && o.kind === "tool-isError" ? { kind: "ok", value: o.result, meta: o.meta } : o),
  },
  "jsonrpc-error-to-isError": {
    post: (op, o) =>
      op === "tools.call" && o.kind === "jsonrpc-error"
        ? { kind: "tool-isError", result: { isError: true, content: [{ type: "text", text: o.message }] }, meta: o.meta }
        : o,
  },
  "coerce-structured-object": {
    post: (op, o) =>
      op === "tools.call" && o.kind === "ok" && "structuredContent" in o.value
        ? {
            ...o,
            value: {
              ...o.value,
              structuredContent:
                o.value.structuredContent && typeof o.value.structuredContent === "object" && !Array.isArray(o.value.structuredContent)
                  ? o.value.structuredContent
                  : {},
            },
          }
        : o,
  },
  "drop-tool-arguments": {
    request: (m, p) => {
      if (m !== "tools/call") return [m, p];
      const { arguments: _a, ...rest } = p;
      return [m, rest];
    },
  },
  "keep-null-inputSchema": {
    result: (m, o) =>
      m === "tools/list" && o.kind === "ok" && Array.isArray(o.value?.tools)
        ? {
            ...o,
            value: {
              ...o.value,
              tools: o.value.tools.map((t: Record<string, unknown>) => (t["inputSchema"] === null ? { ...t, inputSchema: {} } : t)),
            },
          }
        : o,
  },
  "drop-list-hints": {
    post: (op, o) => {
      if (op !== "tools.list" || o.kind !== "ok") return o;
      const { ttlMs: _t, cacheScope: _c, ...rest } = o.value;
      return { ...o, value: rest };
    },
  },
};

export const supportsMutant = (name: string): boolean => Object.hasOwn(MUTANTS, name);

// ---------------------------------------------------------------- runner

function getByDotPath(obj: unknown, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let cur: unknown = obj;
  for (let i = 0; i < parts.length; i++) {
    if (typeof cur !== "object" || cur === null) return undefined;
    const rec = cur as Record<string, unknown>;
    const key = parts[i]!;
    if (key in rec) {
      cur = rec[key];
      continue;
    }
    return undefined;
  }
  return cur;
}

function mutatedClient(client: McpClient, m: Mutant | undefined): OpsClient {
  if (!m?.request && !m?.result) return client;
  return {
    request<T>(method: string, params: Record<string, unknown> = {}, opts?: Parameters<OpsClient["request"]>[2]) {
      const [m2, p2] = m.request ? m.request(method, params) : [method, params];
      const inner = client.request<T>(m2, p2, opts);
      if (!m.result) return inner;
      const wrapped = Promise.resolve(inner).then((o) => m.result!(method, o as AnyOutcome) as Outcome<T>);
      return Object.assign(wrapped, { id: inner.id, cancel: inner.cancel.bind(inner) }) as unknown as ClientRequest<T>;
    },
  };
}

async function waitPending(t: ScriptTransport): Promise<void> {
  for (let i = 0; i < 50 && t.pending.length === 0; i++) await settle(1);
  if (t.pending.length === 0) throw new OpsObservationMismatch("script expected a request but none was sent");
}

export async function runExchange(fixture: unknown, mutantName?: string): Promise<ExchangeResult> {
  const fx = fixture as OpsFixture;
  if (!Array.isArray(fx.script) || fx.script.length === 0) throw new Error("empty Ops script");
  const w = fx.expect.wire;
  const hasAssertions = Object.values(fx.expect.outcome ?? {}).some((fields) => Object.keys(fields).length > 0)
    || w?.totalRequests !== undefined || w?.methods !== undefined
    || Object.values(w?.params ?? {}).some((fields) => Object.keys(fields).length > 0)
    || Boolean(w?.never?.length);
  if (!hasAssertions) throw new Error("Ops exchange has no assertions");
  const m = mutantName !== undefined && supportsMutant(mutantName) ? MUTANTS[mutantName] : undefined;
  if (mutantName !== undefined && !m) throw new Error(`unknown mutant '${mutantName}'`);
  const transport = new ScriptTransport();
  const client = new McpClient({ transport, server: { key: fx.id } });
  const base: OpsOptions = fx.server?.capabilities ? { capabilities: fx.server.capabilities } : {};
  const calls = new Map<string, Promise<AnyOutcome>>();
  try {
    const instance = createOps(mutatedClient(client, m), m?.opts ? m.opts(base) : base);
    m?.patch?.(instance);
    const ops = instance as unknown as Record<string, Record<string, (...a: unknown[]) => Promise<Outcome<unknown>>>>;
    for (const step of fx.script) {
      if ("do" in step && step.do === "call") {
        const [ns, fn] = step.op.split(".") as [string, string];
        const api = ops[ns];
        if (!api || typeof api[fn] !== "function") throw new Error(`unknown op ${step.op}`);
        const p = api[fn]!(...(step.args ?? [])).then((o) => (m?.post ? m.post(step.op, o as AnyOutcome) : (o as AnyOutcome)));
        calls.set(step.as, p);
        await settle();
      } else if ("server" in step && (step.server === "result" || step.server === "error")) {
        await waitPending(transport);
        if (step.server === "result") transport.reply(step.result);
        else transport.replyError(step.error);
        await settle();
      } else {
        throw new Error("unknown Ops script step");
      }
    }
    await settle();
    transport.failAll();
    const outcomes = new Map<string, AnyOutcome>();
    for (const [k, p] of calls) outcomes.set(k, await p);
    for (const [name, fields] of Object.entries(fx.expect.outcome ?? {})) {
      const o = outcomes.get(name);
      if (!o) throw new Error(`no outcome for ${name}`);
      const json = JSON.parse(JSON.stringify(o)) as unknown;
      for (const [path, want] of Object.entries(fields)) {
        const got = getByDotPath(json, path);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          throw new OpsObservationMismatch(`${name}.${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        }
      }
    }
    const sent: JsonRpcRequest[] = transport.sent;
    if (w?.totalRequests !== undefined && sent.length !== w.totalRequests) {
      throw new OpsObservationMismatch(`totalRequests: expected ${w.totalRequests}, got ${sent.length}`);
    }
    if (w?.methods && JSON.stringify(sent.map((s) => s.method)) !== JSON.stringify(w.methods)) {
      throw new OpsObservationMismatch(`methods: expected ${JSON.stringify(w.methods)}, got ${JSON.stringify(sent.map((s) => s.method))}`);
    }
    for (const [idx, want] of Object.entries(w?.params ?? {})) {
      const got = paramsOf(sent[Number(idx)]);
      for (const [k, v] of Object.entries(want)) {
        if (JSON.stringify(got[k]) !== JSON.stringify(v)) {
          throw new OpsObservationMismatch(`params[${idx}].${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
        }
      }
    }
    for (const never of w?.never ?? []) {
      if (sent.some((s) => s.method === never || JSON.stringify(s).includes(never))) {
        throw new OpsObservationMismatch(`forbidden wire content '${never}'`);
      }
    }
    const frames = transport.frames;
    return {
      frames,
      ...(frames.length === 0 && fx.expect?.wire?.totalRequests === 0 ? { zeroWire: true } : {}),
    };
  } finally {
    await client.close();
  }
}
