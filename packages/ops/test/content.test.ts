import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkIconBytes,
  detectImageKind,
  expandUriTemplate,
  isBase64,
  isMimeType,
  isRfc3986Uri,
  normalizeContent,
  normalizeContentBlock,
  validateIcon,
} from "../src/index.js";
import { installNetworkSpy } from "./helpers.js";

installNetworkSpy();

describe("content normalization (OPS-TOOLS-13, OPS-TOOLS-14)", () => {
  it("keeps every known type with annotations and flags problems per block", () => {
    const blocks = [
      { type: "text", text: "t", annotations: { audience: ["assistant"], priority: 0.5 } },
      { type: "text", text: 1 },
      { type: "image", data: "", mimeType: "image/png" },
      { type: "audio", data: "AAA", mimeType: "audio/wav" },
      { type: "resource_link", uri: "https://x.example/a", name: "a" },
      { type: "resource_link", uri: "::" },
      { type: "resource", resource: { uri: "file:///a", text: "x", blob: "AAAA" } },
      { type: "future", x: 1 },
      "junk",
      { type: "text", text: "t", annotations: { priority: 9 } },
    ];
    const out = normalizeContent(blocks);
    expect(out.map((b) => [b.type, b.issues])).toEqual([
      ["text", []],
      ["text", ["invalid-text"]],
      ["image", []],
      ["audio", ["invalid-base64"]],
      ["resource_link", []],
      ["resource_link", ["invalid-uri"]],
      ["resource", ["invalid-embedded-resource"]],
      ["unknown", ["unknown-type"]],
      ["unknown", ["unknown-type", "not-a-typed-object"]],
      ["text", ["annotation-priority-out-of-range"]],
    ]);
    out.forEach((b, i) => expect(b.raw).toBe(blocks[i]));
    expect(out[7]!.rawType).toBe("future");
    expect(normalizeContent(undefined)).toEqual([]);
    expect(normalizeContentBlock({ type: "image", data: "AAAA", mimeType: "image/png; charset=x" }).issues).toEqual([]);
  });

  it("base64, MIME and RFC 3986 checks", () => {
    for (const s of ["", "AAAA", "iVBORw0KGgo=", "AA==", "+/+/"]) expect(isBase64(s), s).toBe(true);
    for (const s of ["A", "AAA", "A===", "!!!!", "AA=A", " AAAA", 1]) expect(isBase64(s), String(s)).toBe(false);
    for (const s of ["image/png", "application/vnd.a+json", "text/plain; charset=utf-8", 'text/plain;a="b c"']) expect(isMimeType(s), s).toBe(true);
    for (const s of ["png", "image/", "/png", "image/png;", "nope", ""]) expect(isMimeType(s), s).toBe(false);
    for (const s of ["file:///a", "urn:x:y", "git+ssh://h/p", "x:%20"]) expect(isRfc3986Uri(s), s).toBe(true);
    for (const s of ["no scheme", "a b:c", ":x", "x:%zz", "x:<>", "1a:b"]) expect(isRfc3986Uri(s), s).toBe(false);
  });
});

