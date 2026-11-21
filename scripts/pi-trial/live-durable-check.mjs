// Run after npm run build:pi-durable; the durable runtime is loaded from disk, never installed here.
// --type-check checks SDK assignment only; --self-test probes the SDK without a built adapter.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {startFixture, EVENT, RESOURCE, SKILL, SKILL_FILE, TASK} from './live-ext-fixture.mjs';

const pkg = '@earendil-works/pi-durable';
function discover() {
  const roots = process.env.PI_DURABLE_DIR ? [resolve(process.env.PI_DURABLE_DIR)] : [
    resolve(import.meta.dirname, '../../node_modules', pkg), resolve(import.meta.dirname, '../../../cellar/node_modules', pkg),
    join(homedir(), 'Projects/cellar/node_modules', pkg), join(homedir(), 'pi/packages/durable')];
  for (const root of roots) {
    if (!existsSync(join(root, 'dist/index.js'))) continue;
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (manifest.name === pkg && manifest.version === '1.6.0') return realpathSync(root);
  }
  throw Error(`No built ${pkg}@1.6.0; checked ${roots.join(', ')}`);
}

async function withHarness(runtime, extensions, check) {
  const load = name => import(import.meta.resolve(`@earendil-works/${name}`, pathToFileURL(join(runtime, 'package.json')).href));
  const sdk = await import(pathToFileURL(join(runtime, 'dist/index.js')));
  const [{BACKGROUND_CONTEXT:ctx}, {createModels}, {fauxProvider, fauxAssistantMessage, fauxToolCall},
    {CodemodeSandbox}, {createCodemodeExtension}, {createToolSearchExtension}] = await Promise.all([
    'chord/context','pi-ai/models','pi-ai/providers/faux','pi-codemode','pi-durable/codemode','pi-durable/tool-search'].map(load));
  await sdk.createSession(new sdk.MemoryStorage()).close(ctx);
  const registry = sdk.createRegistry(), faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const sandbox = new CodemodeSandbox({memoryLimitBytes:256 * 1024 * 1024});
  let harness;
  try {
    for (const ext of [...extensions, createToolSearchExtension(), createCodemodeExtension({sandbox})]) registry.install(ext);
    harness = await sdk.Harness.open(new sdk.MemoryStorage(), {models, registry, settings:{}}, ctx);
    const root = await harness.root(ctx, {agent:{model:{provider:'faux', modelId:'faux-1'}}});
    let sequence = 0;
    const tool = async (name, args) => {
      const id = `check-${++sequence}`;
      faux.setResponses([fauxAssistantMessage([fauxToolCall(name,args,{id})], {stopReason:'toolUse'}), fauxAssistantMessage('done')]);
      await (await root.submit({type:'input', content:`exercise ${name}`}, ctx)).wait(ctx);
      const entries = (await root.entries({}, 1000, undefined, ctx)).items;
      const result = entries.flatMap(e => e.model ?? []).find(m => m.role === 'toolResult' && m.toolCallId === id);
      assert(result && !result.isError, `${name}: ${JSON.stringify(result ?? 'no result')}`);
      assert(Array.isArray(result.content));
      return result.content;
    };
    await check(tool, async () => (await root.agent(ctx)).tools.map(t => t.name));
  } finally { try { await harness?.close(ctx); } finally { await sandbox.close(); } }
}
const has = (v,s) => assert(JSON.stringify(v).includes(s), `expected ${s} in ${JSON.stringify(v)}`);
async function until(test, message) {
  for (const deadline = Date.now()+6000; Date.now()<deadline; await sleep(40)) if (await test()) return;
  throw Error(`timeout: ${message}`);
}

