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
	readonly frontmatter?: Record<string, unknown>;
	readonly resources?: "static" | "dynamic";
	readonly allowedTools?: readonly string[];
	readonly metadata?: Record<string, unknown>;
}

export interface SkillFileEntry {
	readonly uri: string;
	readonly size: number;
	readonly sha256: string;
	readonly digest: string;
	readonly mimeType?: string;
}

export interface SkillResourceRef {
	readonly uri: string;
	readonly digest: string;
	readonly size: number;
}

export interface SkillEntry {
	readonly uri: string;
	readonly name: string;
	readonly description: string;
	readonly frontmatter: Record<string, unknown>;
	readonly resources: readonly SkillResourceRef[] | "dynamic";
	readonly files: readonly SkillFileEntry[];
	readonly allowedTools?: readonly string[];
	readonly metadata?: Record<string, unknown>;
}

interface StoredFile {
	readonly bytes: Uint8Array;
	readonly mimeType?: string;
	readonly name: string;
	readonly description?: string;
}

/** Server-side SEP-2640 skills publisher: manifests, SHA-256 digests, directory listing, and file contents. */
export class SkillsRegistry {
	readonly #skills = new Map<string, SkillEntry>();
	readonly #files = new Map<string, StoredFile>();

	capabilities(): Obj {
		return { extensions: { [SKILLS_EXTENSION_ID]: { directoryRead: true } } };
	}

	register(input: SkillInput): SkillEntry {
		if (!input.uri || !input.name || !input.description) throw new ServerError(-32602, "skill uri/name/description required");
		if (input.files.length > MAX_SKILL_FILES) throw new ServerError(-32602, "too many skill files");
		let total = 0;
		const files: SkillFileEntry[] = [];
		const resourceRefs: SkillResourceRef[] = [];
		for (const file of input.files) {
			const bytes = file.bytes ?? new TextEncoder().encode(file.text ?? "");
			total += bytes.byteLength;
			if (total > MAX_SKILL_BYTES) throw new ServerError(-32602, "skill files too large");
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const digest = `sha256:${sha256}`;
			const isRoot = file.uri === input.uri || file.uri.endsWith("/SKILL.md");
			const mimeType = file.mimeType ?? (file.uri.endsWith(".md") ? "text/markdown" : undefined);
			const entry: SkillFileEntry = {
				uri: file.uri,
				size: bytes.byteLength,
				sha256,
				digest,
				...(mimeType !== undefined ? { mimeType } : {}),
			};
			files.push(entry);
			resourceRefs.push({ uri: file.uri, digest, size: bytes.byteLength });
			const fileName = isRoot ? input.name : (file.uri.split("/").pop() ?? file.uri);
			this.#files.set(file.uri, {
				bytes,
				name: fileName,
				...(isRoot ? { description: input.description } : {}),
				...(mimeType !== undefined ? { mimeType } : {}),
			});
		}
		const frontmatter: Record<string, unknown> = {
			...(input.frontmatter ?? {}),
			name: input.name,
			description: input.description,
			...(input.allowedTools !== undefined ? { "allowed-tools": input.allowedTools } : {}),
			...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
		};
		const entry: SkillEntry = {
			uri: input.uri,
			name: input.name,
			description: input.description,
			frontmatter,
			resources: input.resources === "dynamic" ? "dynamic" : resourceRefs,
			files,
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

	/** Resource metadata entries for resources/list inclusion. */
	resourceSchemas(): Obj[] {
		return [...this.#files.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([uri, file]) => ({
				uri,
				name: file.name,
				...(file.description !== undefined ? { description: file.description } : {}),
				...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
			}));
	}

	/** SEP-2640 resources/directory/read: direct child files and subdirectories under dirUri. */
	readDirectory(dirUri: string, cursor: unknown, cache: CacheHints = DEFAULT_CACHE_HINTS): Obj {
		const prefix = dirUri.replace(/\/+$/u, "") + "/";
		const children = new Map<string, Obj>();
		for (const [uri, file] of this.#files.entries()) {
			if (!uri.startsWith(prefix)) continue;
			const rest = uri.slice(prefix.length);
			if (!rest) continue;
			const slash = rest.indexOf("/");
			if (slash < 0) {
				children.set(uri, {
					uri,
					name: file.name,
					...(file.description !== undefined ? { description: file.description } : {}),
					...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
				});
			} else {
				const subName = rest.slice(0, slash);
				const subUri = `${dirUri.replace(/\/+$/u, "")}/${subName}`;
				if (!children.has(subUri)) {
					children.set(subUri, { uri: subUri, name: subName, mimeType: "inode/directory" });
				}
			}
		}
		if (children.size === 0) throw new ServerError(-32602, `directory not found: ${dirUri}`);
		const sorted = [...children.values()].sort((a, b) => String(a.uri).localeCompare(String(b.uri)));
		const page = paginate(sorted, cursor);
		return complete({
			resources: page.items,
			uris: page.items.map((item) => item.uri),
			...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
		}, cache);
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
