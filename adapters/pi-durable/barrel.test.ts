// The source barrel re-exports the host entry point. The built dist/index.js barrel is
// exercised with real Node module resolution by scripts/pi-trial/live-durable-check.mjs.
import { expect, it } from 'vitest';
import { startDurableMcpHost } from './index.js';
import { startDurableMcpHost as fromHost } from './host.js';

it('barrel exports startDurableMcpHost', () => {
  expect(startDurableMcpHost).toBe(fromHost);
});
