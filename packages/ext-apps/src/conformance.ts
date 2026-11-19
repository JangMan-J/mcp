import { isDeepStrictEqual } from 'node:util';
import { McpClient, type Transport } from '@mcp-client/core';
import { createOps, isObj } from '@mcp-client/ops';
import { AppsClient, createAppsExtension, extractToolAppMeta, MCP_APP_MIME_TYPE, type AppViewPayload, type AppResourceMeta } from './index.js';

export class ObservationMismatch extends Error {
  readonly isObservationMismatch = true as const;
  constructor(message: string) { super(message); this.name = 'ObservationMismatch'; }
}
const mutants = new Set(['apps-always-advertise', 'apps-prefetch', 'apps-use-flat-key', 'apps-drop-policy', 'apps-ignore-mime', 'apps-bypass-consent', 'apps-strip-tool-meta']);
export const supportsMutant = (name: string) => mutants.has(name);
function observe(label: string, actual: unknown, expected: unknown) {
  if (!isDeepStrictEqual(actual, expected)) throw new ObservationMismatch(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const empty = { async *[Symbol.asyncIterator]() {} };
export async function runExchange(fixture: unknown, mutant?: string): Promise<void> {
  if (mutant && !supportsMutant(mutant)) throw new Error(`Unknown apps mutant: ${mutant}`);
  if (!isObj(fixture) || !Array.isArray(fixture['script']) || !isObj(fixture['expect'])) throw new Error('Invalid apps exchange');
  const steps = fixture['script'].filter(isObj);
  const wire: Record<string, number> = {};
  let reply: Record<string, unknown> = {};
  const transport: Transport = {
    binding: 'stdio', diagnostics: empty, async notify() {}, async close() {},
    start(msg) {
      wire[msg.method] = (wire[msg.method] ?? 0) + 1;
      return { notifications: empty, done: Promise.resolve({kind:'response', message:{jsonrpc:'2.0', id:msg.id, result:reply}}) };
    },
  };
  const server = fixture['server'];
  const capabilities = isObj(server) && isObj(server['capabilities']) ? server['capabilities'] : {};
  const ops = createOps(new McpClient({transport,server:{key:'example'}}), {capabilities});
  const rendered: AppViewPayload[] = [];
  const renderer = { render(view: AppViewPayload) {
    rendered.push(mutant === 'apps-drop-policy' ? {...view, csp: undefined} : view);
  } };
  const apps = new AppsClient({ ops, renderer, serverLabel: 'example' });
  const outcomes: Record<string, unknown> = {};
  let meta: AppResourceMeta | undefined;
  for (const step of steps) {
    if (step['do'] !== 'call') continue;
    const label = String(step['as']);
    const params = isObj(step['params']) ? step['params'] : {};
    const result = steps.find(s => s['for'] === label && s['server'] === 'result')?.['result'];
    reply = isObj(result) ? structuredClone(result) : {};
    switch (step['method']) {
      case 'apps/capabilities':
        outcomes[label] = createAppsExtension({renderer, healthy: mutant === 'apps-always-advertise' || params['healthy'] === true}).capabilities(true);
        break;
      case 'tools/list':
      case 'apps/list': {
        const list = await (step['method'] === 'apps/list' ? apps.listTools() : ops.tools.list());
        if (list.kind !== 'ok') { outcomes[label] = list.kind; break; }
        if (step['method'] === 'tools/list') {
          outcomes[label] = mutant === 'apps-strip-tool-meta' ? undefined : list.value.tools[0]?.tool['_meta'];
        } else {
          const entries = list.value.tools.map(({tool}) => {
            const nested = extractToolAppMeta(tool);
            const raw = tool['_meta'];
            const flat = isObj(raw) ? raw['ui/resourceUri'] : undefined;
            return nested ?? (mutant === 'apps-use-flat-key' && typeof flat === 'string' ? {resourceUri:flat} : undefined);
          });
          meta = entries[0];
          outcomes[label] = entries.map(m => m?.resourceUri ?? null);
          if (mutant === 'apps-prefetch' && meta) await ops.resources.read(meta.resourceUri);
        }
        break;
      }
      case 'apps/load': {
        if (!meta) throw new ObservationMismatch('No surfaced resource');
        if (mutant === 'apps-ignore-mime' && Array.isArray(reply['contents'])) {
          for (const item of reply['contents']) if (isObj(item)) item['mimeType'] = MCP_APP_MIME_TYPE;
        }
        const out = await apps.loadAppResource(meta);
        outcomes[label] = {kind:out.kind, ...('detail' in out ? {detail:out.detail} : {}), rendered:rendered.splice(0)};
        break;
      }
      case 'apps/call':
      case 'tools/call': {
        const prompts: string[] = [];
        const decision = params['decision'];
        const app = new AppsClient({ops, serverLabel:'example', ...(decision === 'accept' || decision === 'decline' ? {consent:{async request(p) {
          prompts.push(`${p.kind}@${p.serverLabel}`); return {decision};
        }}} : {})});
        const fromApp = step['method'] === 'apps/call';
        const name = String(params['name']);
        const out = fromApp && mutant !== 'apps-bypass-consent' ? await app.callToolFromApp(name,{}) : await ops.tools.call(name,{});
        outcomes[label] = {...(out.kind === 'ok' ? {content:out.value.raw['content']} : {kind:out.kind}), ...(fromApp ? {prompts} : {})};
        break;
      }
      default: throw new Error(`Unknown apps exchange method: ${step['method']}`);
    }
  }
  observe('outcome', outcomes, fixture['expect']['outcome']);
  const expectedWire = fixture['expect']['wire'];
  if (isObj(expectedWire)) observe('wire count', wire, expectedWire['count']);
}
