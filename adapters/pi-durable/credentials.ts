// Vendored from adapters/pi-coding-agent/credentials.ts so pi-durable builds standalone.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { CredentialStore } from '@mcp-client/core';

const filename = 'pi-mcp-client-credentials.json';

/** Use one writer instance per trusted config directory. */
function createCredentialStore(directory: string): CredentialStore {
  const dir = resolve(directory);
  const path = resolve(dir, filename);
  let pending = Promise.resolve();

  async function load(): Promise<Map<string, string>> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!file) return new Map();
    try {
      const text = await file.readFile('utf8');
      try {
        const data: unknown = JSON.parse(text);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const entries = Object.entries(data);
          if (entries.every(([, value]) => typeof value === 'string')) return new Map(entries);
        }
      } catch { /* Do not expose credential data from parser errors. */ }
      throw new Error('Invalid adapter credential store');
    } finally { await file.close(); }
  }

  function mutate(change: (values: Map<string, string>) => void): Promise<void> {
    const write = pending.then(async () => {
      const values = await load();
      change(values);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = `${path}.${randomUUID()}.tmp`;
      const file = await open(temp, 'wx', 0o600);
      try {
        try { await file.writeFile(JSON.stringify(Object.fromEntries(values))); }
        finally { await file.close(); }
        await rename(temp, path);
      } finally { await rm(temp, { force: true }); }
    });
    pending = write.catch(() => {});
    return write;
  }

  return {
    async get(key) { await pending; return (await load()).get(key); },
    set: (key, value) => mutate(values => values.set(key, value)),
    delete: key => mutate(values => values.delete(key)),
  };
}

/** Directories that belong to the user's global Pi install; durable runs must never write there. */
function globalPiDirs(env: NodeJS.ProcessEnv): string[] {
  return [join(homedir(), '.pi'), env['PI_CODING_AGENT_DIR']].filter((d): d is string => !!d).map(d => resolve(d));
}
const inside = (child: string, parent: string) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};

/**
 * Credential store confined to a durable-run state directory.
 * Rejects the global Pi agent directory (and anything below it) and any path naming `mcp-auth.json`,
 * so isolated runs can never read-modify-write the user's global credentials.
 */
export function createIsolatedCredentialStore(directory: string, env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const dir = resolve(directory);
  if (basename(dir) === 'mcp-auth.json' || globalPiDirs(env).some(g => inside(dir, g))) {
    throw new Error('pi-durable credentials must not live in the global Pi directory');
  }
  return createCredentialStore(dir);
}
