import { createHash } from "node:crypto";
import { ServerError, type Obj } from "@mcp/server-events";
import { complete, DEFAULT_CACHE_HINTS, paginate, type CacheHints } from "./protocol.js";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";
export const MAX_SKILL_FILES = 512;
export const MAX_SKILL_BYTES = 16 * 1024 * 1024;

export interface SkillFileInput {
	readonly uri: string;
	readonly mimeType?: string;
	readonly text?: string;
	readonly bytes?: Uint8Array;
}

export interface SkillInput {
	readonly uri: string;
	readonly name: string;
	readonly description: string;
	readonly files: readonly SkillFileInput[];
	readonly resources?: "static" | "dynamic";
	readonly allowedTools?: readonly string[];
	readonly metadata?: Record<string, unknown>;
}

export interface SkillFileEntry {
	readonly uri: string;
	readonly size: number;
	readonly sha256: string;
	readonly mimeType?: string;
}

export interface SkillEntry {
	readonly uri: string;
	readonly name: string;
	readonly description: string;
	readonly files: readonly SkillFileEntry[];
	readonly resources?: "static" | "dynamic";
	readonly allowedTools?: readonly string[];
	readonly metadata?: Record<string, unknown>;
}

interface StoredFile {
	readonly bytes: Uint8Array;
	readonly mimeType?: string;
}

/** Server-side skills publisher: manifests, hashes, and file contents. */
export class SkillsRegistry {
	readonly #skills = new Map<string, SkillEntry>();
	readonly #files = new Map<string, StoredFile>();

	capabilities(): Obj {
		return { extensions: { [SKILLS_EXTENSION_ID]: {} } };
	}

	register(input: SkillInput): SkillEntry {
		if (!input.uri || !input.name || !input.description) throw new ServerError(-32602, "skill uri/name/description required");
		if (input.files.length > MAX_SKILL_FILES) throw new ServerError(-32602, "too many skill files");
		let total = 0;
		const files: SkillFileEntry[] = [];
		for (const file of input.files) {
			const bytes = file.bytes ?? new TextEncoder().encode(file.text ?? "");
			total += bytes.byteLength;
			if (total > MAX_SKILL_BYTES) throw new ServerError(-32602, "skill files too large");
			const entry: SkillFileEntry = {
				uri: file.uri,
				size: bytes.byteLength,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
			};
			files.push(entry);
			this.#files.set(file.uri, { bytes, ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}) });
		}
		const entry: SkillEntry = {
			uri: input.uri,
			name: input.name,
			description: input.description,
			files,
			...(input.resources !== undefined ? { resources: input.resources } : {}),
			...(input.allowedTools !== undefined ? { allowedTools: input.allowedTools } : {}),
			...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
		};
		this.#skills.set(entry.uri, entry);
		return entry;
	}

	list(cursor: unknown, cache: CacheHints = DEFAULT_CACHE_HINTS): Obj {
		const skills = [...this.#skills.values()].sort((a, b) => a.uri.localeCompare(b.uri));
		const page = paginate(skills, cursor);
		return complete({
			skills: page.items,
			...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
		}, cache);
	}

	get(uri: string, cache: CacheHints = DEFAULT_CACHE_HINTS): Obj {
		const skill = this.#skills.get(uri);
		if (!skill) throw new ServerError(-32602, `unknown skill: ${uri}`);
		return complete({ skill }, cache);
	}

	/** File contents for the host's resources/read fallback. */
	read(uri: string): Obj | undefined {
		const file = this.#files.get(uri);
		if (!file) return undefined;
		const text = new TextDecoder().decode(file.bytes);
		return {
			uri,
			text,
			...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
		};
	}
}
