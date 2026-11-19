import type { ClientRequest, Outcome } from "@mcp-client/core";
import { loadExchangeFiles, type ExchangeFixture } from "@mcp-client/fixtures";
import { createCoreAdapter, type HarnessAdapter } from "./adapter.js";

export interface RunOptions {
  readonly exchangesDir: string;
  readonly tier?: "A" | "B";
  readonly area?: string;
  readonly idGlob?: string;
  readonly mutate?: boolean;
  readonly seed?: number;
  readonly adapter?: HarnessAdapter;
}

export interface FixtureResult {
  readonly id: string;
  readonly ok: boolean;
  readonly mutant?: string;
  readonly error?: string;
}

export interface RunSummary {
  readonly ok: boolean;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly FixtureResult[];
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

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
    const remaining = parts.slice(i).join(".");
    if (remaining in rec) {
      return rec[remaining];
    }
    return undefined;
  }
  return cur;
}

export async function runOneFixture(
  fixture: ExchangeFixture,
  adapter: HarnessAdapter,
  mutant?: string,
): Promise<FixtureResult> {
  const harness = adapter.create({
    ...(fixture.client?.setup ?? {}),
    ...(mutant ? { mutant } : {}),
  });

  const handles = new Map<string, ClientRequest<unknown>>();
  const settled = new Map<string, Outcome<unknown>>();
  const captures = new Map<string, unknown>();

  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
  };

  try {
    for (const step of fixture.script) {
      if ("do" in step && step.do === "call") {
        const ac = new AbortController();
        if (step.abortBeforeSend) {
          ac.abort("aborted-before-send");
        }
        const handle = harness.call(step.method, step.params ?? {}, {
          signal: ac.signal,
          ...(step.idempotent !== undefined ? { idempotent: step.idempotent } : {}),
        });
        handles.set(step.as, handle);
        void Promise.resolve(handle).then((out) => {
          settled.set(step.as, out);
        });
        await flushMicrotasks();
      } else if ("expect" in step && step.expect === "wire") {
        await flushMicrotasks();
        const idx = step.index ?? 0;
        const sent = harness.transport.sent[idx];
        if (!sent) {
          throw new Error(`Expected outbound message at index ${idx}, saw ${harness.transport.sent.length}`);
        }
        if (step.match) {
          for (const [path, expected] of Object.entries(step.match)) {
            const actual = getByDotPath(sent.request, path);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              throw new Error(`Wire match mismatch at ${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
            }
          }
        }
        if (step.capture) {
          for (const [varName, path] of Object.entries(step.capture)) {
            captures.set(varName, getByDotPath(sent.request, path));
          }
        }
      } else if ("server" in step) {
        let targetId = step.id;
        if (typeof targetId === "string" && targetId.startsWith("$")) {
          const cap = captures.get(targetId.slice(1));
          if (typeof cap === "string" || typeof cap === "number") {
            targetId = cap;
          }
        }
        if (targetId === undefined && step.for) {
          const targetReq = handles.get(step.for);
          if (targetReq && harness.transport.hasPending(targetReq.id)) {
            targetId = targetReq.id;
          } else {
            targetId = harness.transport.latestPendingId();
          }
        }
        if (targetId === undefined) {
          throw new Error("Server step could not resolve target request id");
        }
        if (step.server === "result") {
          harness.transport.deliverResult(targetId, step.result ?? {});
        } else {
          const err = step.error ?? { code: -32603, message: "error" };
          harness.transport.deliverError(targetId, err.code, err.message, err.data);
        }
        await flushMicrotasks();
      } else if ("advance" in step) {
        harness.clock.advance(step.advance);
        await flushMicrotasks();
      }
    }

    for (const [name, handle] of handles.entries()) {
      if (!settled.has(name)) {
        settled.set(name, await handle);
      }
    }

    if (fixture.expect.outcome) {
      for (const [callName, expectedFields] of Object.entries(fixture.expect.outcome)) {
        const actual = settled.get(callName);
        if (!actual) {
          throw new Error(`Missing outcome for call '${callName}'`);
        }
        const actualJson = harness.outcomeJson(actual);
        for (const [k, v] of Object.entries(expectedFields)) {
          const got = getByDotPath(actualJson, k);
          if (JSON.stringify(got) !== JSON.stringify(v)) {
            throw new Error(
              `Outcome mismatch for ${callName}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`,
            );
          }
        }
      }
    }

    if (fixture.expect.wire) {
      const sentList = harness.transport.sent;
      if (
        fixture.expect.wire.totalRequests !== undefined &&
        sentList.length !== fixture.expect.wire.totalRequests
      ) {
        throw new Error(
          `Wire totalRequests mismatch: expected ${fixture.expect.wire.totalRequests}, got ${sentList.length}`,
        );
      }
      if (fixture.expect.wire.distinctIds) {
        const seen = new Set<string>();
        for (const s of sentList) {
          const k = `${typeof s.request.id}:${String(s.request.id)}`;
          if (seen.has(k)) {
            throw new Error(`Duplicate wire request id detected: ${k}`);
          }
          seen.add(k);
        }
      }
      if (fixture.expect.wire.never) {
        const blob = sentList.map((s) => s.rawText).join("\n");
        for (const forbidden of fixture.expect.wire.never) {
          if (blob.includes(forbidden)) {
            throw new Error(`Forbidden wire substring '${forbidden}' found in outbound traffic`);
          }
        }
      }
    }

    await harness.client.close();
    return { id: fixture.id, ok: true, ...(mutant ? { mutant } : {}) };
  } catch (err) {
    await harness.client.close().catch(() => {});
    return {
      id: fixture.id,
      ok: false,
      ...(mutant ? { mutant } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runConformance(opts: RunOptions): Promise<RunSummary> {
  const adapter = opts.adapter ?? createCoreAdapter();
  const all = loadExchangeFiles(opts.exchangesDir);
  const selected = all.filter((f) => {
    if (opts.tier && f.tier !== opts.tier) return false;
    if (opts.area && !f.id.startsWith(`${opts.area}/`)) return false;
    if (opts.idGlob && !globMatch(opts.idGlob, f.id)) return false;
    return true;
  });

  if (selected.length === 0) {
    return {
      ok: false,
      total: 0,
      passed: 0,
      failed: 1,
      results: [{ id: opts.idGlob ?? "*", ok: false, error: "no fixtures matched selector" }],
    };
  }

  const results: FixtureResult[] = [];
  for (const fx of selected) {
    if (opts.mutate) {
      if (fx.mutants.length === 0) {
        results.push({ id: fx.id, ok: false, error: "fixture defines 0 mutants (FIX-2)" });
        continue;
      }
      for (const m of fx.mutants) {
        const res = await runOneFixture(fx, adapter, m);
        if (res.ok) {
          results.push({
            id: fx.id,
            ok: false,
            mutant: m,
            error: `VACUOUS: fixture passed under mutant '${m}'`,
          });
        } else {
          results.push({ id: fx.id, ok: true, mutant: m });
        }
      }
    } else {
      results.push(await runOneFixture(fx, adapter));
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  return {
    ok: failed === 0,
    total: results.length,
    passed,
    failed,
    results,
  };
}
