/**
 * SchemaValidator port and the built-in JSON Schema 2020-12 validator
 * (OPS-SCHEMA-1..7), backed by Ajv 2020 (`ajv/dist/2020`). No network:
 * Ajv `loadSchema` is never configured, so only same-document `$ref` resolves.
 */

import { Ajv2020, type ErrorObject, type Options } from "ajv/dist/2020.js";

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

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Options shared by every Ajv instance. `strict:false` lets unknown annotations
 * (`x-*`, `x-mcp-header`, vendor keywords) through; formats are annotations only;
 * `ownProperties` keeps inherited properties from satisfying `required`.
 * `loadSchema` is deliberately absent: external `$ref` fails compilation.
 */
const AJV_BASE: Options = {
  strict: false,
  validateFormats: false,
  ownProperties: true,
  multipleOfPrecision: 9,
  unicodeRegExp: true,
};

/** Meta-schema validation only; user schemas are never added to this instance. */
let metaAjv: Ajv2020 | undefined;
const meta = (): Ajv2020 => (metaAjv ??= new Ajv2020({ ...AJV_BASE }));

/**
 * One Ajv instance per compiled schema: user `$id`s never collide across schemas
 * or shadow the meta-schema, and nothing accumulates in a shared Ajv cache.
 */
const freshAjv = (): Ajv2020 =>
  new Ajv2020({ ...AJV_BASE, meta: false, validateSchema: false, allErrors: true, verbose: true });

class SchemaError extends Error {
  constructor(
    readonly reason: "unsupported-dialect" | "invalid-schema",
    message: string,
    readonly dialect?: string,
  ) {
    super(message);
  }
}

/** Pre-compile scan (OPS-SCHEMA-6): runs before Ajv sees the schema. */
function bound(schema: unknown, b: SchemaBounds): void {
  const bytes = new TextEncoder().encode(JSON.stringify(schema) ?? "").length;
  if (bytes > b.maxBytes) throw new SchemaError("invalid-schema", `schema exceeds ${b.maxBytes} bytes`);
  let count = 0;
  // Depth counts nested objects and arrays only; scalar leaves do not add a level.
  const walk = (v: unknown, depth: number): void => {
    if (typeof v !== "object" || v === null) return;
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

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function toIssue(e: ErrorObject): SchemaIssue {
  const path = e.instancePath || "/";
  if (e.keyword === "type") {
    const t = (e.params as { type?: unknown }).type;
    return { path, keyword: "type", message: `expected ${Array.isArray(t) ? t.join("|") : String(t)}, got ${typeOf(e.data)}` };
  }
  if (e.keyword === "false schema") return { path, keyword: "false", message: "schema is false" };
  return { path, keyword: e.keyword, message: e.message ?? e.keyword };
}

const DEPTH_ISSUE: SchemaIssue = { path: "/", keyword: "$ref", message: "validation depth limit exceeded" };

export interface BuiltinValidatorOptions {
  readonly bounds?: Partial<SchemaBounds>;
}

/** Built-in Draft 2020-12 validator (Ajv). Other `$schema` dialects fail as unsupported-dialect. */
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
        const m = meta();
        if (!(m.validateSchema(schema) as boolean)) {
          throw new SchemaError("invalid-schema", `invalid schema: ${m.errorsText(m.errors)}`);
        }
        let fn: ReturnType<Ajv2020["compile"]>;
        try {
          fn = freshAjv().compile(schema as Obj | boolean);
        } catch (e) {
          if (e instanceof RangeError) {
            throw new SchemaError("invalid-schema", "schema reference depth exceeded ($ref cycle without progress)");
          }
          const msg = e instanceof Error ? e.message : String(e);
          if (/resolve reference|only supports hash fragment/.test(msg)) {
            throw new SchemaError("invalid-schema", `${msg} (network and external references are never resolved)`);
          }
          throw new SchemaError("invalid-schema", msg);
        }
        // The SchemaValidator port is synchronous; Ajv's `$async` extension would return a Promise.
        if ((fn as { $async?: unknown }).$async === true) {
          throw new SchemaError("invalid-schema", "'$async' schemas are not supported (validation is synchronous)");
        }
        return {
          ok: true,
          validate(value: unknown): ValidationResult {
            try {
              const r: unknown = fn(value);
              if (r !== true && r !== false) {
                return { valid: false, errors: [{ path: "/", keyword: "$async", message: "non-boolean validation result" }] };
              }
              if (r) return { valid: true, errors: [] };
              const errors = (fn.errors ?? []).map(toIssue);
              return { valid: false, errors: errors.length ? errors : [{ path: "/", keyword: "schema", message: "invalid" }] };
            } catch (e) {
              // Recursive $ref without progress, or instance nesting beyond the stack.
              if (e instanceof RangeError) return { valid: false, errors: [DEPTH_ISSUE] };
              throw e;
            }
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
