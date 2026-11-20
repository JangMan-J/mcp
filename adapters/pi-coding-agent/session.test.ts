import { expect, it, vi } from "vitest";
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
