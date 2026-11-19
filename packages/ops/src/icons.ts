/** Icon metadata helpers (SEC-ICON-1..5). The library fetches and renders nothing. */

export interface Icon {
  readonly src: string;
  readonly mimeType?: string;
  readonly sizes?: readonly string[];
  readonly theme?: string;
}

export type ImageKind = "png" | "jpeg" | "webp" | "svg";

export interface IconPolicy {
  readonly allowWebp?: boolean;
  /** SVG is off by default; sanitization is the renderer's job. */
  readonly allowSvg?: boolean;
  /** Default 256 KiB. */
  readonly maxBytes?: number;
}

export const DEFAULT_ICON_MAX_BYTES = 256 * 1024;

export type IconCheck =
  | { readonly ok: true; readonly kind?: ImageKind }
  | { readonly ok: false; readonly reason: string };

const MIME_KIND: Record<string, ImageKind> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

/** Detect by magic bytes (SEC-ICON-5). */
export function detectImageKind(b: Uint8Array): ImageKind | undefined {
  const at = (i: number, ...v: number[]): boolean => v.every((x, j) => b[i + j] === x);
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return "jpeg";
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  const head = new TextDecoder().decode(b.subarray(0, 256)).trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(head)) return "svg";
  return undefined;
}

/** Check fetched or embedded bytes against the declared MIME type and policy. */
export function checkIconBytes(bytes: Uint8Array, declaredMime: string | undefined, policy: IconPolicy = {}): IconCheck {
  if (bytes.length > (policy.maxBytes ?? DEFAULT_ICON_MAX_BYTES)) return { ok: false, reason: "too-large" };
  const kind = detectImageKind(bytes);
  if (!kind) return { ok: false, reason: "unrecognized-image" };
  const allowed = kind === "png" || kind === "jpeg" || (kind === "webp" && policy.allowWebp === true) || (kind === "svg" && policy.allowSvg === true);
  if (!allowed) return { ok: false, reason: `type-not-allowed:${kind}` };
  if (declaredMime !== undefined) {
    const declared = MIME_KIND[declaredMime.split(";")[0]?.trim().toLowerCase() ?? ""];
    if (declared !== kind) return { ok: false, reason: "mime-mismatch" };
  }
  return { ok: true, kind };
}

/** SEC-ICON-1/2/5 for an icon URI. https must be same-origin with the server; data: is checked by magic bytes. */
export function validateIcon(icon: Icon, serverOrigin: string, policy: IconPolicy = {}): IconCheck {
  let u: URL;
  try {
    u = new URL(icon.src);
  } catch {
    return { ok: false, reason: "invalid-uri" };
  }
  if (u.protocol === "https:") {
    let origin: string;
    try {
      origin = new URL(serverOrigin).origin;
    } catch {
      return { ok: false, reason: "invalid-server-origin" };
    }
    if (u.origin !== origin) return { ok: false, reason: "cross-origin" };
    if (u.username !== "" || u.password !== "") return { ok: false, reason: "credentials-in-uri" };
    return { ok: true };
  }
  if (u.protocol === "data:") {
    const m = /^data:([^,;]*)((?:;[^,;]*)*),(.*)$/s.exec(icon.src);
    if (!m) return { ok: false, reason: "invalid-uri" };
    const mime = (m[1] || "").toLowerCase();
    if (!(m[2] ?? "").split(";").includes("base64")) return { ok: false, reason: "data-uri-not-base64" };
    let bytes: Uint8Array;
    try {
      const bin = atob(decodeURIComponent(m[3] ?? ""));
      bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    } catch {
      return { ok: false, reason: "invalid-base64" };
    }
    return checkIconBytes(bytes, mime === "" ? icon.mimeType : mime, policy);
  }
  return { ok: false, reason: `unsafe-scheme:${u.protocol}` };
}
