/**
 * Input & output JSON Schema normalization for Pi's LLM tool declarations and codemode scripts.
 *
 * Mirrors Pi's built-in MCP tool contracts (docs/mcp.md):
 * - Input schemas always carry `type: "object"` and `properties: {}` when omitted so strict providers do not 400.
 * - Output schemas wrap MCP `CallToolResult` (`{ content, structuredContent?, isError? }`) and relocate local `#/...`
 *   `$ref` pointers below `#/properties/structuredContent` so codemode scripts receive full untruncated results.
 */

const CONTENT_BLOCK_SCHEMA: Record<string, unknown> = {
	type: "object",
	properties: {
		type: { enum: ["text", "image", "audio", "resource_link", "resource"] },
		text: { type: "string" },
		data: { type: "string" },
		mimeType: { type: "string" },
	},
	required: ["type"],
	additionalProperties: true,
};

const SCHEMA_DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
const SCHEMA_MAP_KEYWORDS = new Set([
	"properties",
	"patternProperties",
	"dependentSchemas",
	"dependencies",
	"$defs",
	"definitions",
]);

function relocateSchema(schema: unknown, pointer: string): unknown {
	if (Array.isArray(schema)) return schema.map((item) => relocateSchema(item, pointer));
	if (typeof schema !== "object" || schema === null) return schema;
	const relocated: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$ref" && typeof value === "string" && (value === "#" || value.startsWith("#/"))) {
			relocated[key] = `${pointer}${value.slice(1)}`;
		} else if (SCHEMA_DATA_KEYWORDS.has(key)) {
			relocated[key] = value;
		} else if (SCHEMA_MAP_KEYWORDS.has(key) && typeof value === "object" && value !== null && !Array.isArray(value)) {
			relocated[key] = Object.fromEntries(
				Object.entries(value).map(([name, sub]) => [name, relocateSchema(sub, pointer)]),
			);
		} else {
			relocated[key] = relocateSchema(value, pointer);
		}
	}
	return relocated;
}

export function normalizeMcpInputSchema(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { type: "object", properties: {} };
	}
	const schema = raw as Record<string, unknown>;
	return {
		...schema,
		type: schema.type ?? "object",
		...(schema.properties === undefined ? { properties: {} } : {}),
	};
}

export function createMcpResultSchema(structuredContentSchema?: unknown): Record<string, unknown> {
	const hasSchema =
		typeof structuredContentSchema === "object" &&
		structuredContentSchema !== null &&
		!Array.isArray(structuredContentSchema);
	return {
		type: "object",
		properties: {
			content: { type: "array", items: CONTENT_BLOCK_SCHEMA },
			structuredContent: hasSchema
				? relocateSchema(structuredContentSchema, "#/properties/structuredContent")
				: {},
			isError: { type: "boolean" },
		},
		required: ["content"],
		additionalProperties: true,
	};
}
