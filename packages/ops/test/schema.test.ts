import { describe, expect, it } from "vitest";
import { createBuiltinValidator, DEFAULT_SCHEMA_BOUNDS, DIALECT_2020_12, type SchemaValidator } from "../src/index.js";
import { installNetworkSpy } from "./helpers.js";

installNetworkSpy();

const v = createBuiltinValidator();

function check(schema: unknown, good: unknown[], bad: unknown[], validator: SchemaValidator = v): void {
  const c = validator.compile(schema);
  if (!c.ok) throw new Error(`did not compile: ${c.message}`);
  for (const g of good) expect(c.validate(g).valid, `expected valid: ${JSON.stringify(g)}`).toBe(true);
  for (const b of bad) {
    const r = c.validate(b);
    expect(r.valid, `expected invalid: ${JSON.stringify(b)}`).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  }
}

describe("built-in 2020-12 validator (OPS-SCHEMA-1)", () => {
  it("absent $schema and explicit 2020-12 both compile", () => {
    expect(v.compile({ type: "object" }).ok).toBe(true);
    expect(v.compile({ $schema: DIALECT_2020_12 }).ok).toBe(true);
    expect(v.compile({ $schema: `${DIALECT_2020_12}#` }).ok).toBe(true);
    expect(v.compile(true).ok).toBe(true);
  });

  it("type, enum, const", () => {
    check({ type: ["string", "null"] }, ["a", null], [1, {}]);
    check({ type: "integer" }, [1, -3, 2.0], [1.5, "1"]);
    check({ type: "number" }, [1, 1.5], ["1", null]);
    check({ enum: [1, "a", { x: [1] }] }, [1, "a", { x: [1] }], [2, { x: [2] }]);
    check({ const: { a: [1, 2] } }, [{ a: [1, 2] }], [{ a: [2, 1] }]);
    check(false, [], [1]);
  });

  it("numeric and string keywords", () => {
    check({ minimum: 1, maximum: 3 }, [1, 3, "x"], [0, 4]);
    check({ exclusiveMinimum: 1, exclusiveMaximum: 3 }, [2], [1, 3]);
    check({ multipleOf: 0.1 }, [0.3, 1.2], [0.35]);
    check({ minLength: 2, maxLength: 3 }, ["ab", "😀😀"], ["a", "abcd"]);
    check({ pattern: "^\\p{Lu}" }, ["É"], ["é"]);
  });

  it("array keywords: prefixItems, items, contains, uniqueItems, unevaluatedItems", () => {
    check({ prefixItems: [{ type: "string" }], items: { type: "integer" } }, [["a"], ["a", 1, 2], []], [["a", "b"], [1]]);
    check({ minItems: 1, maxItems: 2 }, [[1], [1, 2]], [[], [1, 2, 3]]);
    check({ uniqueItems: true }, [[1, { a: 1 }, { a: 2 }]], [[{ a: 1 }, { a: 1 }]]);
    check({ contains: { const: 1 }, minContains: 2, maxContains: 3 }, [[1, 1], [1, 1, 1, 2]], [[1], [1, 1, 1, 1]]);
    check({ prefixItems: [true], unevaluatedItems: false }, [[1]], [[1, 2]]);
  });

  it("object keywords", () => {
    check(
      {
        type: "object",
        properties: { a: { type: "string" } },
        patternProperties: { "^x-": { type: "integer" } },
        additionalProperties: false,
        required: ["a"],
      },
      [{ a: "s" }, { a: "s", "x-n": 1 }],
      [{}, { a: 1 }, { a: "s", b: 1 }, { a: "s", "x-n": "1" }],
    );
    check({ minProperties: 1, maxProperties: 1 }, [{ a: 1 }], [{}, { a: 1, b: 2 }]);
    check({ propertyNames: { maxLength: 2 } }, [{ ab: 1 }], [{ abc: 1 }]);
    check({ dependentRequired: { a: ["b"] } }, [{ a: 1, b: 2 }, { b: 1 }], [{ a: 1 }]);
    check({ dependentSchemas: { a: { required: ["b"] } } }, [{ a: 1, b: 1 }], [{ a: 1 }]);
    check(
      { allOf: [{ properties: { a: true } }], unevaluatedProperties: false },
      [{ a: 1 }],
      [{ a: 1, b: 2 }],
    );
  });

  it("composition and conditionals", () => {
    check({ anyOf: [{ type: "string" }, { type: "integer" }] }, ["a", 1], [1.5]);
    check({ oneOf: [{ type: "integer" }, { type: "number" }] }, [1.5], [1]);
    check({ allOf: [{ minimum: 1 }, { maximum: 2 }] }, [1, 2], [3]);
    check({ not: { type: "string" } }, [1], ["a"]);
    check(
      { if: { properties: { k: { const: "n" } } }, then: { required: ["n"] }, else: { required: ["s"] } },
      [{ k: "n", n: 1 }, { k: "s", s: 1 }],
      [{ k: "n" }, { k: "s" }],
    );
  });

  it("same-document $ref: pointers, $defs, anchors, embedded $id, recursion", () => {
    check(
      {
        $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" }, v: { type: "integer" } } } },
        $ref: "#/$defs/node",
      },
      [{ v: 1, next: { v: 2, next: {} } }],
      [{ next: { v: "x" } }],
    );
    check({ $defs: { s: { $anchor: "str", type: "string" } }, items: { $ref: "#str" } }, [["a"]], [[1]]);
    check({ $defs: { "a/b": { type: "null" } }, $ref: "#/$defs/a~1b" }, [null], [0]);
    check({ $defs: { e: { $id: "urn:example:e", type: "boolean" } }, $ref: "urn:example:e" }, [true], [1]);
    check({ type: "object", properties: { child: { $ref: "#" } } }, [{ child: { child: {} } }], [{ child: [] }]);
  });

  it("unknown annotations, x-* keywords and formats are accepted (Ajv strict:false)", () => {
    check({ type: "string", "x-mcp-header": "X-Foo", "x-vendor": { a: 1 }, format: "email", title: "t" }, ["not-an-email"], [1]);
    check({ format: "made-up-format" }, ["x"], []);
  });

  it("required checks own properties only", () => {
    check({ required: ["toString", "constructor"] }, [{ toString: 1, constructor: 2 }], [{}]);
  });

  it("$dynamicRef / $dynamicAnchor and unevaluatedProperties through $ref", () => {
    check(
      {
        $dynamicAnchor: "node",
        type: "object",
        properties: { kids: { type: "array", items: { $dynamicRef: "#node" } } },
      },
      [{ kids: [{ kids: [] }] }],
      [{ kids: [1] }],
    );
    check(
      { $defs: { base: { properties: { a: true } } }, $ref: "#/$defs/base", unevaluatedProperties: false },
      [{ a: 1 }],
      [{ a: 1, b: 2 }],
    );
  });

  it("maps false-schema and type issues to the stable shape", () => {
    const c = v.compile({ properties: { a: false, b: { type: ["string", "null"] } } });
    if (!c.ok) throw new Error("compile");
    expect(c.validate({ a: 1, b: 1.5 }).errors).toEqual([
      { path: "/a", keyword: "false", message: "schema is false" },
      { path: "/b", keyword: "type", message: "expected string|null, got number" },
    ]);
    expect(c.validate({ b: null })).toEqual({ valid: true, errors: [] });
  });

  it("reports issue paths and keywords", () => {
    const c = v.compile({ properties: { a: { items: { type: "string" } } } });
    if (!c.ok) throw new Error("compile");
    expect(c.validate({ a: ["x", 2] }).errors).toEqual([{ path: "/a/1", keyword: "type", message: "expected string, got integer" }]);
  });
});

