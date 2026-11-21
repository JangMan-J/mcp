import { readFile, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { expect, it } from "vitest";
import { createCallToolResultSchema, relocateSchemaRefs, renderOutcome } from "./results.js";

const meta = { requestId: 1, method: "tools/call", binding: "http", attempts: 1 };

it("middle-cuts multibyte text across blocks and spills the complete text privately [PICA-6]", async () => {
  const parts = ["head" + "🙂".repeat(3000), "中".repeat(4000) + "tail"];
  const value = { content: parts.map(text => ({ type: "text", text })), structuredContent: [1, 2] };
  const outcome = { kind: "ok", value, meta } as const;
  const result = await renderOutcome(outcome);
  const path = result.details.spillPath!;
  try {
    const { text } = result.content[0]! as { text: string };
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20 * 1024);
    expect(text).toMatch(/^head🙂/);
    expect(text).toMatch(/中tail$/);
    expect(text).not.toContain("\uFFFD");
    expect(text).toContain(path);
    expect(await readFile(path, "utf8")).toBe(parts.join("\n"));
    expect((await stat(path)).mode & 0o077).toBe(0);
    expect((await stat(dirname(path))).mode & 0o077).toBe(0);
    expect(result.details.outcome).toBe(outcome);
    expect(result.isError).toBe(false);
  } finally {
    await rm(dirname(path), { recursive: true, force: true });
  }
});

it("returns tool-isError as an error result, not an exception; exact limit stays inline", async () => {
  const text = "é".repeat(10 * 1024);
  const outcome = { kind: "tool-isError", result: { content: [{ type: "text", text }], isError: true }, meta } as const;
  const rendered = await renderOutcome(outcome);
  expect(rendered.isError).toBe(true);
  expect(rendered.details.outcome).toBe(outcome);
  expect(rendered.details.spillPath).toBeUndefined();
  expect(rendered.content).toEqual([{ type: "text", text }]);
});

it("warns against blind retries when the write may have run", async () => {
  const result = await renderOutcome({ kind: "uncertain-write", meta, uncertain: {
    requestId: 1, method: "tools/call", argsDigest: "abc", sentAt: 0, binding: "http", evidence: "timeout",
  } });
  expect(result.isError).toBe(true);
  expect((result.content[0] as { text: string }).text).toMatch(/may or may not have run; do not retry blindly/i);
});

