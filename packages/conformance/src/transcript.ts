import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One observed frame. HTTP fields are present only when a binding observes them. */
export interface TranscriptFrame {
  readonly direction: "client" | "server";
  readonly endpoint?: "mcp" | "oauth" | "registration" | "other";
  readonly incomplete?: false;
  readonly message?: unknown;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly url?: string;
}

/** Baseline transcript built from observations at the harness seam. */
export interface Transcript {
  readonly fixture: string;
  readonly frames: readonly TranscriptFrame[];
  readonly mcpEndpoint?: string;
  readonly zeroWire?: boolean;
}

export const TRANSCRIPTS_ENV = "MCP_CONFORMANCE_TRANSCRIPTS";

/** Writes `<dir>/<id with / as __>.transcript.json` when MCP_CONFORMANCE_TRANSCRIPTS is set. */
export function writeTranscript(transcript: Transcript): string | undefined {
  const dir = process.env[TRANSCRIPTS_ENV];
  if (!dir) return undefined;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${transcript.fixture.replace(/[\/]/g, "__")}.transcript.json`);
  writeFileSync(file, `${JSON.stringify(transcript, null, 2)}\n`);
  return file;
}
