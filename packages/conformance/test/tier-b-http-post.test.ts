import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadExchangeFiles } from '@mcp-client/fixtures';
import { runTierBHttpPostFixture } from '../src/tier-b-http-post.js';

const owned = [
  '400-modern-error-vs-legacy', '5xx-write-uncertain', 'accept-both', 'header-mismatch-refresh-retry-once',
  'headers-base64-vectors', 'json-response', 'no-get-no-delete-no-session',
].map(n => `http/${n}`);
const http = loadExchangeFiles(fileURLToPath(new URL('../../fixtures/exchanges/http/', import.meta.url)));

for (const id of owned) {
  it(id, async () => {
    const fixture = http.find(f => f.id === id)!;
    expect(fixture).toBeDefined();
    expect(await runTierBHttpPostFixture(fixture)).toEqual({ id, ok: true });
    expect(fixture.mutants.length).toBeGreaterThan(0);
    for (const mutant of fixture.mutants) {
      expect(await runTierBHttpPostFixture(fixture, mutant)).toMatchObject({ id, mutant, ok: false, failure: 'assertion' });
    }
  });
}

it('ignores fixtures it does not own and does not count unknown mutants as kills', async () => {
  const other = http.find(f => !owned.includes(f.id));
  if (other) expect(await runTierBHttpPostFixture(other)).toBeUndefined();
  const fixture = http.find(f => f.id === owned[0])!;
  const result = await runTierBHttpPostFixture(fixture, 'unsupported');
  expect(result?.ok).toBe(false);
  expect(result).not.toHaveProperty('failure', 'assertion');
});
