/**
 * SchemaValidator port and the built-in JSON Schema 2020-12 validator
 * (OPS-SCHEMA-1..7). Zero dependencies, no network, same-document $ref only.
 */

export const DIALECT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export interface SchemaIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SchemaIssue[];
}

export type CompileResult =
  | { readonly ok: true; readonly validate: (value: unknown) => ValidationResult }
  | {
      readonly ok: false;
      readonly reason: "unsupported-dialect" | "invalid-schema";
      readonly message: string;
      readonly dialect?: string;
    };

/** Dialect-agnostic port; another validator may replace the built-in one. */
export interface SchemaValidator {
  compile(schema: unknown): CompileResult;
}

export interface SchemaBounds {
  readonly maxDepth: number;
  readonly maxSubschemas: number;
  readonly maxBytes: number;
}

export const DEFAULT_SCHEMA_BOUNDS: SchemaBounds = {
  maxDepth: 64,
  maxSubschemas: 10_000,
  maxBytes: 1024 * 1024,
};

const MAX_VALIDATION_DEPTH = 256;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const SINGLE = [
  "additionalProperties",
  "items",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
] as const;
const ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

function forEachSub(s: Obj, cb: (sub: unknown, where: string) => void): void {
  for (const k of SINGLE) if (k in s) cb(s[k], k);
  for (const k of ARRAYS) {
    const v = s[k];
    if (Array.isArray(v)) v.forEach((x, i) => cb(x, `${k}/${i}`));
  }
  for (const k of MAPS) {
    const v = s[k];
    if (isObj(v)) for (const [n, x] of Object.entries(v)) cb(x, `${k}/${n}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === "number" && actual === "integer");
}

function unescapePointer(seg: string): string {
  let s = seg;
  try {
    s = decodeURIComponent(seg);
  } catch {
    /* keep raw */
  }
  return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

interface Resources {
  readonly root: unknown;
  readonly ids: Map<string, unknown>;
  readonly anchors: Map<string, unknown>;
}

function resolveRef(ref: string, res: Resources): { found: true; schema: unknown } | { found: false } {
  const hash = ref.indexOf("#");
  const base = hash < 0 ? ref : ref.slice(0, hash);
  const frag = hash < 0 ? "" : ref.slice(hash + 1);
  let node: unknown;
  if (base === "") node = res.root;
  else if (res.ids.has(base)) node = res.ids.get(base);
  else return { found: false };
  if (frag === "") return { found: true, schema: node };
  if (!frag.startsWith("/")) {
    const a = res.anchors.get(frag);
    return a === undefined ? { found: false } : { found: true, schema: a };
  }
  for (const seg of frag.slice(1).split("/")) {
    const key = unescapePointer(seg);
    if (Array.isArray(node)) {
      const i = Number(key);
      if (!Number.isInteger(i) || i < 0 || i >= node.length) return { found: false };
      node = node[i];
    } else if (isObj(node) && Object.hasOwn(node, key)) {
      node = node[key];
    } else {
      return { found: false };
    }
  }
  return { found: true, schema: node };
}

class SchemaError extends Error {
  constructor(
    readonly reason: "unsupported-dialect" | "invalid-schema",
    message: string,
    readonly dialect?: string,
  ) {
    super(message);
  }
}

function bound(schema: unknown, b: SchemaBounds): void {
  const bytes = new TextEncoder().encode(JSON.stringify(schema) ?? "").length;
  if (bytes > b.maxBytes) throw new SchemaError("invalid-schema", `schema exceeds ${b.maxBytes} bytes`);
  let count = 0;
  const walk = (v: unknown, depth: number): void => {
    if (depth > b.maxDepth) throw new SchemaError("invalid-schema", `schema depth exceeds ${b.maxDepth}`);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
    } else if (isObj(v)) {
      count += 1;
      if (count > b.maxSubschemas) throw new SchemaError("invalid-schema", `schema exceeds ${b.maxSubschemas} subschemas`);
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(schema, 1);
}

function nonNegInt(v: unknown): boolean {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Structural check: keyword shapes, regexes, and same-document $ref resolution. */
function checkSchema(schema: unknown, res: Resources, regexes: Map<string, RegExp>, path: string): void {
  if (typeof schema === "boolean") return;
  if (!isObj(schema)) throw new SchemaError("invalid-schema", `${path || "#"}: schema must be an object or boolean`);
  const bad = (m: string): never => {
    throw new SchemaError("invalid-schema", `${path || "#"}: ${m}`);
  };
  const t = schema["type"];
  if (t !== undefined) {
    const list = Array.isArray(t) ? t : [t];
    if (list.length === 0 || !list.every((x) => typeof x === "string" && TYPES.has(x))) bad("invalid 'type'");
  }
  if ("enum" in schema && !Array.isArray(schema["enum"])) bad("'enum' must be an array");
  if ("required" in schema) {
    const r = schema["required"];
    if (!Array.isArray(r) || !r.every((x) => typeof x === "string")) bad("'required' must be an array of strings");
  }
  for (const k of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains"]) {
    if (k in schema && !nonNegInt(schema[k])) bad(`'${k}' must be a non-negative integer`);
  }
  for (const k of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"]) {
    if (k in schema && typeof schema[k] !== "number") bad(`'${k}' must be a number`);
  }
  if ("multipleOf" in schema) {
    const m = schema["multipleOf"];
    if (typeof m !== "number" || !(m > 0)) bad("'multipleOf' must be > 0");
  }
  if ("uniqueItems" in schema && typeof schema["uniqueItems"] !== "boolean") bad("'uniqueItems' must be boolean");
  if ("dependentRequired" in schema) {
    const d = schema["dependentRequired"];
    if (!isObj(d) || !Object.values(d).every((x) => Array.isArray(x) && x.every((y) => typeof y === "string"))) {
      bad("invalid 'dependentRequired'");
    }
  }
  for (const k of ARRAYS) {
    if (k in schema && !(Array.isArray(schema[k]) && (k === "prefixItems" || (schema[k] as unknown[]).length > 0))) {
      bad(`'${k}' must be a${k === "prefixItems" ? "n" : " non-empty"} array`);
    }
  }
  for (const k of MAPS) if (k in schema && !isObj(schema[k])) bad(`'${k}' must be an object`);
  const compile = (p: unknown): void => {
    if (typeof p !== "string") return bad("pattern must be a string");
    if (!regexes.has(p)) {
      try {
        regexes.set(p, new RegExp(p, "u"));
      } catch {
        bad(`invalid regular expression '${p}'`);
      }
    }
  };
  if ("pattern" in schema) compile(schema["pattern"]);
  if (isObj(schema["patternProperties"])) for (const p of Object.keys(schema["patternProperties"])) compile(p);
  for (const k of ["$ref", "$dynamicRef"]) {
    if (!(k in schema)) continue;
    const ref = schema[k];
    if (typeof ref !== "string") bad(`'${k}' must be a string`);
    const r = resolveRef(ref as string, res);
    if (!r.found) bad(`unresolved or external ${k} '${String(ref)}' (network and external references are never resolved)`);
  }
  forEachSub(schema, (sub, where) => checkSchema(sub, res, regexes, `${path}/${where}`));
}

function collectResources(root: unknown): Resources {
  const ids = new Map<string, unknown>();
  const anchors = new Map<string, unknown>();
  const walk = (s: unknown, isRoot: boolean): void => {
    if (!isObj(s)) return;
    const id = s["$id"];
    if (typeof id === "string" && !isRoot) ids.set(id, s);
    for (const k of ["$anchor", "$dynamicAnchor"]) {
      const a = s[k];
      if (typeof a === "string") anchors.set(a, s);
    }
    forEachSub(s, (sub) => walk(sub, false));
  };
  walk(root, true);
  return { root, ids, anchors };
}

interface Res {
  errors: SchemaIssue[];
  props: Set<string>;
  items: Set<number>;
}

function runSchema(
  schema: unknown,
  inst: unknown,
  path: string,
  depth: number,
  res: Resources,
  regexes: Map<string, RegExp>,
): Res {
  const out: Res = { errors: [], props: new Set(), items: new Set() };
  const fail = (keyword: string, message: string): void => {
    out.errors.push({ path: path || "/", keyword, message });
  };
  if (schema === true) return out;
  if (schema === false) {
    fail("false", "schema is false");
    return out;
  }
  if (!isObj(schema)) return out;
  if (depth > MAX_VALIDATION_DEPTH) {
    fail("$ref", "validation depth limit exceeded");
    return out;
  }
  const sub = (s: unknown, i: unknown, p: string): Res => runSchema(s, i, p, depth + 1, res, regexes);
  const merge = (r: Res): void => {
    out.errors.push(...r.errors);
    for (const p of r.props) out.props.add(p);
    for (const i of r.items) out.items.add(i);
  };
  const mergeAnnotations = (r: Res): void => {
    for (const p of r.props) out.props.add(p);
    for (const i of r.items) out.items.add(i);
  };

  for (const k of ["$ref", "$dynamicRef"]) {
    const ref = schema[k];
    if (typeof ref === "string") {
      const r = resolveRef(ref, res);
      if (r.found) merge(sub(r.schema, inst, path));
      else fail(k, `unresolved reference ${ref}`);
    }
  }

  const t = schema["type"];
  if (t !== undefined) {
    const list = Array.isArray(t) ? (t as string[]) : [t as string];
    if (!list.some((x) => typeMatches(inst, x))) fail("type", `expected ${list.join("|")}, got ${typeOf(inst)}`);
  }
  if (Array.isArray(schema["enum"]) && !schema["enum"].some((e) => deepEqual(e, inst))) fail("enum", "value not in enum");
  if ("const" in schema && !deepEqual(schema["const"], inst)) fail("const", "value does not equal const");

  if (typeof inst === "number") {
    const num = (k: string): number | undefined => (typeof schema[k] === "number" ? (schema[k] as number) : undefined);
    const min = num("minimum");
    const max = num("maximum");
    const emin = num("exclusiveMinimum");
    const emax = num("exclusiveMaximum");
    const mul = num("multipleOf");
    if (min !== undefined && inst < min) fail("minimum", `must be >= ${min}`);
    if (max !== undefined && inst > max) fail("maximum", `must be <= ${max}`);
    if (emin !== undefined && inst <= emin) fail("exclusiveMinimum", `must be > ${emin}`);
    if (emax !== undefined && inst >= emax) fail("exclusiveMaximum", `must be < ${emax}`);
    if (mul !== undefined) {
      const q = inst / mul;
      if (Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q))) fail("multipleOf", `must be a multiple of ${mul}`);
    }
  }

  if (typeof inst === "string") {
    const len = [...inst].length;
    if (typeof schema["minLength"] === "number" && len < schema["minLength"]) fail("minLength", `shorter than ${schema["minLength"]}`);
    if (typeof schema["maxLength"] === "number" && len > schema["maxLength"]) fail("maxLength", `longer than ${schema["maxLength"]}`);
    if (typeof schema["pattern"] === "string" && !regexes.get(schema["pattern"])?.test(inst)) fail("pattern", "does not match pattern");
  }

  if (Array.isArray(inst)) {
    const n = inst.length;
    if (typeof schema["minItems"] === "number" && n < schema["minItems"]) fail("minItems", `fewer than ${schema["minItems"]} items`);
    if (typeof schema["maxItems"] === "number" && n > schema["maxItems"]) fail("maxItems", `more than ${schema["maxItems"]} items`);
    if (schema["uniqueItems"] === true) {
      outer: for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (deepEqual(inst[i], inst[j])) {
            fail("uniqueItems", "items are not unique");
            break outer;
          }
        }
      }
    }
    let start = 0;
    if (Array.isArray(schema["prefixItems"])) {
      schema["prefixItems"].forEach((s, i) => {
        if (i < n) {
          merge(sub(s, inst[i], `${path}/${i}`));
          out.items.add(i);
        }
      });
      start = Math.min(n, schema["prefixItems"].length);
    }
    if ("items" in schema) {
      for (let i = start; i < n; i++) {
        merge(sub(schema["items"], inst[i], `${path}/${i}`));
        out.items.add(i);
      }
    }
    if ("contains" in schema) {
      const matches: number[] = [];
      inst.forEach((x, i) => {
        if (sub(schema["contains"], x, `${path}/${i}`).errors.length === 0) matches.push(i);
      });
      const minC = typeof schema["minContains"] === "number" ? schema["minContains"] : 1;
      if (matches.length < minC) fail("contains", `fewer than ${minC} items match contains`);
      if (typeof schema["maxContains"] === "number" && matches.length > schema["maxContains"]) {
        fail("maxContains", `more than ${schema["maxContains"]} items match contains`);
      }
      for (const i of matches) out.items.add(i);
    }
  }

  if (isObj(inst)) {
    const keys = Object.keys(inst);
    if (typeof schema["minProperties"] === "number" && keys.length < schema["minProperties"]) fail("minProperties", "too few properties");
    if (typeof schema["maxProperties"] === "number" && keys.length > schema["maxProperties"]) fail("maxProperties", "too many properties");
    if (Array.isArray(schema["required"])) {
      for (const r of schema["required"] as string[]) if (!Object.hasOwn(inst, r)) fail("required", `missing required property '${r}'`);
    }
    if (isObj(schema["dependentRequired"])) {
      for (const [k, deps] of Object.entries(schema["dependentRequired"])) {
        if (Object.hasOwn(inst, k)) {
          for (const d of deps as string[]) if (!Object.hasOwn(inst, d)) fail("dependentRequired", `'${k}' requires '${d}'`);
        }
      }
    }
    if (isObj(schema["dependentSchemas"])) {
      for (const [k, s] of Object.entries(schema["dependentSchemas"])) if (Object.hasOwn(inst, k)) merge(sub(s, inst, path));
    }
    if ("propertyNames" in schema) {
      for (const k of keys) {
        const r = sub(schema["propertyNames"], k, `${path}/${k}`);
        if (r.errors.length) fail("propertyNames", `property name '${k}' is invalid`);
      }
    }
    const props = isObj(schema["properties"]) ? schema["properties"] : {};
    const pats = isObj(schema["patternProperties"]) ? Object.keys(schema["patternProperties"]) : [];
    for (const k of keys) {
      let matched = false;
      if (Object.hasOwn(props, k)) {
        matched = true;
        merge(sub(props[k], inst[k], `${path}/${k}`));
      }
      for (const p of pats) {
        if (regexes.get(p)?.test(k)) {
          matched = true;
          merge(sub((schema["patternProperties"] as Obj)[p], inst[k], `${path}/${k}`));
        }
      }
      if (!matched && "additionalProperties" in schema) {
        merge(sub(schema["additionalProperties"], inst[k], `${path}/${k}`));
        matched = true;
      }
      if (matched) out.props.add(k);
    }
  }

  if (Array.isArray(schema["allOf"])) {
    for (const s of schema["allOf"]) merge(sub(s, inst, path));
  }
  if (Array.isArray(schema["anyOf"])) {
    const rs = schema["anyOf"].map((s) => sub(s, inst, path));
    const good = rs.filter((r) => r.errors.length === 0);
    if (good.length === 0) fail("anyOf", "value matches none of anyOf");
    for (const r of good) mergeAnnotations(r);
  }
  if (Array.isArray(schema["oneOf"])) {
    const rs = schema["oneOf"].map((s) => sub(s, inst, path));
    const good = rs.filter((r) => r.errors.length === 0);
    if (good.length !== 1) fail("oneOf", `value matches ${good.length} of oneOf (expected exactly 1)`);
    for (const r of good) mergeAnnotations(r);
  }
  if ("not" in schema && sub(schema["not"], inst, path).errors.length === 0) fail("not", "value matches 'not' schema");
  if ("if" in schema) {
    const c = sub(schema["if"], inst, path);
    if (c.errors.length === 0) {
      mergeAnnotations(c);
      if ("then" in schema) merge(sub(schema["then"], inst, path));
    } else if ("else" in schema) {
      merge(sub(schema["else"], inst, path));
    }
  }
  if (isObj(inst) && "unevaluatedProperties" in schema) {
    for (const k of Object.keys(inst)) {
      if (!out.props.has(k)) {
        merge(sub(schema["unevaluatedProperties"], inst[k], `${path}/${k}`));
        out.props.add(k);
      }
    }
  }
  if (Array.isArray(inst) && "unevaluatedItems" in schema) {
    for (let i = 0; i < inst.length; i++) {
      if (!out.items.has(i)) {
        merge(sub(schema["unevaluatedItems"], inst[i], `${path}/${i}`));
        out.items.add(i);
      }
    }
  }
  return out;
}

export interface BuiltinValidatorOptions {
  readonly bounds?: Partial<SchemaBounds>;
}

/** Built-in Draft 2020-12 validator. Other `$schema` dialects fail as unsupported-dialect. */
export function createBuiltinValidator(opts: BuiltinValidatorOptions = {}): SchemaValidator {
  const bounds: SchemaBounds = { ...DEFAULT_SCHEMA_BOUNDS, ...opts.bounds };
  return {
    compile(schema: unknown): CompileResult {
      try {
        if (typeof schema !== "boolean" && !isObj(schema)) {
          throw new SchemaError("invalid-schema", "schema must be an object or boolean");
        }
        if (isObj(schema) && "$schema" in schema) {
          const d = schema["$schema"];
          if (typeof d !== "string" || d.replace(/#$/, "") !== DIALECT_2020_12) {
            throw new SchemaError(
              "unsupported-dialect",
              `unsupported JSON Schema dialect '${String(d)}'; only 2020-12 is supported`,
              typeof d === "string" ? d : String(d),
            );
          }
        }
        bound(schema, bounds);
        const res = collectResources(schema);
        const regexes = new Map<string, RegExp>();
        checkSchema(schema, res, regexes, "");
        return {
          ok: true,
          validate(value: unknown): ValidationResult {
            const r = runSchema(schema, value, "", 0, res, regexes);
            return { valid: r.errors.length === 0, errors: r.errors };
          },
        };
      } catch (e) {
        if (e instanceof SchemaError) {
          return {
            ok: false,
            reason: e.reason,
            message: e.message,
            ...(e.dialect !== undefined ? { dialect: e.dialect } : {}),
          };
        }
        return { ok: false, reason: "invalid-schema", message: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
