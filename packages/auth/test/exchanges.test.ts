import { readdirSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { runExchange } from '../dist/conformance.js';

const fixturesDir = new URL('../../fixtures/exchanges/auth/', import.meta.url);
for (const filename of readdirSync(fixturesDir).filter(name => name.endsWith('.exchange.json'))) {
  const fixture = JSON.parse(readFileSync(new URL(filename, fixturesDir), 'utf8'));
  it(fixture.id, async () => {
    await runExchange(fixture);
    for (const mutant of fixture.mutants) await expect(runExchange(fixture, mutant)).rejects.not.toThrow(/unknown auth/);
  });
}

it('rejects unknown exchange steps even after a passing assertion', async () => {
  await expect(runExchange({ script: [{ expect: 'header', value: null }, { do: 'unsupported' }] })).rejects.toThrow('unknown auth step');
  await expect(runExchange({ script: [{ do: 'advance', ms: 1 }] })).rejects.toThrow('no assertions');
  await expect(runExchange({ script: [{ expect: 'header', value: null }] }, 'unknown')).rejects.toThrow('unknown auth mutant');
});
