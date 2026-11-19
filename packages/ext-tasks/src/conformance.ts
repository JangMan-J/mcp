import { isDeepStrictEqual } from 'node:util';
import { McpClient, type ExchangeEnd, type Outcome, type Transport } from '@mcp-client/core';
import { createTasksExtension, MemoryTaskStore, TaskHandle, TASKS_ID, type TasksOptions } from './index.js';
import { object, type Obj } from './model.js';

export class ObservationMismatch extends Error {
  readonly isObservationMismatch = true as const;
  constructor(m: string) { super(m); this.name = 'ObservationMismatch'; }
}
const mutants = new Set(['tasks-ignore-interval','tasks-skip-consent','tasks-cancel-notification','tasks-drop-name',
  'tasks-force-peer','tasks-auto-register']);
export function supportsMutant(name: string) { return mutants.has(name); }
function malformed(): never { throw new Error('malformed tasks fixture'); }
export async function runExchange(fixture: unknown, mutant?: string): Promise<void> {
  if (mutant !== undefined && !supportsMutant(mutant)) throw new Error(`unknown tasks mutant: ${mutant}`);
  if (!object(fixture) || typeof fixture.id !== 'string' || !fixture.id.startsWith('ext/tasks/') ||
    !Array.isArray(fixture.script) || !fixture.script.length || !object(fixture.expect) || !Object.keys(fixture.expect).length) malformed();
  let reply: unknown, time = 0, forms = 0, peer: Obj = {extensions:{[TASKS_ID]:{}}};
  const calls: string[] = [], names: unknown[] = [], responses: unknown[] = [], outcomes: unknown[] = [], caps: unknown[] = [];
  const empty = {async *[Symbol.asyncIterator]() {}};
  const transport: Transport = {
    binding:'streamable-http', diagnostics:empty, async notify(n) { calls.push(n.method); }, async close() {},
    start(req,ctx) {
      calls.push(req.method); if (req.method.startsWith('tasks/')) names.push(ctx.headersHint?.name ?? null);
      if (req.params?.inputResponses) responses.push(JSON.parse(JSON.stringify(req.params.inputResponses)));
      const base = {jsonrpc:'2.0' as const,id:req.id};
      const end: ExchangeEnd = reply === 'break' ? {kind:'failure',failure:{kind:'stream-broken',message:'lost'},delivery:'maybe-delivered'} :
        reply === 'unknown' ? {kind:'response',message:{...base,error:{code:-32001,message:'unknown task'}}} :
        {kind:'response',message:{...base,result:object(reply) ? reply : {}}};
      return {notifications:empty,done:Promise.resolve(end)};
    },
  };
  const store = new MemoryTaskStore();
  const options: TasksOptions = {store, peerCapabilities:() => peer, force:mutant === 'tasks-force-peer',
    clock:{now:() => time,setTimeout(fn,ms) { time += mutant === 'tasks-ignore-interval' ? 0 : ms; queueMicrotask(fn); return () => {}; }},
    request:(m,p,o) => client.request(mutant === 'tasks-cancel-notification' && m === 'tasks/cancel' ? 'notifications/cancelled' : m,p,
      mutant === 'tasks-drop-name' ? {} : o),
    elicitation:{serverLabel:'test',port:{async form() { forms++; return {action:'decline'}; }}},
  };
  const client = new McpClient({transport,server:{key:'test'}});
  let ext = createTasksExtension(options), registration = client.use(ext), handle: TaskHandle | undefined;
  const observe = (out: Outcome<unknown>, value = false) => {
    outcomes.push(value && out.kind === 'ok' ? out.value : out.kind);
    if (out.kind === 'task-handle' && out.handle instanceof TaskHandle) handle = out.handle;
  };
  try {
    for (const step of fixture.script) {
      if (!object(step)) malformed(); reply = step.reply;
      switch (step.do) {
        case 'create': observe(await client.request('tools/call',{name:'test',arguments:{}})); break;
        case 'caps': caps.push(ext.capabilities(true), createTasksExtension({healthy:false}).capabilities(true)); break;
        case 'peer': if (!object(step.caps)) malformed(); peer = step.caps; break;
        case 'get': observe(await ext.resume('t').get()); break;
        case 'poll': if (!handle) malformed(); observe(await handle.poll(mutant === 'tasks-skip-consent' ? {q:{action:'decline'}} : undefined),true); break;
        case 'cancel': if (!handle) malformed(); observe(await handle.cancel()); break;
        case 'restart': registration.dispose(); ext = createTasksExtension(options); registration = client.use(ext); [handle] = ext.resumeAll(); break;
        case 'remove': if (mutant !== 'tasks-auto-register') registration.dispose(); break;
        case 'ordinary': observe(await client.request('tools/call',{name:'test'}),true); break;
        default: malformed();
      }
    }
  } finally { await client.close(); }
  const observed: Obj = {calls,names,responses,outcomes,time,forms,caps};
  for (const [k,v] of Object.entries(fixture.expect)) {
    if (!Object.hasOwn(observed,k) || (Array.isArray(observed[k]) ? !Array.isArray(v) : typeof v !== 'number')) malformed();
    if (!isDeepStrictEqual(observed[k],v)) throw new ObservationMismatch(`${fixture.id}: ${k} = ${JSON.stringify(observed[k])}, expected ${JSON.stringify(v)}`);
  }
}
