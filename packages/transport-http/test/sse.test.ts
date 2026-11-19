import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SseParser, SseEventTooLargeError } from "../src/index.js";

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
    for (const stream of STREAMS) {
      const bytes = new TextEncoder().encode(stream);
      const whole = parseAll([bytes]);
      // Every single split point
      for (let cut = 0; cut <= bytes.length; cut++) {
        expect(parseAll([bytes.subarray(0, cut), bytes.subarray(cut)])).toEqual(whole);
      }
      // Byte offsets (not string indices) can land inside UTF-8 sequences.
      const cuts = fc.array(fc.integer({ min: 0, max: bytes.length }), { maxLength: bytes.length });
      fc.assert(fc.property(cuts, (offsets) => {
        const chunks: Uint8Array[] = [];
        let start = 0;
        for (const end of [...offsets].sort((a, b) => a - b)) {
          chunks.push(bytes.subarray(start, end));
          start = end;
        }
        chunks.push(bytes.subarray(start));
        expect(parseAll(chunks)).toEqual(whole);
      }), { seed: 0x5eed, numRuns: 120 });
      // Byte-at-a-time
      const singles = Array.from(bytes, (b) => new Uint8Array([b]));
      expect(parseAll(singles)).toEqual(whole);
    }
  });
});
