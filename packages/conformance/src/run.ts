import type { ClientRequest, JsonRpcNotification, Outcome, ProgressEvent } from "@mcp-client/core";
import { loadExchangeFiles, type ExchangeFixture } from "@mcp-client/fixtures";
import { createCoreAdapter, type HarnessAdapter } from "./adapter.js";
import { runTierAProvider } from "./tier-a.js";
import { runTierBAuthFixture } from "./tier-b-auth.js";
import { runTierBFixture, runTierBTransportFixture } from "./tier-b.js";
import {
  TRANSCRIPTS_ENV,
  writeTranscript,
  type Transcript,
  type TranscriptFrame,
} from "./transcript.js";

export { TRANSCRIPTS_ENV, writeTranscript, type Transcript, type TranscriptFrame } from "./transcript.js";

class ObservationMismatch extends Error {}
const coreAreas = new Set(["wire", "ver", "prog", "smoke"]);

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
  /** Only an observed expectation mismatch can kill a mutant. */
  readonly failure?: "assertion";
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
  let observed: { frames: TranscriptFrame[]; sync: () => void } | undefined;
  const result = await runOneObserved(fixture, adapter, mutant, (o) => (observed = o));
  if (mutant === undefined) {
    if (observed) {
      observed.sync();
      writeTranscript({ fixture: fixture.id, frames: observed.frames, ...(observed.frames.length === 0 && fixture.expect.wire?.totalRequests === 0 ? { zeroWire: true } : {}) });
    }
  }
  return result;
}

