import { expect, it } from 'vitest';
import { ConfiguredBearer } from '../src/index.js';

it('binds a configured bearer to its MCP endpoint', async () => {
  const auth = new ConfiguredBearer({ resource: 'https://one.test/mcp', token: 'test-bearer' });
  expect((await auth.headerFor('https://one.test/mcp'))?.authorization).toBe('Bearer test-bearer');
  expect(await auth.headerFor('https://one.test/other')).toBeUndefined();
  expect(await auth.headerFor('https://two.test/mcp')).toBeUndefined();
});
