import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadExchangeFiles } from '@mcp-client/fixtures';
import { runTierBHttpRedirectFixture, THIN_FIXTURES } from '../src/tier-b-http-redirect.js';

const owned = ['redirect-cross-origin-refused', 'stream-break-write-uncertain'].map(n => `http/${n}`);
const http = loadExchangeFiles(fileURLToPath(new URL('../../fixtures/exchanges/http/', import.meta.url)));

for (const id of owned) {
  it(id, async () => {
    const fixture = http.find(f => f.id === id)!;
    expect(fixture).toBeDefined();
    expect(THIN_FIXTURES[id]).toBeTruthy();
    expect(await runTierBHttpRedirectFixture(fixture)).toEqual({ id, ok: true });
    expect(fixture.mutants.length).toBeGreaterThan(0);
    for (const mutant of fixture.mutants) {
      expect(await runTierBHttpRedirectFixture(fixture, mutant)).toMatchObject({ id, mutant, ok: false, failure: 'assertion' });
    }
  });
}

it('ignores fixtures it does not own and does not count unknown mutants as kills', async () => {
  const other = http.find(f => !owned.includes(f.id));
  if (other) expect(await runTierBHttpRedirectFixture(other)).toBeUndefined();
  const fixture = http.find(f => f.id === owned[0])!;
  const result = await runTierBHttpRedirectFixture(fixture, 'unsupported');
  expect(result?.ok).toBe(false);
  expect(result).not.toHaveProperty('failure', 'assertion');
});
