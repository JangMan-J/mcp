import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadExchangeFiles } from '@mcp-client/fixtures';
import { runTierBAuthFixture } from '../src/tier-b-auth.js';

const auth = loadExchangeFiles(fileURLToPath(new URL('../../fixtures/exchanges/auth/', import.meta.url)));
for (const fixture of auth.filter(f => f.id.startsWith('auth/http-binding-'))) {
  it(fixture.id, async () => {
    expect(await runTierBAuthFixture(fixture)).toEqual({ id: fixture.id, ok: true });
    for (const mutant of fixture.mutants) {
      expect(await runTierBAuthFixture(fixture, mutant)).toMatchObject({ id: fixture.id, mutant, ok: false, failure: 'assertion' });
    }
  });
}
it('does not count unsupported mutants or malformed scripts as kills', async () => {
  const fixture = auth.find(f => f.id === 'auth/http-binding-401-retry')!;
  for (const result of [await runTierBAuthFixture(fixture, 'unsupported'),
    await runTierBAuthFixture({ ...fixture, script: [] }, fixture.mutants[0])]) {
    expect(result?.ok).toBe(false);
    expect(result).not.toHaveProperty('failure', 'assertion');
  }
  expect(await runTierBAuthFixture(auth.find(f => f.tier === 'A')!)).toBeUndefined();
});
