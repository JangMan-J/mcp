import { appendFileSync } from 'node:fs';
import { createPiMcpExtension } from '../../adapters/pi-coding-agent/pi-extension.ts';

export default createPiMcpExtension({
  configDir: process.env.PI_CODING_AGENT_DIR!,
  consent: {
    async request(prompt, signal) {
      const decision = signal.aborted ? 'cancel' : process.env.PI_TRIAL_CONSENT ?? 'cancel';
      if (!['accept', 'decline', 'cancel'].includes(decision)) throw new Error('invalid PI_TRIAL_CONSENT');
      if (process.env.PI_TRIAL_CONSENT_LOG) appendFileSync(process.env.PI_TRIAL_CONSENT_LOG, JSON.stringify({prompt, decision}) + '\n');
      return { decision: decision as 'accept' | 'decline' | 'cancel' };
    },
  },
});
