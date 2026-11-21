// Live Pi extension check against the installed @earendil-works/pi-coding-agent 1.6.0.
//   --self-test : real SDK discovery + DefaultResourceLoader with builtin extension
//                 factories in fresh TMPDIR scratch, plus fixture health. Needs no built entrypoint.
//   (default)   : run against the built adapter (`npm run build:pi-extension` first).
import assert from 'node:assert/strict';
import {execFile, execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import {findPackageJSON} from 'node:module';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';
import {checksumDir} from './pi-scratch.mjs';
import {EVENT, RESOURCE, SKILL, SKILL_FILE, TASK, fixtureHealth, startFixture} from './live-ext-fixture.mjs';

const PKG = '@earendil-works/pi-coding-agent', VERSION = '1.6.0';

// `which pi` -> follow wrapper symlinks -> walk up to node_modules/<PKG>. Fallback ~/pi (read-only).
export function discoverPi() {
  const tried = [];
  try {
    let dir = dirname(realpathSync(execFileSync('which', ['pi'], {encoding:'utf8'}).trim()));
    for (; dir !== dirname(dir); dir = dirname(dir)) {
      const pj = join(dir, 'node_modules', PKG, 'package.json');
      const own = join(dir, 'package.json');
      for (const p of [own, pj]) if (existsSync(p)) {
        tried.push(p);
        const j = JSON.parse(readFileSync(p, 'utf8'));
        if (j.name === PKG && j.version === VERSION) return {root:dirname(p), version:j.version, via:'which pi'};
      }
    }
  } catch (e) { tried.push(`which pi: ${e.message}`); }
  const fb = join(homedir(), 'pi', 'packages', 'coding-agent');
  if (existsSync(join(fb, 'package.json'))) {
    const j = JSON.parse(readFileSync(join(fb, 'package.json'), 'utf8'));
    if (j.name === PKG && j.version === VERSION && existsSync(join(fb, 'dist/index.js'))) return {root:fb, version:j.version, via:'~/pi fallback'};
  }
  throw new Error(`${PKG} ${VERSION} not found; tried ${tried.join(', ')}`);
}

// Child: runs with HOME/PI_CODING_AGENT_DIR/cwd inside scratch.
async function child(root, scratch, full) {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  assert.equal(realpathSync(agentDir), join(scratch, 'agent'), 'refusing non-scratch Pi config');
  assert.equal(process.env.HOME, scratch);
  assert.equal(process.cwd(), scratch);
  const sdk = await import(pathToFileURL(join(root, 'dist/index.js')));
  const {builtInExtensions} = await import(pathToFileURL(join(root, 'dist/extensions/index.js')));
  const settingsManager = sdk.SettingsManager.create(scratch, agentDir);
  const loader = new sdk.DefaultResourceLoader({cwd:scratch, agentDir, settingsManager, extensionFactories:builtInExtensions});
  await loader.reload();
  const ext = loader.getExtensions();
  assert.deepEqual(ext.errors, []);
  const paths = ext.extensions.map(e => e.path);
  if (!full) {
    assert(paths.includes('builtin:mcp'), `builtin:mcp missing from ${paths}`);
    assert(sdk.SessionManager.create(scratch, join(scratch, 'sessions')));
    return {extensions:paths};
  }
  const {entry, base} = full;
  assert(paths.includes(entry), `package entry ${entry} missing from ${paths}`);
  assert(!paths.includes('builtin:mcp'), 'package did not replace builtin:mcp');
  return {extensions:paths, steps:await liveSession(sdk, loader, settingsManager, scratch, agentDir, root, base)};
}

const FEATURES = ['package-replaces-builtin', 'commands', 'sign-in', 'tools/call', 'tools/search', 'codemode',
  'prompts list/get/complete', 'resources read+subscription wake', 'events glob/push/poll/cursor',
  'tasks call/update/elicitation', 'skills list/load/file'];

async function until(check, description) {
  for (const end = Date.now() + 3500; Date.now() < end; await sleep(40)) if (await check()) return;
  throw new Error(`timed out waiting for ${description}`);
}

async function liveSession(sdk, resourceLoader, settingsManager, cwd, agentDir, root, base) {
  const aiManifest = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(join(root, 'dist/index.js')));
  const {fauxProvider, fauxToolCall, fauxAssistantMessage} = await import(pathToFileURL(join(dirname(aiManifest), 'dist/providers/faux.js')));
  const faux = fauxProvider({provider:'pi-trial', api:'pi-trial-faux'});
  const modelRuntime = await sdk.ModelRuntime.create({authPath:join(agentDir, 'auth.json'), modelsPath:null, refreshOnCreate:false});
  modelRuntime.registerProvider(faux.provider.id, {api:faux.api, apiKey:'fixture-only', baseUrl:faux.getModel().baseUrl,
    models:faux.models, streamSimple:faux.provider.streamSimple});
  const sessionManager = sdk.SessionManager.inMemory(cwd);
  const {session} = await sdk.createAgentSession({cwd, agentDir, resourceLoader, settingsManager, modelRuntime,
    model:faux.getModel(), sessionManager});
  const messages = [], dialogs = [], errors = [], steps = {'package-replaces-builtin':'pass'};
  const inspect = async () => (await fetch(`${base}/inspect`, {signal:AbortSignal.timeout(1000)})).json();
  const bump = async kind => (await fetch(`${base}/bump?kind=${kind}`, {method:'POST', signal:AbortSignal.timeout(1000)})).json();
  const wire = async (method, predicate = () => true) => (await inspect()).calls.some(c => c.method === method && predicate(c.params));
  const contains = (value, expected) => assert(JSON.stringify(value).includes(expected), `expected ${expected} in ${JSON.stringify(value)}`);
  const waitOutput = (value, description = value) => until(() => JSON.stringify([messages, session.messages, sessionManager.getEntries()]).includes(value), description);
  const run = async (name, fn) => {
    // A hung step reports and the remaining steps still run.
    try { await Promise.race([fn(), sleep(8000, undefined, {ref:false}).then(() => { throw new Error('step timed out after 8s'); })]); steps[name] = 'pass'; }
    catch (e) { steps[name] = `fail: ${e.message.slice(0, 600)}`; }
    // Keep completed steps visible even if a later SDK call hangs and the child is killed.
    console.error(`${name}: ${steps[name]}`);
  };
  const tool = async (name, args) => {
    assert(session.getActiveToolNames().includes(name), `tool not active: ${name}`);
    const count = session.messages.length;
    faux.setResponses([fauxAssistantMessage([fauxToolCall(name, args)], {stopReason:'toolUse'}), fauxAssistantMessage('done')]);
    await session.prompt(`Run fixture operation ${name}`);
    const result = session.messages.slice(count).find(m => m.role === 'toolResult' && m.toolName === name);
    assert(result && !result.isError, `${name}: ${JSON.stringify(result?.content ?? 'no tool result')}`);
    return result;
  };
  const op = (name, action, args = {}) => tool(`mcp_${name}`, {action, server:'fixture', ...args});
  const command = async args => {
    assert(session.extensionRunner.getCommand('mcp'), '/mcp was not registered');
    const before = errors.length;
    await session.prompt(`/mcp ${args}`);
    assert.equal(errors.length, before, errors.at(-1));
  };
  try {
    await session.bindExtensions({mode:'rpc', onError:error => errors.push(String(error.error ?? error)), uiContext:{
      notify: message => messages.push(message),
      confirm: async title => (dialogs.push(title), true),
      select: async (title, options) => (dialogs.push(title), options.find(o => /accept|allow|yes/i.test(o)) ?? options[0]),
      input: async title => (dialogs.push(title), 'fixture reply'),
    }});
    await run('commands', async () => {
      await command('list');
      contains(messages, 'fixture');
    });
    await run('sign-in', async () => {
      await command('sign-in fixture');
      await until(() => wire('server/discover'), 'authenticated server discovery');
      assert((await inspect()).oauthExchanges === 1, 'expected one real OAuth token exchange');
    });
    await run('tools/call', async () => {
      await until(() => session.getActiveToolNames().includes('mcp__fixture__echo'), 'echo tool registration');
      contains(await tool('mcp__fixture__echo', {text:'direct fixture echo'}), 'direct fixture echo');
      assert(await wire('tools/call', p => p.name === 'echo' && p.arguments?.text === 'direct fixture echo'));
    });
    await run('tools/search', async () => {
      contains(await tool('tool_search', {query:'ask', namespace:'fixture'}), 'mcp__fixture__ask');
    });
    await run('codemode', async () => {
      contains(await tool('codemode', {code:'const r = await tools.mcp__fixture__echo({ text: "nested fixture echo" }); return r.content[0].text;'}), 'nested fixture echo');
      assert(await wire('tools/call', p => p.arguments?.text === 'nested fixture echo'));
    });
    await run('prompts list/get/complete', async () => {
      contains(await op('prompts', 'list'), 'greet');
      contains(await op('prompts', 'get', {name:'greet', arguments:{who:'live trial'}}), 'hello live trial');
      contains(await op('prompts', 'complete', {name:'greet', argument:'who', value:'wor'}), 'world');
    });
    await run('resources read+subscription wake', async () => {
      contains(await op('resources', 'read', {uri:RESOURCE}), 'fixture tick 0');
      await op('resources', 'subscribe', {uri:RESOURCE});
      await until(async () => (await inspect()).resources.includes(RESOURCE), 'resource listen stream');
      await bump('resource');
      await waitOutput(`Resource updated: ${RESOURCE}`);
      contains(await op('resources', 'read', {uri:RESOURCE}), 'fixture tick 1');
    });
    await run('events glob/push/poll/cursor', async () => {
      contains(await op('events', 'list'), EVENT);
      await until(async () => (await inspect()).streams > 0, 'configured glob push stream');
      await bump('event');
      await waitOutput(`event ${EVENT}`);
      const drain = await op('events', 'poll', {name:EVENT});
      contains(drain, 'fixture-event-1');
      assert(sessionManager.getEntries().some(e => e.customType === 'mcp-client/events-state' && e.data?.subs?.some(s => s.name === EVENT && s.cursor === '1')), 'accepted event cursor not persisted');
      const noReplay = await op('events', 'poll', {name:EVENT});
      assert(!JSON.stringify(noReplay).includes('fixture-event-1'), 'event replayed after cursor advancement');
    });
    await run('tasks call/update/elicitation', async () => {
      contains(await op('tasks', 'call', {tool:'ask', arguments:{}}), TASK);
      await until(() => wire('tasks/update', p => p.taskId === TASK && p.inputResponses?.answer?.content?.value === 'fixture reply'), 'task update with elicited input');
      contains(await op('tasks', 'get', {taskId:TASK}), 'task received fixture reply');
      assert(dialogs.some(s => /fixture answer/i.test(s)), 'form elicitation did not reach Pi UI');
    });
    await run('skills list/load/file', async () => {
      contains(await op('skills', 'list'), SKILL);
      contains(await op('skills', 'load', {skillUri:SKILL}), '"approved":true');
      contains(await op('skills', 'read_file', {skillUri:SKILL, fileUri:SKILL_FILE}), 'Fixture skill instructions');
    });
  } finally { await session.dispose(); }
  return steps;
}

