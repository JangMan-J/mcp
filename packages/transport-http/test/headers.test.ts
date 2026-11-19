import { describe, expect, it } from "vitest";
import {
  encodeHeaderValue,
  extractAtPath,
  getHeaderCaseInsensitive,
  isPlainHeaderSafe,
  validateXmcpHeaderSchema,
} from "../src/index.js";

describe("header value encoding (HTTP-ENC-1/2/3)", () => {
  const vectors: Array<[string, string]> = [
    ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
    [" padded ", "=?base64?IHBhZGRlZCA=?="],
    ["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
    ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="],
    ["plain-ascii", "plain-ascii"],
    ["with space inside", "with space inside"],
    ["a\tb", "a\tb"],
    ["工具", "=?base64?5bel5YW3?="],
    ["trailing ", "=?base64?dHJhaWxpbmcg?="] ,
    ["evil\r\nInjected: 1", "=?base64?ZXZpbA0KSW5qZWN0ZWQ6IDE=?="],
  ];
  for (const [input, expected] of vectors) {
    it(`encodes ${JSON.stringify(input)}`, () => {
      const out = encodeHeaderValue(input);
      expect(out).toBe(expected);
      expect(out).not.toContain("\r");
      expect(out).not.toContain("\n");
    });
  }

  it("encodes integers and booleans as decimal / true|false", () => {
    expect(encodeHeaderValue(42)).toBe("42");
    expect(encodeHeaderValue(-7)).toBe("-7");
    expect(encodeHeaderValue(true)).toBe("true");
    expect(encodeHeaderValue(false)).toBe("false");
  });

  it("isPlainHeaderSafe matches the spec rule", () => {
    expect(isPlainHeaderSafe("abc XYZ\t09")).toBe(true);
    expect(isPlainHeaderSafe(" abc")).toBe(false);
    expect(isPlainHeaderSafe("abc ")).toBe(false);
    expect(isPlainHeaderSafe("a\nb")).toBe(false);
    expect(isPlainHeaderSafe("=?base64?x?=")).toBe(false);
    expect(isPlainHeaderSafe("café")).toBe(false);
  });

  it("looks up header names case-insensitively, values case-sensitively (HTTP-CASE-1)", () => {
    const rec = { "McP-MeThOd": "Tools/Call" };
    expect(getHeaderCaseInsensitive(rec, "mcp-method")).toBe("Tools/Call");
    expect(getHeaderCaseInsensitive(rec, "MCP-METHOD")).toBe("Tools/Call");
    expect(getHeaderCaseInsensitive(rec, "absent")).toBeUndefined();
    const h = new Headers({ "X-Test": "MiXeD" });
    expect(getHeaderCaseInsensitive(h, "x-test")).toBe("MiXeD");
  });
});

describe("x-mcp-header validation (HTTP-PARAM-1/2)", () => {
  const schemaWith = (propSchema: Record<string, unknown>) => ({
    type: "object",
    properties: { tenant: propSchema },
  });

  it("accepts string/integer/boolean annotations", () => {
    for (const type of ["string", "integer", "boolean"]) {
      const v = validateXmcpHeaderSchema(schemaWith({ type, "x-mcp-header": "Tenant" }));
      expect(v.valid).toBe(true);
      expect(v.params).toEqual([{ path: ["tenant"], headerName: "Tenant", type }]);
    }
  });

  const invalid: Array<[string, Record<string, unknown>]> = [
    ["empty name", { type: "string", "x-mcp-header": "" }],
    ["non-string name", { type: "string", "x-mcp-header": 3 }],
    ["bad token chars", { type: "string", "x-mcp-header": "bad name" }],
    ["control chars", { type: "string", "x-mcp-header": "bad\u0001name" }],
    ["number type", { type: "number", "x-mcp-header": "Tenant" }],
    ["missing type", { "x-mcp-header": "Tenant" }],
    ["array type", { type: "object", "x-mcp-header": "Tenant" }],
  ];
  for (const [label, prop] of invalid) {
    it(`rejects ${label}`, () => {
      expect(validateXmcpHeaderSchema(schemaWith(prop)).valid).toBe(false);
    });
  }

  it("rejects case-insensitive duplicates, $ref chains, and non-properties reachability", () => {
    const dup = {
      type: "object",
      properties: {
        a: { type: "string", "x-mcp-header": "Tenant" },
        b: { type: "string", "x-mcp-header": "TENANT" },
      },
    };
    expect(validateXmcpHeaderSchema(dup).valid).toBe(false);

    const viaRef = {
      type: "object",
      properties: { a: { $ref: "#/$defs/x", "x-mcp-header": "Tenant", type: "string" } },
      $defs: { x: { type: "string", "x-mcp-header": "Other" } },
    };
    expect(validateXmcpHeaderSchema(viaRef).valid).toBe(false);

    const viaItems = {
      type: "object",
      properties: { a: { type: "array", items: { type: "string", "x-mcp-header": "Tenant" } } },
    };
    expect(validateXmcpHeaderSchema(viaItems).valid).toBe(false);

    const viaOneOf = {
      type: "object",
      properties: { a: { oneOf: [{ type: "string", "x-mcp-header": "Tenant" }] } },
    };
    expect(validateXmcpHeaderSchema(viaOneOf).valid).toBe(false);
  });

  it("accepts nested properties chains and extracts at the exact path", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: { inner: { type: "integer", "x-mcp-header": "Count" } },
        },
      },
    };
    const v = validateXmcpHeaderSchema(schema);
    expect(v.valid).toBe(true);
    expect(v.params[0]?.path).toEqual(["outer", "inner"]);
    expect(extractAtPath({ outer: { inner: 5 } }, ["outer", "inner"])).toBe(5);
    expect(extractAtPath({ outer: {} }, ["outer", "inner"])).toBeUndefined();
    expect(extractAtPath({}, ["outer", "inner"])).toBeUndefined();
  });
});