it("shows images and renders resource_link as text with server, keeping the raw result [PICA-6]", async () => {
  const value = { content: [
    { type: "text", text: "hi" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
    { type: "resource_link", name: "doc", uri: "file:///a.md", mimeType: "text/markdown", description: "d" },
  ] };
  const outcome = { kind: "ok", value, meta } as const;
  const r = await renderOutcome(outcome, { server: "srv" });
  expect(r.content).toEqual([
    { type: "text", text: "hi\n[resource_link from srv] doc file:///a.md (text/markdown) - d" },
    { type: "image", data: "QUJD", mimeType: "image/png" },
  ]);
  expect(r.details.outcome).toBe(outcome);
  expect((await renderOutcome(outcome)).content[0]).toMatchObject({ text: expect.stringContaining("[resource_link] doc") });
});

it("renders embedded text, text-mime blob, image-mime blob, and audio blocks", async () => {
  const jsonText = JSON.stringify({ ok: true });
  const csvText = "a,b\n1,2";
  const value = {
    content: [
      { type: "resource", resource: { uri: "file:///note.txt", mimeType: "text/plain", text: "inline text" } },
      { type: "resource", resource: { uri: "file:///data.json", mimeType: "application/json", blob: Buffer.from(jsonText).toString("base64") } },
      { type: "resource", resource: { uri: "file:///table.csv", mimeType: "text/csv; charset=utf-8", blob: Buffer.from(csvText).toString("base64") } },
      { type: "resource", resource: { uri: "file:///pic.png", mimeType: "IMAGE/PNG", blob: "QUJD" } },
      { type: "audio", mimeType: "audio/wav" },
      { type: "audio" },
    ],
  };
  const r = await renderOutcome({ kind: "ok", value, meta });
  expect(r.content).toEqual([
    { type: "text", text: ["inline text", jsonText, csvText, "[audio content (audio/wav)]", "[audio content]"].join("\n") },
    { type: "image", data: "QUJD", mimeType: "IMAGE/PNG" },
  ]);
  expect(r.details.binarySpillPaths).toBeUndefined();
});

it("spills binary resource blobs privately with URI extension or .bin fallback", async () => {
  const pdfBytes = Buffer.from("%PDF-1.4\n\x00\x01\x02");
  const rawBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const value = {
    content: [
      { type: "resource", resource: { uri: "https://example.com/docs/report.pdf?v=1", mimeType: "application/pdf", blob: pdfBytes.toString("base64") } },
      { type: "resource", resource: { uri: "mem://opaque-blob", blob: rawBytes.toString("base64") } },
    ],
  };
  const r = await renderOutcome({ kind: "ok", value, meta });
  const paths = r.details.binarySpillPaths!;
  expect(paths).toHaveLength(2);
  try {
    const [pdfPath, binPath] = paths as [string, string];
    expect(basename(pdfPath)).toBe("resource.pdf");
    expect(basename(binPath)).toBe("resource.bin");
    expect(await readFile(pdfPath)).toEqual(pdfBytes);
    expect(await readFile(binPath)).toEqual(rawBytes);
    expect((await stat(pdfPath)).mode & 0o077).toBe(0);
    expect((await stat(dirname(pdfPath))).mode & 0o077).toBe(0);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain(`[Binary resource https://example.com/docs/report.pdf?v=1 (application/pdf, ${pdfBytes.length} bytes) saved to ${pdfPath}]`);
    expect(text).toContain(`[Binary resource mem://opaque-blob (unknown type, ${rawBytes.length} bytes) saved to ${binPath}]`);
  } finally {
    await Promise.all(paths.map(p => rm(dirname(p), { recursive: true, force: true })));
  }
});

it("strips _meta into details.rawCallToolResult and structuredContent", async () => {
  const value = {
    content: [{ type: "text", text: "ok" }],
    structuredContent: { count: 2 },
    _meta: { traceId: "abc" },
  };
  const r = await renderOutcome({ kind: "ok", value, meta });
  expect(r.details.rawCallToolResult).toEqual({
    content: [{ type: "text", text: "ok" }],
    structuredContent: { count: 2 },
  });
  expect("_meta" in (r.details.rawCallToolResult as Record<string, unknown>)).toBe(false);
  expect(r.structuredContent).toEqual(r.details.rawCallToolResult);

  const rNoTop = await renderOutcome({ kind: "tool-isError", result: { ...value, isError: true }, meta }, { includeStructuredContent: false });
  expect(rNoTop.details.rawCallToolResult).toEqual({
    content: [{ type: "text", text: "ok" }],
    structuredContent: { count: 2 },
    isError: true,
  });
  expect("structuredContent" in rNoTop).toBe(false);
});

it("builds CallToolResult schema and relocates local $refs safely", () => {
  const bare = createCallToolResultSchema();
  expect(bare).toMatchObject({
    type: "object",
    required: ["content"],
    additionalProperties: true,
    properties: {
      content: {
        type: "array",
        items: {
          type: "object",
          required: ["type"],
          additionalProperties: true,
          properties: {
            type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
            text: { type: "string" },
            data: { type: "string" },
            mimeType: { type: "string" },
          },
        },
      },
      structuredContent: {},
      isError: { type: "boolean" },
    },
  });

  const inputSchema = {
    type: "object",
    $defs: {
      Node: {
        type: "object",
        properties: {
          self: { $ref: "#" },
          next: { $ref: "#/$defs/Node" },
          external: { $ref: "https://example.com/node.json" },
          $ref: { $ref: "#/$defs/RefString" },
        },
      },
      RefString: {
        type: "string",
        const: { $ref: "#/untouched" },
        default: { $ref: "#" },
        enum: [{ $ref: "#/enum-untouched" }],
        examples: [{ $ref: "#/example-untouched" }],
      },
    },
    allOf: [{ $ref: "#/$defs/Node" }],
  };

  const full = createCallToolResultSchema(inputSchema);
  expect(full.properties).toMatchObject({
    structuredContent: {
      type: "object",
      $defs: {
        Node: {
          type: "object",
          properties: {
            self: { $ref: "#/properties/structuredContent" },
            next: { $ref: "#/properties/structuredContent/$defs/Node" },
            external: { $ref: "https://example.com/node.json" },
            $ref: { $ref: "#/properties/structuredContent/$defs/RefString" },
          },
        },
        RefString: {
          type: "string",
          const: { $ref: "#/untouched" },
          default: { $ref: "#" },
          enum: [{ $ref: "#/enum-untouched" }],
          examples: [{ $ref: "#/example-untouched" }],
        },
      },
      allOf: [{ $ref: "#/properties/structuredContent/$defs/Node" }],
    },
  });

  expect(relocateSchemaRefs(true, "#/properties/structuredContent")).toBe(true);
});
