import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { loadExchangeFiles } from '@mcp-client/fixtures';
import { runTierBHttpSseFixture } from '../src/tier-b-http-sse.js';

const owned = [
  'sse-comment-keepalive', 'sse-id-retry-ignored', 'sse-multiline-data', 'sse-response-progress-then-final',
].map(n => `http/${n}`);
const http = loadExchangeFiles(fileURLToPath(new URL('../../fixtures/exchanges/http/', import.meta.url)));

for (const id of owned) {
  it(id, async () => {
    const fixture = http.find(f => f.id === id)!;
    expect(fixture).toBeDefined();
    expect(await runTierBHttpSseFixture(fixture)).toEqual({ id, ok: true });
    expect(fixture.mutants.length).toBeGreaterThan(0);
    for (const mutant of fixture.mutants) {
      expect(await runTierBHttpSseFixture(fixture, mutant)).toMatchObject({ id, mutant, ok: false, failure: 'assertion' });
    }
  });
}

it('ignores fixtures it does not own and does not count unknown mutants as kills', async () => {
  const other = http.find(f => !owned.includes(f.id));
  if (other) expect(await runTierBHttpSseFixture(other)).toBeUndefined();
  const fixture = http.find(f => f.id === owned[0])!;
  const result = await runTierBHttpSseFixture(fixture, 'unsupported');
  expect(result?.ok).toBe(false);
  expect(result).not.toHaveProperty('failure', 'assertion');
});
