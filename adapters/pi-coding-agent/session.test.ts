import { expect, it, vi } from "vitest";
import { decodeBranch, encodeBranch } from "./branch.js";
import { startSession } from "./session.js";

it("allocates once per distinct enabled server and closes only this session", async () => {
  const make = vi.fn((name: string) => ({ name, close: vi.fn() }));
  const first = await startSession(["a", "a", "b"], make);
  const second = await startSession(["a"], make);
  expect(make.mock.results.map(r => r.value.name)).toEqual(["a", "b", "a"]);
  const read = () => first.run("a", client => client);
  expect(await read()).toBe(await read());
  await Promise.all([first.shutdown(), first.shutdown()]);
  expect(make.mock.results.map(r => r.value.close.mock.calls.length)).toEqual([1, 1, 0]);
  await expect(read()).rejects.toMatchObject({ name: "AbortError" });
  expect(await second.run("a", c => c.name)).toBe("a");
  await second.shutdown();
});

it.each(["shutdown", "request"])("drops a late result after %s aborts", async cause => {
  const session = await startSession(["server"], () => ({ close() {} }));
  const request = new AbortController();
  let finish!: () => void;
  let active!: AbortSignal;
  const pending = session.run("server", (_, signal) => {
    active = signal;
    return new Promise<void>(resolve => { finish = resolve; });
  }, request.signal);
  if (cause === "shutdown") await session.shutdown();
  else request.abort();
  expect(active.aborted).toBe(true);
  finish();
  await expect(pending).rejects.toBe(active.reason);
  await session.shutdown();
});

it("closes earlier clients if startup fails", async () => {
  const close = vi.fn();
  await expect(startSession(["a", "b"], name => {
    if (name === "b") throw new Error("unavailable");
    return { close };
  })).rejects.toThrow("unavailable");
  expect(close).toHaveBeenCalledTimes(1);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it("restores a branch lazily, sharing readiness and subscription setup across calls", async () => {
  const waitingForReady = deferred<void>();
  const ready = deferred<void>();
  const restoreStarted = deferred<void>();
  const restoring = deferred<void>();
  const events: string[] = [];
  const client = { ready: () => { waitingForReady.resolve(); return ready.promise; }, close() {} };
  const session = await startSession(["a", "unused"], name => {
    events.push(`connect:${name}`);
    return client;
  }, {
    branch: decodeBranch([encodeBranch({ cursor: "saved" })])!,
    reestablish: async (name, _, state) => {
      events.push(`restore:${name}:${state.cursor}`);
      restoreStarted.resolve();
      await restoring.promise;
      events.push("restored");
    },
  });
  expect(events).toEqual([]);
  const first = session.run("a", () => { events.push("first"); });
  const second = session.run("a", () => { events.push("second"); });
  await waitingForReady.promise;
  expect(events).toEqual(["connect:a"]);
  ready.resolve();
  await restoreStarted.promise;
  expect(events).toEqual(["connect:a", "restore:a:saved"]);
  restoring.resolve();
  await Promise.all([first, second]);
  expect(events).toEqual(["connect:a", "restore:a:saved", "restored", "first", "second"]);
  await session.shutdown();
});

it("disables an active client without delivering its late result and re-enables with a new client", async () => {
  const closed: number[] = [];
  let next = 0;
  const session = await startSession(["a"], () => {
    const id = ++next;
    return { id, close: () => { closed.push(id); } };
  });
  const result = deferred<number>();
  const pending = session.run("a", () => result.promise);
  expect(await session.run("a", c => c.id)).toBe(1);
  await session.disable("a");
  expect(closed).toEqual([1]);
  await expect(session.run("a", c => c.id)).rejects.toThrow("No session client");
  await session.enable("a");
  await session.enable("a");
  expect(await session.run("a", c => c.id)).toBe(2);
  result.resolve(1);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await session.shutdown();
  expect(closed).toEqual([1, 2]);
});

it("closes a client that arrives after disable without running or restoring it", async () => {
  const make = deferred<{ close(): void }>();
  const connecting = deferred<void>();
  const close = vi.fn();
  const operation = vi.fn();
  const reestablish = vi.fn();
  const session = await startSession(["a"], () => {
    connecting.resolve();
    return make.promise;
  }, { branch: {}, reestablish });
  const pending = session.run("a", operation);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await connecting.promise;
  const disabled = session.disable("a");
  make.resolve({ close });
  await Promise.all([disabled, rejected]);
  expect(close).toHaveBeenCalledTimes(1);
  expect(operation).not.toHaveBeenCalled();
  expect(reestablish).not.toHaveBeenCalled();
  await session.shutdown();
});
