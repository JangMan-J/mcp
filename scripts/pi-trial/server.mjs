import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

const { values: { mode, log } } = parseArgs({ options: {
  mode: { type: 'string', default: 'main' }, log: { type: 'string' },
} });
if (!['main', 'crash'].includes(mode)) throw Error(`Unknown mode: ${mode}`);

function tool(name, properties, required = Object.keys(properties)) {
  return { name, inputSchema: { type: 'object', properties, required } };
}
const string = { type: 'string' };
const tools = mode === 'crash' ? [tool('write_record', { value: string })] : [
  tool('echo', { text: string }), tool('secret_lookup', { key: string }),
  tool('slow', { ms: { type: 'number', default: 60000 } }, []), tool('needs_consent', {}),
];
const version = '2026-07-28';
const cache = { ttlMs: 0, cacheScope: 'private' };
const timers = new Map();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('close', () => { for (const timer of timers.values()) clearTimeout(timer); });
lines.on('line', (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  if (log) appendFileSync(log, `${method}\n`);
  if (id === undefined) {
    if (method === 'notifications/cancelled') {
      clearTimeout(timers.get(params.requestId));
      timers.delete(params.requestId);
    }
    return;
  }
  const send = (body) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
  const complete = (value) => send({ result: { resultType: 'complete', ...value } });
  const text = (value) => complete({ content: [{ type: 'text', text: value }] });
  if (method === 'server/discover') return complete({ ...cache, supportedVersions: [version], capabilities: { tools: {} }, serverInfo: { name: 'pi-trial', version: '1' } });
  if (method === 'tools/list') return complete({ ...cache, tools });
  if (method !== 'tools/call') return send({ error: { code: -32601, message: 'Unknown method' } });
  if (mode === 'crash') process.exit(1);
  const args = params.arguments ?? {};
  switch (params.name) {
    case 'echo': return text(`echo: ${args.text}`);
    case 'secret_lookup': return text(`found: ${args.key}`);
    case 'slow':
      timers.set(id, setTimeout(() => { timers.delete(id); text('slow done'); }, args.ms ?? 60000));
      return;
    case 'needs_consent': {
      if (!params.inputResponses) return send({ result: {
        resultType: 'input_required', inputRequests: { consent: { method: 'elicitation/create', params: {
          mode: 'url', message: 'Approve this request?', url: 'https://consent.example.test/approve?id=1',
        } } },
      } });
      switch (params.inputResponses.consent?.action) {
        case 'accept': return text('consent accepted');
        case 'decline': return text('consent declined');
        case 'cancel': return text('consent cancelled');
        default: return send({ error: { code: -32602, message: 'Unknown consent action' } });
      }
    }
    default: return send({ error: { code: -32602, message: 'Unknown tool' } });
  }
});