function writeBrowserShim(bin, base) {
  // Production opens HTTPS only. Translate only the fixture URL, not arbitrary browser requests.
  writeFileSync(join(bin, 'xdg-open'), `#!${process.execPath}
const url = new URL(process.argv[2]);
if (process.argv.length !== 3 || url.origin !== ${JSON.stringify(base.replace(/^http:/, 'https:'))} || url.pathname !== '/authorize' || url.username || url.password) process.exit(1);
url.protocol = 'http:';
const signal = AbortSignal.timeout(5000);
const authorization = await fetch(url, {redirect:'manual', signal});
if (authorization.status !== 302) process.exit(1);
const callback = new URL(authorization.headers.get('location'));
const expected = new URL(url.searchParams.get('redirect_uri'));
if (callback.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) || callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.username || callback.password) process.exit(1);
if (!(await fetch(callback, {redirect:'manual', signal})).ok) process.exit(1);
`, {mode:0o700});
}

async function main() {
  if (process.argv[2] === '--child') {
    const data = await child(process.argv[3], process.argv[4], process.argv[5] && JSON.parse(process.argv[5]));
    console.log(JSON.stringify(data));
    return;
  }
  const selfTest = process.argv.includes('--self-test') || process.argv.includes('--probe');
  const active = join(homedir(), '.pi', 'agent');
  const report = {mode:selfTest ? 'self-test' : 'full', steps:selfTest ? {} : Object.fromEntries(FEATURES.map(f => [f, 'fail: not run']))};
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'pi-trial-live-')));
  // Live supervising Pi processes independently change transcripts and runtime state
  // (model cache, sqlite databases); exclude those, report them, and keep checking the configuration.
  const runtime = k => k.startsWith('sessions/') || k === 'models-store.json' || /\.sqlite(-shm|-wal|-journal)?$/.test(k);
  // The child is also traced (strace, when present) and must open nothing under the active dir.
  const sum = () => existsSync(active) ? checksumDir(active, scratch) : {};
  let fx, stage = 'checksumBefore';
  const before = sum();
  try {
    report.steps[stage] = 'pass';
    stage = 'discover';
    const pi = discoverPi();
    Object.assign(report, {pi});
    report.steps[stage] = 'pass';
    stage = 'fixture';
    fx = await startFixture();
    report.fixture = await fixtureHealth(fx);
    report.steps[stage] = 'pass';
    await fx.close(); fx = undefined;
    const agentDir = join(scratch, 'agent'), bin = join(scratch, 'bin');
    mkdirSync(agentDir); mkdirSync(bin);
    // Start with an empty environment: no active SDK overrides, user packages, API keys or proxies.
    const env = {HOME:scratch, TMPDIR:scratch, XDG_CONFIG_HOME:join(scratch, 'config'), XDG_CACHE_HOME:join(scratch, 'cache'),
      XDG_DATA_HOME:join(scratch, 'data'), PI_CODING_AGENT_DIR:agentDir, PI_CODING_AGENT_SESSION_DIR:join(scratch, 'sessions'),
      PATH:[bin, dirname(process.execPath), '/usr/bin', '/bin'].join(':'), LANG:'C.UTF-8'};
    const argv = [process.execPath, import.meta.filename, '--child', pi.root, scratch];
    if (!selfTest) {
      stage = 'package';
      const pkg = fileURLToPath(new URL('../../adapters/pi-coding-agent', import.meta.url));
      const manifest = join(pkg, 'package.json');
      assert(existsSync(manifest), 'adapter package missing; run npm run build:pi-extension in the integrated worktree');
      const declared = JSON.parse(readFileSync(manifest, 'utf8')).pi?.extensions;
      assert.equal(declared?.length, 1, 'expected a single adapter extension entry');
      const entry = resolve(pkg, declared[0]);
      assert(existsSync(entry), 'adapter entry missing; run npm run build:pi-extension');
      report.steps[stage] = 'pass';
      fx = await startFixture({browserShim:true});
      writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({packages:[pkg], defaultTools:['+codemode', '+tool_search']}));
      writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({mcpServers:{fixture:{url:fx.mcpUrl, timeout:4, exposure:'direct',
        oauth:{clientId:'pi'}, toolExposure:{ask:'deferred'}, subscribe:[{name:'jing.*'}]}}}));
      writeBrowserShim(bin, fx.base);
      argv.push(JSON.stringify({entry:realpathSync(entry), base:fx.base}));
    }
    stage = 'sdkLoader';
    const trace = join(scratch, 'strace.log');
    let strace; try { strace = execFileSync('which', ['strace'], {encoding:'utf8'}).trim(); } catch {}
    let out;
    try {
      ({stdout:out} = await promisify(execFile)(strace ?? argv[0], strace ? ['-f', '-qq', '--kill-on-exit', '-e', 'trace=%file', '-o', trace, ...argv] : argv.slice(1),
        {cwd:scratch, encoding:'utf8', timeout:45000, env}));
    } catch (e) {
      throw new Error(e.stderr?.trim() || e.message, {cause:e});
    } finally {
      if (strace && existsSync(trace)) {
        const hits = readFileSync(trace, 'utf8').split('\n').filter(l => l.includes(active) || l.includes(join(homedir(), 'pi') + '/') && !l.includes(pi.root));
        assert.deepEqual(hits, [], 'scratch child accessed active Pi paths');
        report.activePathAccess = 'none (strace)';
      } else {
        report.activePathAccess = 'unverified: strace unavailable or no trace';
        if (!selfTest) process.exitCode = 1;
      }
    }
    const result = JSON.parse(out.trim().split('\n').at(-1));
    report.extensions = result.extensions;
    report.steps[stage] = 'pass';
    Object.assign(report.steps, result.steps);
    if (Object.values(report.steps).some(status => status !== 'pass')) process.exitCode = 1;
  } catch (e) {
    report.steps[stage] = `fail: ${e.message}`; process.exitCode = 1;
  } finally {
    await fx?.close();
    try {
      const after = sum();
      const all = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
      report.concurrentRuntimeChanges = all.filter(runtime);
      assert.deepEqual(all.filter(k => !runtime(k)), [], 'user Pi config changed');
      report.steps.checksumAfter = 'pass';
    } catch (e) { report.steps.checksumAfter = `fail: ${e.message}`; process.exitCode = 1; }
    if (process.env.PI_TRIAL_KEEP === '1') report.scratch = scratch; else rmSync(scratch, {recursive:true, force:true});
    console.log(JSON.stringify(report, null, 1));
  }
}
await main();