describe("schema rejection", () => {
  it("unsupported dialects fail with the dialect named (OPS-SCHEMA-2)", () => {
    for (const d of ["http://json-schema.org/draft-07/schema#", "https://json-schema.org/draft/2019-09/schema", 7]) {
      const c = v.compile({ $schema: d });
      expect(c).toMatchObject({ ok: false, reason: "unsupported-dialect", dialect: String(d) });
      if (!c.ok) expect(c.message).toContain(String(d));
    }
  });

  it("invalid schemas do not compile (OPS-SCHEMA-3)", () => {
    for (const s of [
      null,
      [],
      "x",
      { type: "bogus" },
      { type: [] },
      { required: "a" },
      { minLength: -1 },
      { maximum: "1" },
      { multipleOf: 0 },
      { enum: 1 },
      { anyOf: [] },
      { properties: [] },
      { pattern: "(" },
      { patternProperties: { "[": {} } },
      { items: 1 },
      { dependentRequired: { a: [1] } },
    ]) {
      expect(v.compile(s), JSON.stringify(s)).toMatchObject({ ok: false, reason: "invalid-schema" });
    }
  });

  it("external and network $ref are rejected, never fetched (OPS-SCHEMA-4)", () => {
    for (const ref of [
      "https://evil.example/schema.json",
      "http://127.0.0.1/s",
      "file:///etc/passwd",
      "other.json#/a",
      "#/$defs/missing",
      "#nope",
    ]) {
      const c = v.compile({ properties: { a: { $ref: ref } } });
      expect(c, ref).toMatchObject({ ok: false, reason: "invalid-schema" });
    }
    expect(v.compile({ $dynamicRef: "https://x.example/s" })).toMatchObject({ ok: false });
  });

  it("enforces depth 64, 10000 subschemas and 1 MiB by default (OPS-SCHEMA-6)", () => {
    expect(DEFAULT_SCHEMA_BOUNDS).toEqual({ maxDepth: 64, maxSubschemas: 10_000, maxBytes: 1024 * 1024 });
    const nest = (n: number): unknown => (n === 0 ? { type: "string" } : { not: { not: nest(n - 1) } });
    expect(v.compile(nest(31)).ok).toBe(true); // depth 63
    expect(v.compile(nest(32))).toMatchObject({ ok: false, reason: "invalid-schema", message: expect.stringContaining("depth") });

    const wide = { properties: Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`p${i}`, {}])) };
    expect(v.compile(wide)).toMatchObject({ ok: false, message: expect.stringContaining("subschemas") });

    const big = { description: "x".repeat(1024 * 1024) };
    expect(v.compile(big)).toMatchObject({ ok: false, message: expect.stringContaining("bytes") });

    const tight = createBuiltinValidator({ bounds: { maxDepth: 3 } });
    expect(tight.compile({ properties: { a: { type: "string" } } }).ok).toBe(true);
    expect(tight.compile({ properties: { a: { items: {} } } }).ok).toBe(false);
  });

  it("$ref cycles without progress terminate (pure-ref cycles at compile, others at validation)", () => {
    const pure = v.compile({ $defs: { a: { $ref: "#/$defs/b" }, b: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" });
    expect(pure).toMatchObject({ ok: false, reason: "invalid-schema", message: expect.stringContaining("depth") });

    const c = v.compile({ $defs: { a: { $ref: "#/$defs/b", type: "integer" }, b: { $ref: "#/$defs/a" } }, $ref: "#/$defs/a" });
    if (!c.ok) throw new Error(c.message);
    const r = c.validate(1);
    expect(r.valid).toBe(false);
    expect(r.errors[0]!.message).toContain("depth");
  });

  it("deeply nested instances against a recursive schema terminate", () => {
    const c = v.compile({ items: { $ref: "#" } });
    if (!c.ok) throw new Error(c.message);
    let deep: unknown = [];
    for (let i = 0; i < 200_000; i++) deep = [deep];
    const r = c.validate(deep);
    expect(r.valid).toBe(false);
    expect(r.errors[0]).toMatchObject({ keyword: "$ref", message: expect.stringContaining("depth") });
  });

  it("$id collisions cannot shadow the meta-schema or other tools' schemas (Ajv regression)", () => {
    // A hostile root $id equal to the meta-schema URI must not disable meta validation later.
    expect(v.compile({ $id: DIALECT_2020_12, type: "string" }).ok).toBe(true);
    expect(v.compile({ type: "bogus" })).toMatchObject({ ok: false, reason: "invalid-schema" });
    // Two tools with the same root $id compile independently.
    check({ $id: "urn:example:same", type: "string" }, ["a"], [1]);
    check({ $id: "urn:example:same", type: "integer" }, [1], ["a"]);
    check({ $defs: { e: { $id: "urn:example:e", type: "null" } }, $ref: "urn:example:e" }, [null], [true]);
  });

  it("external $ref is never fetched, even once compiled elsewhere (Ajv regression)", () => {
    const c = v.compile({ $ref: "https://json-schema.org/draft/2020-12/schema" });
    expect(c).toMatchObject({ ok: false, reason: "invalid-schema", message: expect.stringContaining("never resolved") });
  });

  it("the SchemaValidator seam accepts another implementation", () => {
    const seen: unknown[] = [];
    const custom: SchemaValidator = {
      compile(s) {
        seen.push(s);
        return { ok: true, validate: (x) => ({ valid: x === 42, errors: x === 42 ? [] : [{ path: "/", keyword: "x", message: "not 42" }] }) };
      },
    };
    check({ anything: true }, [42], [41], custom);
    expect(seen).toEqual([{ anything: true }]);
  });
});