async function run(runtime, probe) {
  assert.equal(process.env.HOME, process.cwd());
  if (probe) return withHarness(runtime, [], async tool => has(await tool('codemode',{code:'return "probe-ok";'}),'probe-ok'));
  const {startDurableMcpHost} = await import('../../adapters/pi-durable/dist/index.js');
  const {DatabaseSync} = await import('node:sqlite');
  const fx = await startFixture(), deliveries = [], prompts = [];
  const inspect = async () => (await fetch(`${fx.base}/inspect`)).json();
  const mcpConfig = resolve('mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({mcpServers:{fixture:{url:fx.mcpUrl, timeout:4, exposure:'direct', oauth:{clientId:'pi'}, toolExposure:{ask:'deferred'}, subscribe:[{name:'jing.*'}]}}}));
  const opts = {mcpConfig, databasePath:resolve('host.sqlite'), stateDir:resolve('state'), skillsCacheDir:resolve('skills'),
    authorizationConsent:{request:async () => ({decision:'accept'})},
    browser:{async open(url,signal) {
      const target = new URL(url); assert.equal(target.origin,fx.base); assert.equal(target.pathname,'/authorize');
      const r = await fetch(url,{signal,redirect:'manual'}); assert.equal(r.status,302);
      const callback = new URL(r.headers.get('location')), expected = new URL(target.searchParams.get('redirect_uri'));
      assert.equal(callback.origin,expected.origin); assert.equal(callback.pathname,expected.pathname);
      assert.equal(callback.protocol,'http:'); assert(['127.0.0.1','localhost','[::1]'].includes(callback.hostname));
      assert((await fetch(callback,{signal,redirect:'manual'})).ok);
    }},
    consent:{async request(p) { prompts.push(p); return p.kind === 'form-elicitation' ? {decision:'accept', content:{value:'fixture reply'}} : {decision:'accept'}; }},
    deliver:async (...args) => {deliveries.push(args); return true;}};
  let host;
  const direct = 'mcp__fixture__echo', deferred = 'mcp__fixture__ask';
  try {
    host = await startDurableMcpHost(opts);
    await host.signIn('fixture', AbortSignal.timeout(8000));
    assert.equal((await inspect()).oauthExchanges,1);
    console.log('OAuth authorization code + PKCE: pass');
    await withHarness(runtime,host.extensions, async (tool,offered) => {
      assert((await offered()).includes(direct)); assert(!(await offered()).includes(deferred));
      assert.deepEqual(await tool(direct,{text:'direct echo'}),[{type:'text',text:'direct echo'}]);
      has(await tool('tool_search',{query:'ask'}),deferred); assert((await offered()).includes(deferred));
      has(await tool('codemode',{code:`const r = await tools.${direct}({text:"nested echo"}); return r.content[0].text;`}), 'nested echo');
      console.log('Harness direct + deferred search + codemode structured output: pass');
      const op = (name,action,args={}) => tool(`mcp_${name}`, {server:'fixture',action,...args});
      has(await op('prompts','list'),'greet'); has(await op('prompts','get',{name:'greet',arguments:{who:'durable'}}),'hello durable');
      has(await op('prompts','complete',{name:'greet',argument:'who',value:'wor'}),'world');
      has(await op('resources','read',{uri:RESOURCE}),'fixture tick 0'); await op('resources','subscribe',{uri:RESOURCE});
      await until(async () => (await inspect()).resources.includes(RESOURCE),'resource stream');
      fx.bump('resource'); await until(() => JSON.stringify(deliveries).includes(RESOURCE),'resource update');
      has(await op('resources','read',{uri:RESOURCE}),'fixture tick 1');
      has(await op('events','list'),EVENT); await until(async () => (await inspect()).streams>0,'glob stream');
      fx.bump('event'); await until(() => JSON.stringify(deliveries).includes(EVENT),'event wake');
      has(await op('events','poll',{name:EVENT}),'fixture-event-1');
      assert(!JSON.stringify(await op('events','poll',{name:EVENT})).includes('fixture-event-1'));
      console.log('prompts/resources/events: pass');
      has(await op('tasks','call',{tool:'ask',arguments:{}}),TASK);
      await until(async () => (await inspect()).calls.some(c => c.method==='tasks/update' && c.params.inputResponses?.answer?.content?.value==='fixture reply'),'task input response');
      has(await op('tasks','get',{taskId:TASK}),'task received fixture reply'); assert(prompts.some(p=>p.kind==='form-elicitation'));
      has(await op('skills','list'),SKILL); const loaded = await op('skills','load',{skillUri:SKILL});
      assert.equal(JSON.parse(loaded[0].text).approved,true);
      has(await op('skills','read_file',{skillUri:SKILL,fileUri:SKILL_FILE}),'Fixture skill instructions');
      console.log('tasks/skills: pass');
    });
    const args = {text:'reopen echo'}, key = 'trial-reopen', crashKey = 'trial-interrupted';
    const first = await host.call(key,direct,args);
    assert.deepEqual(first.output,[{type:'text',text:args.text}]); assert.deepEqual(first.structuredOutput.content,first.output);
    await host.call(crashKey,direct,args);
    const count = async () => (await inspect()).calls.filter(c=>c.method==='tools/call').length;
    const sends = await count(); await host.close(); host = undefined;
    // Recreate the crash window after a send but before the outcome commit in our scratch DB.
    const db = new DatabaseSync(opts.databasePath);
    try {
      assert.equal(db.prepare('SELECT cursor FROM subscription_cursors JOIN conversation_events USING (subscription) WHERE event_id=?').get('fixture-event-1')?.cursor,'1');
      assert.equal(db.prepare("UPDATE durable_calls SET status='intent',result_json=NULL WHERE key LIKE ? AND status='completed'").run(`%${crashKey}%`).changes,1);
    } finally { db.close(); }
    const preReopen = (await inspect()).calls.length;
    deliveries.length = 0;
    host = await startDurableMcpHost(opts);
    await host.signIn('fixture',AbortSignal.timeout(8000));
    await until(async () => (await inspect()).calls.slice(preReopen).some(c => ['events/stream','events/poll'].includes(c.method) && c.params.cursor==='1'), 'event resume at SQLite cursor');
    const poll = await host.call('resumed-poll','mcp_events',{action:'poll',server:'fixture',name:EVENT});
    assert(!poll.isError); assert(!JSON.stringify([poll,deliveries]).includes('fixture-event-1'),'old event replayed after reopen');
    assert.deepEqual(await host.call(key,direct,args),first);
    const uncertain = await host.call(crashKey,direct,args); assert(uncertain.isError); has(uncertain,'Uncertain write');
    assert.equal(await count(),sends);
    console.log('SQLite reopen/replay/interrupted write: pass');
  } finally { try { await host?.close(); } finally { await fx.close(); } }
}

function checkTypes(runtime, scratch, env) {
  const sdk = join(runtime, 'dist'), adapter = resolve(import.meta.dirname, '../../adapters/pi-durable/dist');
  assert(existsSync(join(sdk, 'index.d.ts')), `Missing SDK declarations: ${sdk}`);
  assert(existsSync(join(adapter, 'index.d.ts')), 'Missing adapter declarations; run npm run build:pi-durable');
  // NodeNext resolves these absolute .js specifiers to the adjacent .d.ts files.
  const source = join(scratch, 'sdk-assignment.mts');
  writeFileSync(source, `import { createRegistry } from ${JSON.stringify(join(sdk, 'index.js'))};
import type { DurableMcpHost } from ${JSON.stringify(join(adapter, 'index.js'))};
declare const host: DurableMcpHost;
for (const ext of host.extensions) createRegistry().install(ext);
`);
  const tsc = resolve(import.meta.dirname, '../../node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [tsc, '--noEmit', '--skipLibCheck', '--strict', '--module', 'nodenext', source],
    {stdio:'inherit', cwd:scratch, env, timeout:30000, killSignal:'SIGKILL'});
  if (result.error) throw result.error;
  if (result.status === 0) console.log('SDK extension assignment: pass');
  return result.status ?? 1;
}

if (process.argv[2] === '--child') {
  await run(process.argv[3],process.argv[4] === '--self-test');
} else {
  const root = discover(), scratch = realpathSync(mkdtempSync(join(tmpdir(),'pi-durable-trial-')));
  const env = {PATH:dirname(process.execPath),HOME:scratch,TMPDIR:scratch,
    XDG_CONFIG_HOME:scratch,XDG_CACHE_HOME:scratch,XDG_DATA_HOME:scratch,PI_CODING_AGENT_DIR:join(scratch,'agent')};
  console.log(`Using ${pkg}@1.6.0: ${root}`);
  try {
    if (process.argv[2] === '--type-check') process.exitCode = checkTypes(root, scratch, env);
    else {
      const r = spawnSync(process.execPath,['--experimental-import-meta-resolve',import.meta.filename,'--child',root,...process.argv.slice(2)],
        {stdio:'inherit', cwd:scratch, timeout:60000, killSignal:'SIGKILL', env});
      if (r.error) throw r.error;
      process.exitCode = r.status ?? 1;
    }
  } finally { rmSync(scratch,{recursive:true,force:true}); }
}
