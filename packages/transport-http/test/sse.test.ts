import { describe, expect, it } from "vitest";
import { SseParser, SseEventTooLargeError } from "../src/index.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseAll(chunks: readonly Uint8Array[]): unknown {
  const p = new SseParser();
  const events = [];
  for (const c of chunks) events.push(...p.push(c));
  events.push(...p.end());
  return events;
}

const STREAMS: readonly string[] = [
  'data: {"a":1}\n\n',
  ': keep-alive\n\ndata: hello\ndata: world\n\n',
  'event: custom\ndata: x\n\nevent: message\ndata: y\n\n',
  'id: 42\nretry: 1500\ndata: {"id":7}\r\n\r\n',
  'data: {"text":"Hello 🌍 日本語 café 🚀"}\n\n',
  'data: first\rdata: second\r\r',
  '\uFEFFdata: bom-stripped\n\n',
  'unknown-field: z\ndata: after-unknown\n\n',
  'data:{"jsonrpc":"2.0",\ndata: "id":1}\n\n',
  ':c1\n:c2\ndata: a\n\ndata: b\n\ndata: c\n\n',
];

describe("SseParser", () => {
  it("parses comments, multiline data, id/retry, non-message events, BOM", () => {
    const p = new SseParser();
    const events = [
      ...p.push(new TextEncoder().encode('\uFEFF: hi\r\nevent: custom\r\ndata: one\r\ndata: two\r\nid: 9\rretry: 250\r\n\r\n')),
      ...p.push(new TextEncoder().encode("data: plain\n\n")),
    ];
    expect(events).toEqual([
      { event: "custom", data: "one\ntwo", id: "9", retry: 250 },
      { event: "", data: "plain" },
    ]);
  });

  it("does not dispatch an event without a terminating blank line", () => {
    const p = new SseParser();
    expect(p.push(new TextEncoder().encode("data: pending\n"))).toEqual([]);
    expect(p.end()).toEqual([]);
  });

  it("enforces max event size", () => {
    const p = new SseParser(8);
    expect(() => p.push(new TextEncoder().encode("data: 123456789\n\n"))).toThrow(SseEventTooLargeError);
  });

  it("is invariant under arbitrary chunk splits (property/fuzz, EDGE-19)", () => {
    const rand = mulberry32(0x5eed);
    for (const stream of STREAMS) {
      const bytes = new TextEncoder().encode(stream);
      const whole = parseAll([bytes]);
      // Every single split point
      for (let cut = 0; cut <= bytes.length; cut++) {
        expect(parseAll([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual(whole);
      }
      // Random multi-way splits
      for (let trial = 0; trial < 120; trial++) {
        const cuts = new Set<number>();
        const nCuts = 1 + Math.floor(rand() * 6);
        for (let i = 0; i < nCuts; i++) cuts.add(Math.floor(rand() * (bytes.length + 1)));
        const sorted = [...cuts].sort((a, b) => a - b);
        const chunks: Uint8Array[] = [];
        let prev = 0;
        for (const c of sorted) {
          chunks.push(bytes.subarray(prev, c));
          prev = c;
        }
        chunks.push(bytes.subarray(prev));
        expect(parseAll(chunks)).toEqual(whole);
      }
      // Byte-at-a-time
      const singles = Array.from(bytes, (b) => new Uint8Array([b]));
      expect(parseAll(singles)).toEqual(whole);
    }
  });
});
