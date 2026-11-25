import type { BrowserPort } from "@mcp/core";
import {
  object,
  Violation,
  withAbort,
  type Diagnostic,
  type Obj,
} from "./common.js";

export type Decision = "accept" | "cancel" | "decline";
export type FormResponse =
  { action: "accept"; content: Obj } | { action: "cancel" | "decline" };
export interface FormRequest {
  serverLabel: string;
  message: string;
  schema: Obj;
  defaults: Obj;
  suspectSensitiveFields: string[];
  invalidPrevious: boolean;
}
export interface UrlConsentRequest {
  serverLabel: string;
  message: string;
  url: string;
  hostHighlight: string;
  punycodeWarning: boolean;
}
export interface ElicitationPort {
  form?(request: FormRequest, signal: AbortSignal): Promise<FormResponse>;
  url?(request: UrlConsentRequest, signal: AbortSignal): Promise<Decision>;
}
export interface ElicitationOptions {
  serverLabel: string;
  port?: ElicitationPort;
  browser?: BrowserPort;
  allowInsecureDev?: boolean;
  diagnostic?: Diagnostic;
}
export function elicitationCapabilities({
  port,
  browser,
}: ElicitationOptions): Obj {
  const modes = {
    ...(port?.form && { form: {} }),
    ...(port?.url && browser && { url: {} }),
  };
  return Object.keys(modes).length ? { elicitation: modes } : {};
}
const bad = (): never => {
  throw new Violation("unsupported-elicitation-schema");
};
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");
function keys(o: Obj, allowed: string[]) {
  if (Object.keys(o).some((k) => !allowed.includes(k))) bad();
}
function choices(o: Obj, keyword: string): string[] | undefined {
  if (o.enum !== undefined) {
    if (!strings(o.enum) || !o.enum.length || o[keyword] !== undefined)
      return bad();
    return o.enum;
  }
  const a = o[keyword];
  if (a === undefined) return undefined;
  if (!Array.isArray(a) || !a.length) return bad();
  return a.map((item) => {
    if (
      !object(item) ||
      typeof item.const !== "string" ||
      typeof item.title !== "string"
    )
      return bad();
    keys(item, ["const", "title"]);
    return item.const;
  });
}
function formatOk(s: string, f: unknown): boolean {
  if (f === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(s);
  if (f === "date")
    return (
      /^\d{4}-\d\d-\d\d$/.test(s) &&
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().startsWith(s)
    );
  if (f === "date-time")
    return (
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/i.test(
        s,
      ) && !Number.isNaN(Date.parse(s))
    );
  if (f === "uri") return URL.canParse(s);
  return true;
}
function validator(p: Obj): (v: unknown) => boolean {
  const base = ["type", "default", "description", "title"];
  const limits = (lo: string, hi: string, count: boolean) => {
    for (const k of [lo, hi])
      if (
        k in p &&
        (typeof p[k] !== "number" ||
          !Number.isFinite(p[k]) ||
          (count && (!Number.isInteger(p[k]) || Number(p[k]) < 0)))
      )
        bad();
    return (n: number) =>
      n >= Number(p[lo] ?? -Infinity) && n <= Number(p[hi] ?? Infinity);
  };
  switch (p.type) {
    case "string": {
      keys(p, [
        ...base,
        "format",
        "pattern",
        "minLength",
        "maxLength",
        "enum",
        "enumNames",
        "oneOf",
      ]);
      const e = choices(p, "oneOf"),
        fits = limits("minLength", "maxLength", true);
      if (
        p.format !== undefined &&
        !["date", "date-time", "email", "uri"].includes(String(p.format))
      )
        bad();
      let re: RegExp | undefined;
      if (p.pattern !== undefined) {
        if (typeof p.pattern !== "string") return bad();
        try {
          re = new RegExp(p.pattern, "u");
        } catch {
          return bad();
        }
      }
      return (v) =>
        typeof v === "string" &&
        fits([...v].length) &&
        formatOk(v, p.format) &&
        (!re || re.test(v)) &&
        (!e || e.includes(v));
    }
    case "boolean":
      keys(p, base);
      return (v) => typeof v === "boolean";
    case "number":
    case "integer": {
      keys(p, [...base, "minimum", "maximum"]);
      const fits = limits("minimum", "maximum", false);
      return (v) =>
        typeof v === "number" &&
        Number.isFinite(v) &&
        fits(v) &&
        (p.type !== "integer" || Number.isInteger(v));
    }
    case "array": {
      keys(p, [...base, "minItems", "maxItems", "items"]);
      if (!object(p.items)) return bad();
      keys(p.items, ["type", "enum", "anyOf"]);
      if (p.items.type !== undefined && p.items.type !== "string") return bad();
      const e = choices(p.items, "anyOf") ?? bad(),
        fits = limits("minItems", "maxItems", true);
      return (v) =>
        strings(v) && fits(v.length) && v.every((x) => e.includes(x));
    }
    default:
      return bad();
  }
}
export function assertSupported(
  method: unknown,
  params: unknown,
  options: ElicitationOptions,
  key: string,
): asserts params is Obj {
  const mode = object(params) ? (params.mode ?? "form") : null;
  if (
    method !== "elicitation/create" ||
    !(
      (mode === "form" && options.port?.form) ||
      (mode === "url" && options.port?.url && options.browser)
    )
  )
    throw new Violation("unsupported-input-request", {
      key,
      method,
      serverLabel: options.serverLabel,
    });
}
export async function elicit(
  params: Obj,
  options: ElicitationOptions,
  signal: AbortSignal,
): Promise<{ action: Decision; content?: Obj }> {
  assertSupported("elicitation/create", params, options, "");
  signal.throwIfAborted();
  const { serverLabel, port, browser } = options,
    message = params.message;
  if (typeof message !== "string")
    throw new Violation("invalid-elicitation-message");
  if (params.mode === "url") {
    const url = params.url;
    if (
      typeof url !== "string" ||
      !URL.canParse(url) ||
      /[\x00-\x20\x7f\\]/.test(url)
    )
      throw new Violation("unsafe-elicitation-url");
    const u = new URL(url),
      loopback =
        u.hostname === "localhost" ||
        u.hostname === "[::1]" ||
        /^127\.\d+\.\d+\.\d+$/.test(u.hostname);
    if (
      u.username ||
      u.password ||
      !(
        u.protocol === "https:" ||
        (u.protocol === "http:" && options.allowInsecureDev && loopback)
      )
    )
      throw new Violation("unsafe-elicitation-url");
    const action = await withAbort(
      port!.url!(
        {
          serverLabel,
          message,
          url,
          hostHighlight: u.host,
          punycodeWarning: u.hostname
            .split(".")
            .some((s) => s.startsWith("xn--")),
        },
        signal,
      ),
      signal,
    );
    signal.throwIfAborted();
    if (action === "accept")
      await withAbort(browser!.open(url, signal), signal);
    else if (action !== "decline" && action !== "cancel")
      throw Error("invalid consent decision");
    return { action };
  }
  const schema = params.requestedSchema;
  if (!object(schema) || schema.type !== "object" || !object(schema.properties))
    return bad();
  keys(schema, [
    "$schema",
    "type",
    "properties",
    "required",
    "title",
    "description",
  ]);
  const fields = new Map<string, (v: unknown) => boolean>();
  const defaults: Obj = Object.create(null);
  for (const [k, p] of Object.entries(schema.properties)) {
    if (!object(p)) return bad();
    const check = validator(p);
    fields.set(k, check);
    if ("default" in p) {
      if (!check(p.default)) return bad();
      defaults[k] = p.default;
    }
  }
  const required = schema.required ?? [];
  if (!strings(required) || required.some((k) => !fields.has(k))) return bad();
  const suspectSensitiveFields = [...fields.keys()].filter((k) =>
    /password|token|secret|api[_-]?key|card/i.test(k),
  );
  for (const invalidPrevious of [false, true]) {
    signal.throwIfAborted();
    const r = await withAbort(
      port!.form!(
        {
          serverLabel,
          message,
          schema,
          defaults,
          suspectSensitiveFields,
          invalidPrevious,
        },
        signal,
      ),
      signal,
    );
    if (r.action === "decline" || r.action === "cancel")
      return { action: r.action };
    if (
      r.action === "accept" &&
      object(r.content) &&
      required.every((k) => Object.hasOwn(r.content, k)) &&
      Object.entries(r.content).every(([k, v]) => fields.get(k)?.(v))
    )
      return { action: "accept", content: structuredClone(r.content) };
  }
  options.diagnostic?.("invalid-elicitation-response");
  return { action: "cancel" };
}
export function removedElicitationNotification(
  method: string,
  diagnostic?: Diagnostic,
): boolean {
  if (method !== "notifications/elicitation/complete") return false;
  diagnostic?.("removed-elicitation-notification");
  return true;
}
