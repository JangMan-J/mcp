/**
 * Runs every packages/fixtures/exchanges/ops/*.exchange.json against createOps over a real
 * McpClient and an in-proc scripted Transport, then re-runs each fixture under every mutant it
 * declares and requires the fixture to fail (FIX-2: no vacuous fixtures).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { McpClient, type ClientRequest, type JsonRpcRequest, type Outcome } from "@mcp-client/core";
import {
  createBuiltinValidator,
  createOps,
  PromptsApi,
  ResourcesApi,
  ToolsApi,
  type OpsClient,
  type OpsOptions,
  type SchemaValidator,
} from "../src/index.js";
import { installNetworkSpy, paramsOf, ScriptTransport, settle } from "./helpers.js";

installNetworkSpy();

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "../../fixtures/exchanges/ops");

type Step =
  | { do: "call"; as: string; op: string; args?: unknown[] }
  | { server: "result"; result: Record<string, unknown> }
  | { server: "error"; error: { code: number; message: string; data?: unknown } };

interface OpsFixture {
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
  /** Patch API behavior; returns an undo function. */
  readonly patch?: () => () => void;
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

function patchMethod<T extends object>(proto: T, name: keyof T & string, wrap: (orig: Function) => Function): () => void {
  const rec = proto as unknown as Record<string, Function>;
  const orig = rec[name] as Function;
  rec[name] = wrap(orig);
  return () => {
    rec[name] = orig;
  };
}

/** Force an option into a list/call method's options argument at index `at`. */
function forceOpt(proto: object, name: string, at: number, extra: Record<string, unknown>): () => void {
  return patchMethod(proto as Record<string, unknown>, name, (orig) =>
    function (this: unknown, ...args: unknown[]) {
      const a = [...args];
      while (a.length < at) a.push(undefined);
      a[at] = { ...(a[at] as object | undefined), ...extra };
      return orig.apply(this, a);
    },
  );
}

const listProtos: [object, string][] = [
  [ToolsApi.prototype, "listAll"],
  [PromptsApi.prototype, "listAll"],
  [ResourcesApi.prototype, "listAll"],
  [ResourcesApi.prototype, "listAllTemplates"],
];

let loopCounter = 0;

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
    patch: () => {
      const undo = listProtos.map(([p, n]) => forceOpt(p, n, 0, { restartOnInvalidCursor: true }));
      return () => undo.forEach((u) => u());
    },
  },
  "stop-after-first-page": {
    patch: () => {
      const undo = listProtos.map(([p, n]) => forceOpt(p, n, 0, { maxPages: 1 }));
      return () => undo.forEach((u) => u());
    },
  },
  "rewrite-cursor": {
    request: (m, p) => [m, typeof p["cursor"] === "string" ? { ...p, cursor: encodeURIComponent(p["cursor"]) } : p],
  },
  "no-cursor-loop-guard": {
    // A helper without the guard keeps going; emulate by making every cursor look fresh.
    result: (_m, o) =>
      o.kind === "ok" && typeof o.value?.nextCursor === "string"
        ? { ...o, value: { ...o.value, nextCursor: `${o.value.nextCursor}#${++loopCounter}` } }
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
    patch: () => forceOpt(ToolsApi.prototype, "call", 2, { validateInput: false }),
  },
  "allow-unvalidated-default": {
    patch: () => forceOpt(ToolsApi.prototype, "call", 2, { allowUnvalidated: true }),
  },
  "ignore-strict-output": {
    patch: () => forceOpt(ToolsApi.prototype, "call", 2, { strictOutput: false }),
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
  if (t.pending.length === 0) throw new Error("script expected a request but none was sent");
}

async function runFixture(fx: OpsFixture, mutantName?: string): Promise<void> {
  const m = mutantName ? MUTANTS[mutantName] : undefined;
  if (mutantName && !m) throw new Error(`unknown mutant '${mutantName}'`);
  const transport = new ScriptTransport();
  const client = new McpClient({ transport, server: { key: fx.id } });
  const base: OpsOptions = fx.server?.capabilities ? { capabilities: fx.server.capabilities } : {};
  const ops = createOps(mutatedClient(client, m), m?.opts ? m.opts(base) : base) as unknown as Record<
    string,
    Record<string, (...a: unknown[]) => Promise<Outcome<unknown>>>
  >;
  const undo = m?.patch?.();
  const calls = new Map<string, Promise<AnyOutcome>>();
  try {
    for (const step of fx.script) {
      if ("do" in step) {
        const [ns, fn] = step.op.split(".") as [string, string];
        const api = ops[ns];
        if (!api || typeof api[fn] !== "function") throw new Error(`unknown op ${step.op}`);
        const p = api[fn]!(...(step.args ?? [])).then((o) => (m?.post ? m.post(step.op, o as AnyOutcome) : (o as AnyOutcome)));
        calls.set(step.as, p);
        await settle();
      } else {
        await waitPending(transport);
        if (step.server === "result") transport.reply(step.result);
        else transport.replyError(step.error);
        await settle();
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
          throw new Error(`${name}.${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
        }
      }
    }
    const w = fx.expect.wire;
    const sent: JsonRpcRequest[] = transport.sent;
    if (w?.totalRequests !== undefined && sent.length !== w.totalRequests) {
      throw new Error(`totalRequests: expected ${w.totalRequests}, got ${sent.length}`);
    }
    if (w?.methods && JSON.stringify(sent.map((s) => s.method)) !== JSON.stringify(w.methods)) {
      throw new Error(`methods: expected ${JSON.stringify(w.methods)}, got ${JSON.stringify(sent.map((s) => s.method))}`);
    }
    for (const [idx, want] of Object.entries(w?.params ?? {})) {
      const got = paramsOf(sent[Number(idx)]);
      for (const [k, v] of Object.entries(want)) {
        if (JSON.stringify(got[k]) !== JSON.stringify(v)) {
          throw new Error(`params[${idx}].${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got[k])}`);
        }
      }
    }
    for (const never of w?.never ?? []) {
      if (sent.some((s) => s.method === never || JSON.stringify(s).includes(never))) {
        throw new Error(`forbidden wire content '${never}'`);
      }
    }
  } finally {
    undo?.();
    transport.failAll();
    await client.close().catch(() => {});
  }
}

const fixtures: OpsFixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".exchange.json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as OpsFixture);

const requirementIds = new Map<string, string>(
  (
    JSON.parse(readFileSync(join(HERE, "../../conformance/requirements.json"), "utf8")) as {
      rows: { id: string; disposition: string }[];
    }
  ).rows.map((r) => [r.id, r.disposition]),
);

describe("ops exchange fixtures", () => {
  it("found the ops fixture set", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(38);
  });

  for (const fx of fixtures) {
    describe(fx.id, () => {
      it("declares known, resolved requirement ids and at least one known mutant", () => {
        expect(fx.requirements.length).toBeGreaterThan(0);
        for (const id of fx.requirements) {
          const d = requirementIds.get(id);
          expect(d, `requirement ${id}`).toBeDefined();
          expect(d).not.toMatch(/^unresolved/);
        }
        expect(fx.mutants.length).toBeGreaterThan(0);
        for (const name of fx.mutants) expect(Object.keys(MUTANTS)).toContain(name);
      });

      it("passes", async () => {
        await runFixture(fx);
      });

      for (const name of fx.mutants) {
        it(`fails under mutant ${name}`, async () => {
          await expect(runFixture(fx, name)).rejects.toThrow();
        });
      }
    });
  }
});
