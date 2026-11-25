/** Bounded diagnostics log (mcp.log), rotated at 5 MB like Pi's mcp.log. */

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;

export class DiagnosticsLog {
	#writing: Promise<void> = Promise.resolve();

	constructor(private readonly path: string) {}

	line(server: string, message: string): void {
		const line = `${new Date().toISOString()} [${server}] ${message}\n`;
		this.#writing = this.#writing.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			try {
				const info = await stat(this.path);
				if (info.size > MAX_BYTES) await rename(this.path, `${this.path}.1`);
			} catch {
				// first write
			}
			await appendFile(this.path, line);
		}).catch(() => {});
	}
}