async function runOneObserved(
  fixture: ExchangeFixture,
  adapter: HarnessAdapter,
  mutant: string | undefined,
  expose: (o: { frames: TranscriptFrame[]; sync: () => void }) => void,
): Promise<FixtureResult> {
  const result = { id: fixture.id, ...(mutant !== undefined ? { mutant } : {}) };
  let harness;
  try {
    harness = adapter.create({ ...fixture.client?.setup, ...(mutant !== undefined ? { mutant } : {}) });
  } catch (err) {
    return { ...result, ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const handles = new Map<string, ClientRequest<unknown>>();
  const settled = new Map<string, Outcome<unknown>>();
  const captures = new Map<string, unknown>();
  // S1.1 additions: progress logs per call, era probes, injected notifications.
  const progressLog = new Map<string, ProgressEvent[]>();
  const probes = new Map<string, Promise<unknown>>();
  const probeResults = new Map<string, unknown>();
  // Baseline-only transcript of what actually crossed the send seam, in observed order.
  const frames: TranscriptFrame[] = [];
  let clientSeen = 0;
  const syncClient = () => {
    const sent = harness.outbound ?? harness.transport.sent.map((s) => JSON.parse(s.rawText) as unknown);
    for (; clientSeen < sent.length; clientSeen++) {
      frames.push({ direction: "client", message: sent[clientSeen] });
    }
  };
  const wasSent = (id: unknown) => harness.transport.sent.some((s) => s.request.id === id);
  expose({ frames, sync: syncClient });

  const flushMicrotasks = async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  };

  const resolveId = (raw: unknown): string | number | undefined => {
    if (typeof raw === "string" && raw.startsWith("$")) {
      const cap = captures.get(raw.slice(1));
      return typeof cap === "string" || typeof cap === "number" ? cap : undefined;
    }
    return typeof raw === "string" || typeof raw === "number" ? raw : undefined;
  };

  try {
    for (const step of fixture.script) {
      const loose = step as unknown as Record<string, unknown>;
      if (loose["do"] === "abort") {
        const target = handles.get(String(loose["target"]));
        if (!target) throw new Error(`abort step: unknown call '${String(loose["target"])}'`);
        target.cancel(typeof loose["reason"] === "string" ? loose["reason"] : "aborted-by-fixture");
        await flushMicrotasks();
        continue;
      }
      if (loose["do"] === "probe") {
        const name = String(loose["as"]);
        const p = harness.client.probe().then((r) => {
          probeResults.set(name, r);
          return r;
        });
        p.catch(() => {});
        probes.set(name, p);
        await flushMicrotasks();
        continue;
      }
      if (loose["server"] === "notify") {
        let targetId = resolveId(loose["id"]);
        if (targetId === undefined && typeof loose["for"] === "string") {
          targetId = handles.get(loose["for"])?.id;
        }
        if (targetId === undefined) throw new Error("notify step could not resolve target request id");
        if (!harness.notify) throw new Error("adapter does not support server notifications");
        syncClient();
        if (wasSent(targetId)) frames.push({ direction: "server", message: loose["notification"] });
        harness.notify(targetId, loose["notification"] as JsonRpcNotification);
        await flushMicrotasks();
        continue;
      }
      if ("do" in step && step.do === "call") {
        const ac = new AbortController();
        if (step.abortBeforeSend) {
          ac.abort("aborted-before-send");
        }
        const events: ProgressEvent[] = [];
        progressLog.set(step.as, events);
        const handle = harness.call(step.method, step.params ?? {}, {
          signal: ac.signal,
          ...(step.idempotent !== undefined ? { idempotent: step.idempotent } : {}),
          ...(typeof loose["timeoutMs"] === "number" ? { timeoutMs: loose["timeoutMs"] } : {}),
          ...(loose["progress"] === true ? { onProgress: (e: ProgressEvent) => events.push(e) } : {}),
          ...(typeof loose["meta"] === "object" && loose["meta"] !== null
            ? { meta: loose["meta"] as Record<string, unknown> }
            : {}),
        });
        handles.set(step.as, handle);
        void Promise.resolve(handle).then(
          (out) => {
            settled.set(step.as, out);
          },
          () => {
            // The rejection surfaces when the handle is awaited below; avoid an unhandled rejection.
          },
        );
        await flushMicrotasks();
      } else if ("expect" in step && step.expect === "wire") {
        await flushMicrotasks();
        const idx = step.index ?? 0;
        const sent = harness.transport.sent[idx];
        if (!sent) {
          throw new ObservationMismatch(`Expected outbound message at index ${idx}, saw ${harness.transport.sent.length}`);
        }
        if (step.match) {
          for (const [path, expected] of Object.entries(step.match)) {
            const actual = getByDotPath(sent.request, path);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
              throw new ObservationMismatch(`Wire match mismatch at ${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
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
          throw new ObservationMismatch("Server step could not resolve target request id");
        }
        syncClient();
        const pending = harness.transport.hasPending(targetId);
        if (step.server === "result") {
          if (pending) frames.push({ direction: "server", message: { jsonrpc: "2.0", id: targetId, result: step.result ?? {} } });
          harness.transport.deliverResult(targetId, step.result ?? {});
        } else {
          const err = step.error ?? { code: -32603, message: "error" };
          if (pending) {
            const error = { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) };
            frames.push({ direction: "server", message: { jsonrpc: "2.0", id: targetId, error } });
          }
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

    for (const [name, p] of probes.entries()) {
      if (!probeResults.has(name)) probeResults.set(name, await p);
    }

    if (fixture.expect.outcome) {
      for (const [callName, expectedFields] of Object.entries(fixture.expect.outcome)) {
        const actual = settled.get(callName);
        const probeResult = probeResults.get(callName);
        if (!actual && probeResult === undefined) {
          throw new Error(`Missing outcome for call '${callName}'`);
        }
        const actualJson = actual ? harness.outcomeJson(actual) : (probeResult as Record<string, unknown>);
        for (const [k, v] of Object.entries(expectedFields)) {
          const got = getByDotPath(actualJson, k);
          if (JSON.stringify(got) !== JSON.stringify(v)) {
            throw new ObservationMismatch(
              `Outcome mismatch for ${callName}.${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`,
            );
          }
        }
      }
    }

    const looseExpect = fixture.expect as unknown as Record<string, unknown>;
    const expectProgress = looseExpect["progress"] as Record<string, readonly number[]> | undefined;
    if (expectProgress) {
      for (const [callName, values] of Object.entries(expectProgress)) {
        const got = (progressLog.get(callName) ?? []).map((e) => e.progress);
        if (JSON.stringify(got) !== JSON.stringify(values)) {
          throw new ObservationMismatch(`Progress mismatch for ${callName}: expected ${JSON.stringify(values)}, got ${JSON.stringify(got)}`);
        }
      }
    }
    const expectStats = looseExpect["stats"] as Record<string, unknown> | undefined;
    if (expectStats) {
      const stats = harness.client.wireStats();
      for (const [path, v] of Object.entries(expectStats)) {
        const got = getByDotPath(stats, path);
        if (JSON.stringify(got) !== JSON.stringify(v)) {
          throw new ObservationMismatch(`Stats mismatch at ${path}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
        }
      }
    }
    const expectNotifications = looseExpect["notifications"] as Record<string, number> | undefined;
    if (expectNotifications) {
      for (const [callName, count] of Object.entries(expectNotifications)) {
        const handle = handles.get(callName);
        if (!handle) throw new Error(`notifications expectation: unknown call '${callName}'`);
        let n = 0;
        for await (const _ of handle.notifications) n += 1;
        if (n !== count) {
          throw new ObservationMismatch(`Notification count mismatch for ${callName}: expected ${count}, got ${n}`);
        }
      }
    }

    if (fixture.expect.wire) {
      const sentList = harness.transport.sent;
      if (fixture.expect.wire.count) {
        for (const [method, count] of Object.entries(fixture.expect.wire.count)) {
          const got = sentList.filter((s) => s.request.method === method).length;
          if (got !== count) {
            throw new ObservationMismatch(`Wire count mismatch for ${method}: expected ${count}, got ${got}`);
          }
        }
      }
      if (
        fixture.expect.wire.totalRequests !== undefined &&
        sentList.length !== fixture.expect.wire.totalRequests
      ) {
        throw new ObservationMismatch(
          `Wire totalRequests mismatch: expected ${fixture.expect.wire.totalRequests}, got ${sentList.length}`,
        );
      }
      if (fixture.expect.wire.distinctIds) {
        const seen = new Set<string>();
        for (const s of sentList) {
          const k = `${typeof s.request.id}:${String(s.request.id)}`;
          if (seen.has(k)) {
            throw new ObservationMismatch(`Duplicate wire request id detected: ${k}`);
          }
          seen.add(k);
        }
      }
      if (fixture.expect.wire.never) {
        const blob = sentList.map((s) => s.rawText).join("\n");
        for (const forbidden of fixture.expect.wire.never) {
          if (blob.includes(forbidden)) {
            throw new ObservationMismatch(`Forbidden wire substring '${forbidden}' found in outbound traffic`);
          }
        }
      }
    }

    await harness.client.close();
    return { ...result, ok: true };
  } catch (err) {
    try {
      await harness.client.close();
    } catch (closeError) {
      return { ...result, ok: false, error: closeError instanceof Error ? closeError.message : String(closeError) };
    }
    return {
      ...result,
      ok: false,
      ...(err instanceof ObservationMismatch ? { failure: "assertion" as const } : {}),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runSelectedFixture(fixture: ExchangeFixture, adapter?: HarnessAdapter, mutant?: string): Promise<FixtureResult> {
  if (adapter) return runOneFixture(fixture, adapter, mutant);
  if (fixture.tier === "A") {
    const result = await runTierAProvider(fixture, mutant);
    if (result) {
      return result;
    }
    if (coreAreas.has(fixture.id.split("/", 1)[0]!)) {
      if (!Array.isArray(fixture.script) || fixture.script.length === 0) {
        return { id: fixture.id, ok: false, error: "empty core script" };
      }
      return runOneFixture(fixture, createCoreAdapter(), mutant);
    }
  }
  if (fixture.tier === "B") {
    const auth = await runTierBAuthFixture(fixture, mutant);
    if (auth) return auth;
    const sub = await runTierBFixture(fixture, mutant);
    if (sub) {
      const { mutationKilled: _killed, ...clean } = sub;
      return clean;
    }
    const transport = await runTierBTransportFixture(fixture, mutant);
    if (transport) {
      return transport;
    }
  }
  return {
    id: fixture.id,
    ok: false,
    ...(mutant !== undefined ? { mutant } : {}),
    error: `Unhandled Tier ${fixture.tier} fixture '${fixture.id}'`,
  };
}

export async function runConformance(opts: RunOptions): Promise<RunSummary> {
  const all = loadExchangeFiles(opts.exchangesDir);
  const selected = all.filter((f) => {
    if (opts.tier && f.tier !== opts.tier) return false;
    if (opts.area) {
      const prefixes = opts.area.split(",").map((t) => t.trim().replace(/:/g, "/")).filter(Boolean);
      if (!prefixes.some((prefix) => f.id.startsWith(`${prefix}/`))) return false;
    }
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
      const baseline = await runSelectedFixture(fx, opts.adapter);
      if (!baseline.ok) {
        results.push({ ...baseline, error: `Baseline failed: ${baseline.error ?? "unknown error"}` });
        continue;
      }
      for (const m of fx.mutants) {
        const res = await runSelectedFixture(fx, opts.adapter, m);
        if (res.ok) {
          results.push({
            id: fx.id,
            ok: false,
            mutant: m,
            error: `VACUOUS: fixture passed under mutant '${m}'`,
          });
        } else if (res.failure === "assertion") {
          results.push({ id: fx.id, ok: true, mutant: m });
        } else {
          results.push(res);
        }
      }
    } else {
      results.push(await runSelectedFixture(fx, opts.adapter));
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