describe("RFC 6570 expansion (OPS-RES-2)", () => {
  // Examples from RFC 6570 section 3.2.
  const vars = {
    count: ["one", "two", "three"],
    dom: ["example", "com"],
    dub: "me/too",
    hello: "Hello World!",
    half: "50%",
    var: "value",
    who: "fred",
    base: "http://example.com/home/",
    path: "/foo/bar",
    list: ["red", "green", "blue"],
    keys: { semi: ";", dot: ".", comma: "," },
    v: "6",
    x: "1024",
    y: "768",
    empty: "",
    empty_keys: {},
    undef: null,
  };
  const cases: [string, string][] = [
    ["{var}", "value"],
    ["{hello}", "Hello%20World%21"],
    ["{half}", "50%25"],
    ["O{empty}X", "OX"],
    ["O{undef}X", "OX"],
    ["{x,y}", "1024,768"],
    ["{x,hello,y}", "1024,Hello%20World%21,768"],
    ["?{x,empty}", "?1024,"],
    ["?{x,undef}", "?1024"],
    ["{var:3}", "val"],
    ["{list}", "red,green,blue"],
    ["{list*}", "red,green,blue"],
    ["{keys}", "semi,%3B,dot,.,comma,%2C"],
    ["{keys*}", "semi=%3B,dot=.,comma=%2C"],
    ["{+var}", "value"],
    ["{+hello}", "Hello%20World!"],
    ["{+half}", "50%25"],
    ["{base}index", "http%3A%2F%2Fexample.com%2Fhome%2Findex"],
    ["{+base}index", "http://example.com/home/index"],
    ["{+path}/here", "/foo/bar/here"],
    ["{+path:6}/here", "/foo/b/here"],
    ["{+list*}", "red,green,blue"],
    ["{+keys*}", "semi=;,dot=.,comma=,"],
    ["{#var}", "#value"],
    ["{#hello}", "#Hello%20World!"],
    ["{#path:6}/here", "#/foo/b/here"],
    ["X{.var}", "X.value"],
    ["X{.x,y}", "X.1024.768"],
    ["X{.list*}", "X.red.green.blue"],
    ["www{.dom*}", "www.example.com"],
    ["{/var}", "/value"],
    ["{/var,x}/here", "/value/1024/here"],
    ["{/list*,path:4}", "/red/green/blue/%2Ffoo"],
    ["{/keys*}", "/semi=%3B/dot=./comma=%2C"],
    ["{;x,y}", ";x=1024;y=768"],
    ["{;x,y,empty}", ";x=1024;y=768;empty"],
    ["{;list*}", ";list=red;list=green;list=blue"],
    ["{;keys*}", ";semi=%3B;dot=.;comma=%2C"],
    ["{?x,y}", "?x=1024&y=768"],
    ["{?x,y,empty}", "?x=1024&y=768&empty="],
    ["{?list}", "?list=red,green,blue"],
    ["{?list*}", "?list=red&list=green&list=blue"],
    ["{?keys*}", "?semi=%3B&dot=.&comma=%2C"],
    ["{?empty_keys}", ""],
    ["?fixed=yes{&x}", "?fixed=yes&x=1024"],
    ["{&var:3}", "&var=val"],
  ];
  it.each(cases)("%s", (t, want) => {
    expect(expandUriTemplate(t, vars)).toBe(want);
  });

  it("rejects malformed templates", () => {
    for (const t of ["{", "}", "{a", "a}{b}", "{=x}", "{a b}", "{a:0}"]) {
      expect(() => expandUriTemplate(t, {}), t).toThrow(TypeError);
    }
  });
});

describe("icons (SEC-ICON helpers)", () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  it("detects by magic bytes and enforces policy", () => {
    expect(detectImageKind(png)).toBe("png");
    expect(detectImageKind(new TextEncoder().encode("<svg xmlns='x'></svg>"))).toBe("svg");
    expect(checkIconBytes(png, "image/png")).toEqual({ ok: true, kind: "png" });
    expect(checkIconBytes(png, "image/jpeg")).toEqual({ ok: false, reason: "mime-mismatch" });
    expect(checkIconBytes(new TextEncoder().encode("<svg></svg>"), undefined)).toEqual({ ok: false, reason: "type-not-allowed:svg" });
    expect(checkIconBytes(png, undefined, { maxBytes: 4 })).toEqual({ ok: false, reason: "too-large" });
  });
  it("checks icon URIs without fetching", () => {
    const b64 = btoa(String.fromCharCode(...png));
    expect(validateIcon({ src: "https://srv.example/i.png" }, "https://srv.example/mcp")).toEqual({ ok: true });
    expect(validateIcon({ src: "https://cdn.example/i.png" }, "https://srv.example/mcp")).toEqual({ ok: false, reason: "cross-origin" });
    expect(validateIcon({ src: `data:image/png;base64,${b64}` }, "https://srv.example")).toEqual({ ok: true, kind: "png" });
    expect(validateIcon({ src: "javascript:alert(1)" }, "https://srv.example")).toEqual({ ok: false, reason: "unsafe-scheme:javascript:" });
  });
});

describe("ops package boundary", () => {
  const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");
  const files = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
  it("imports only @mcp-client/core and its own modules; no network APIs", () => {
    for (const f of files) {
      const txt = readFileSync(join(SRC, f), "utf8");
      for (const m of txt.matchAll(/\bfrom\s+"([^"]+)"/g)) {
        const spec = m[1]!;
        expect(
          spec === "@mcp-client/core" || spec === "ajv/dist/2020.js" || spec.startsWith("./"),
          `${f} imports ${spec}`,
        ).toBe(true);
      }
      expect(txt, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(net|http|https|tls|dns|dgram)|import\s*\(/);
    }
  });
  it("package.json runtime deps are only @mcp-client/core and ajv", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "../package.json"), "utf8")) as Record<string, Record<string, string>>;
    expect(Object.keys(pkg["dependencies"] ?? {})).toEqual(["@mcp-client/core", "ajv"]);
    expect(pkg["scripts"]?.["build"]).toBe("tsc -b");
  });
});
