import { describe, expect, it } from "vitest";
import type { Outcome, StreamHandle } from "@mcp-client/core";
import { SubscriptionManager } from "../src/index.js";

function fakeStream(id: number): StreamHandle {
  let finish!: (o: Outcome<unknown>) => void;
  const done = new Promise<Outcome<unknown>>((r) => (finish = r));
  return {
    id,
    done,
    close() {},
    async *[Symbol.asyncIterator]() {
      await done;
    },
  } as StreamHandle;
}

describe("local limits: listen streams", () => {
  it("[LIM-SUB-1] caps concurrent listen streams (default 8); frees a slot when one ends", () => {
    let opened = 0;
    const mgr = new SubscriptionManager({
      binding: "stdio",
      serverRef: "s",
      open: () => fakeStream(++opened),
    });
    const subs = Array.from({ length: 8 }, () => mgr.listen({ tools: true }));
    expect(opened).toBe(8);
    expect(() => mgr.listen({ tools: true })).toThrow(RangeError);
    expect(() => mgr.listen({ tools: true })).toThrow(/too many concurrent listen streams/);
    expect(opened).toBe(8); // nothing sent for the rejected 9th
    subs[0]!.close();
    const again = mgr.listen({ tools: true });
    expect(opened).toBe(9);
    expect(again.state).toBe("opening");
    for (const s of [...subs, again]) s.close();
  });

  it("[LIM-SUB-1] maxListenStreams is configurable", () => {
    let opened = 0;
    const mgr = new SubscriptionManager({
      binding: "stdio",
      serverRef: "s",
      maxListenStreams: 2,
      open: () => fakeStream(++opened),
    });
    const a = mgr.listen({ tools: true });
    const b = mgr.listen({ prompts: true });
    expect(() => mgr.listen({ resources: true })).toThrow(RangeError);
    expect(opened).toBe(2);
    a.close();
    b.close();
  });
});
