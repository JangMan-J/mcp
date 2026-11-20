import { createHash } from 'node:crypto';

const limit = 64;

/** Provider-safe name for one remote tool, independent of registration order. */
export function toolName(server: string, tool: string): string {
  const raw = `mcp__${server}__${tool}`;
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  const ambiguous = server.includes('__') || tool.includes('__') || server.endsWith('_') || tool.startsWith('_');
  if (raw === safe && raw.length <= limit && !ambiguous) return raw;

  // Hash the original tuple, not its lossy display form. Triple underscores
  // inside the body cannot occur in an unambiguous, unchanged name.
  const digest = createHash('sha256').update(JSON.stringify([server, tool])).digest('hex').slice(0, 16);
  const suffix = `___${digest}`;
  return safe.slice(0, limit - suffix.length) + suffix;
}
