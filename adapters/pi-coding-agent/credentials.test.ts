import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createCredentialStore } from './credentials.js';

it('persists adapter credentials without reading or changing legacy credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-credentials-'));
  try {
    const legacy = join(dir, 'mcp-auth.json');
    const original = Buffer.from('{"server":"legacy"}\n');
    await writeFile(legacy, original);
    const store = createCredentialStore(dir);
    expect(await store.get('server')).toBeUndefined();
    await Promise.all([store.set('server', 'adapter'), store.set('__proto__', 'second')]);
    const { mode } = await stat(join(dir, 'pi-mcp-client-credentials.json'));
    expect(mode & 0o077).toBe(0);
    const reopened = createCredentialStore(dir);
    expect(await reopened.get('server')).toBe('adapter');
    expect(await reopened.get('__proto__')).toBe('second');
    await reopened.delete('server');
    expect(await createCredentialStore(dir).get('server')).toBeUndefined();
    expect(await readFile(legacy)).toEqual(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
