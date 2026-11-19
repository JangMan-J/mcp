/** In-tree RFC 6570 level 1-4 expander (OPS-RES-2, Q27). */

export type TemplateValue = string | number | boolean | readonly string[] | Readonly<Record<string, string>> | null | undefined;

interface OpSpec {
  first: string;
  sep: string;
  named: boolean;
  ifemp: string;
  allowReserved: boolean;
}

const OPS: Record<string, OpSpec> = {
  "": { first: "", sep: ",", named: false, ifemp: "", allowReserved: false },
  "+": { first: "", sep: ",", named: false, ifemp: "", allowReserved: true },
  "#": { first: "#", sep: ",", named: false, ifemp: "", allowReserved: true },
  ".": { first: ".", sep: ".", named: false, ifemp: "", allowReserved: false },
  "/": { first: "/", sep: "/", named: false, ifemp: "", allowReserved: false },
  ";": { first: ";", sep: ";", named: true, ifemp: "", allowReserved: false },
  "?": { first: "?", sep: "&", named: true, ifemp: "=", allowReserved: false },
  "&": { first: "&", sep: "&", named: true, ifemp: "=", allowReserved: false },
};

function encode(s: string, reserved: boolean): string {
  if (!reserved) {
    return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  }
  // keep reserved characters and existing pct-encoded triplets
  return s
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : encodeURI(part).replace(/%5B/gi, "[").replace(/%5D/gi, "]"),
    )
    .join("");
}

const VARSPEC = /^((?:[A-Za-z0-9_]|%[0-9A-Fa-f]{2})(?:[A-Za-z0-9_.]|%[0-9A-Fa-f]{2})*)(\*|:[1-9][0-9]{0,3})?$/;

export function expandUriTemplate(template: string, vars: Readonly<Record<string, TemplateValue>>): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf("{", i);
    const stray = template.indexOf("}", i);
    if (open < 0) {
      if (stray >= 0) throw new TypeError("unmatched '}' in URI template");
      out += template.slice(i);
      break;
    }
    if (stray >= 0 && stray < open) throw new TypeError("unmatched '}' in URI template");
    out += template.slice(i, open);
    const close = template.indexOf("}", open);
    if (close < 0) throw new TypeError("unclosed '{' in URI template");
    let expr = template.slice(open + 1, close);
    i = close + 1;
    let opch = "";
    if (expr !== "" && "+#./;?&".includes(expr[0] as string)) {
      opch = expr[0] as string;
      expr = expr.slice(1);
    } else if (expr !== "" && "=,!@|".includes(expr[0] as string)) {
      throw new TypeError(`reserved operator '${expr[0]}' in URI template`);
    }
    const op = OPS[opch] as OpSpec;
    const parts: string[] = [];
    for (const spec of expr.split(",")) {
      const m = VARSPEC.exec(spec);
      if (!m) throw new TypeError(`invalid variable specifier '${spec}'`);
      const name = m[1] as string;
      const mod = m[2];
      const v = vars[name];
      if (v === undefined || v === null) continue;
      const enc = (s: string): string => encode(s, op.allowReserved);
      if (Array.isArray(v) || (typeof v === "object" && v !== null)) {
        const isList = Array.isArray(v);
        const entries: [string, string][] = isList
          ? (v as readonly string[]).map((x) => ["", x])
          : Object.entries(v as Record<string, string>);
        if (entries.length === 0) continue;
        if (mod === "*") {
          const items = entries.map(([k, x]) =>
            isList ? (op.named ? `${name}=${enc(x)}` : enc(x)) : `${enc(k)}=${enc(x)}`,
          );
          if (isList && op.named) {
            parts.push(...entries.map(([, x]) => (x === "" ? `${name}${op.ifemp}` : `${name}=${enc(x)}`)));
          } else {
            parts.push(...items);
          }
        } else {
          const flat = entries.flatMap(([k, x]) => (isList ? [enc(x)] : [enc(k), enc(x)])).join(",");
          parts.push(op.named ? `${name}=${flat}` : flat);
        }
      } else {
        let s = String(v);
        if (mod?.startsWith(":")) s = [...s].slice(0, Number(mod.slice(1))).join("");
        const e = enc(s);
        if (op.named) parts.push(s === "" ? `${name}${op.ifemp}` : `${name}=${e}`);
        else parts.push(e);
      }
    }
    if (parts.length > 0) out += op.first + parts.join(op.sep);
  }
  return out;
}
