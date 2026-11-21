// Packaging smoke: a clean production build of the package barrel must export
// startDurableMcpHost (README imports it from dist/index.js).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, expect, it } from 'vitest';

const pkg = fileURLToPath(new URL('.', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'pi-durable-dist-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

it('production barrel exports startDurableMcpHost', async () => {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', out], { cwd: pkg, stdio: 'inherit' });
  const barrel = await import(pathToFileURL(join(out, 'index.js')).href);
  expect(typeof barrel.startDurableMcpHost).toBe('function');
}, 120_000);
