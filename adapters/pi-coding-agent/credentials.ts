import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CredentialStore } from '@mcp-client/core';

const filename = 'pi-mcp-client-credentials.json';

/** Use one writer instance per trusted config directory. */
export function createCredentialStore(directory: string): CredentialStore {
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
