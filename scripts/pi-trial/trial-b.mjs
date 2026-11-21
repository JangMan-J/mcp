// Scratch Pi cutover trial, items 5-8 (README "Manual scenarios").
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {checksumDir, openSession, prepareScratchPi, resolver} from './pi-scratch.mjs';

const entry = fileURLToPath(new URL('./extension.ts', import.meta.url));
const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
const BRANCH = 'pi.coding-agent.branch.v2';
const URL_ = 'https://consent.example.test/approve?id=1';

const resultText = m => (m.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const toolResults = session => session.messages.filter(m => m.role === 'toolResult');

async function child(item, opts) {
  const {SessionManager} = await import(pathToFileURL(join(opts.pi, 'packages/coding-agent/src/index.ts')));
  const sessionDir = join(opts.scratch, 'sessions');
  const sm = item === 'resume' ? SessionManager.open(opts.file, sessionDir)
    : item === 'fork' ? SessionManager.forkFrom(opts.file, opts.scratch, sessionDir)
    : SessionManager.create(opts.scratch, sessionDir);
  const {session, extensionsResult, faux, fauxAssistantMessage: say, fauxToolCall: call} = await openSession({...opts, sessionManager: sm});
  const out = {extensionErrors: extensionsResult.errors.map(e => String(e.error ?? e))};
  // Servers connect asynchronously after session_start; wait for their tools.
  for (const until = Date.now() + 20000; !session.getActiveToolNames().includes('mcp__flaky__write_record') || !session.getActiveToolNames().includes('mcp__trial__echo');) {
    if (Date.now() > until) throw new Error('MCP tools never registered: ' + session.getActiveToolNames());
    await sleep(50);
  }
  const turn = (name, args) => faux.setResponses([say([call(name, args)], {stopReason: 'toolUse'}), say('done')]);
  try {
    if (item === 'echo') {
      turn('mcp__trial__echo', {text: 'hi'});
      await session.prompt('echo');
    } else if (item === 'resume' || item === 'fork') {
      turn('mcp__trial__echo', {text: item});
      await session.prompt(item);
    } else if (item === 'abort') {
      turn('mcp__trial__slow', {ms: 60000});
      writeFileSync(opts.log, '');
      const started = Date.now();
      const p = session.prompt('slow');
      // Wait until the server has the call, then abort.
      while (!readFileSync(opts.log, 'utf8').split('\n').includes('tools/call')) {
        assert(Date.now() - started < 15000, 'slow call did not reach the server');
        await sleep(20);
      }
      const abortAt = Date.now();
      await session.abort();
      await p.catch(e => (out.promptError = String(e?.message ?? e)));
      out.turnMs = Date.now() - abortAt;
      out.countAfterAbort = sm.getEntries().length;
      await sleep(1500);
      out.countLater = sm.getEntries().length;
    } else if (item === 'write') {
      turn('mcp__flaky__write_record', {value: 'trial'});
      await session.prompt('write');
    } else if (item === 'consent') {
      turn('mcp__trial__needs_consent', {});
      await session.prompt('consent');
    }
    out.results = toolResults(session).map(m => ({tool: m.toolName, isError: m.isError, text: resultText(m)}));
    out.file = sm.getSessionFile();
    out.branchEntries = sm.getEntries().filter(e => e.customType === BRANCH).length;
  } finally { await session.dispose(); }
  console.log(JSON.stringify(out));
}

if (process.argv[2] === 'child') {
  await child(process.argv[3], JSON.parse(process.argv[4]));
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), 'pi-trial-'));
const active = join(homedir(), '.pi', 'agent');
const items = {branchForkResume: 'fail: not run', abortMidCall: 'fail: not run', uncertainWrite: 'fail: not run', urlConsent: 'fail: not run'};
const report = {piRevision: null, pinned: null, items, uncertainWriteText: null, activeConfigUnchanged: null, concurrentSessionFilesChanged: null};
let before;
try {
  before = checksumDir(active);
  const opts = prepareScratchPi(scratch);
  Object.assign(report, {piRevision: opts.piRevision, pinned: opts.pinned});
  if (!opts.pinned) report.fallbackReason = opts.fallbackReason;
  const log = join(scratch, 'server.log');
  const consentLog = join(scratch, 'consent.log');
  writeFileSync(log, '');
  writeFileSync(join(opts.agentDir, 'settings.json'), JSON.stringify({extensions: [entry, '-builtin:mcp']}));
  writeFileSync(join(opts.agentDir, 'mcp.json'), JSON.stringify({mcpServers: {
    trial: {command: process.execPath, args: [server, '--log', log]},
    flaky: {command: process.execPath, args: [server, '--mode', 'crash']},
  }}));
  const run = (item, extra = {}, env = {}) => JSON.parse(execFileSync(process.execPath,
    ['--import', resolver(opts.pi), import.meta.filename, 'child', item, JSON.stringify({...opts, log, ...extra})],
    {cwd: scratch, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 90000,
      env: {...process.env, ...env, HOME: scratch, PI_CODING_AGENT_DIR: opts.agentDir, PI_CODING_AGENT_SESSION_DIR: join(scratch, 'sessions')}})
    .trim().split('\n').at(-1));
  const attempt = async (key, fn) => {
    try { await fn(); items[key] = 'pass'; } catch (e) { items[key] = `fail: ${e.message}`; }
  };

  await attempt('branchForkResume', () => {
    const first = run('echo');
    report.branchDetail = {first};
    assert.deepEqual(first.extensionErrors, []);
    assert.equal(first.results[0]?.text, 'echo: hi', JSON.stringify(first.results));
    const fork = run('fork', {file: first.file});
    const resumed = run('resume', {file: first.file});
    Object.assign(report.branchDetail, {fork, resumed});
    assert.equal(fork.results.at(-1)?.text, 'echo: fork');
    assert.equal(resumed.results.at(-1)?.text, 'echo: resume');
    assert.notEqual(fork.file, first.file);
    assert.equal(resumed.file, first.file);
    for (const r of [fork, resumed]) assert.equal(r.results[0]?.text, 'echo: hi');
    assert(!resumed.results.some(r => r.text === 'echo: fork'), 'fork leaked into parent');
    const files = readdirSync(join(scratch, 'sessions'), {recursive: true}).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const text = readFileSync(join(scratch, 'sessions', f), 'utf8');
      for (const bad of ['Bearer', 'access_token', 'authorization']) assert(!text.includes(bad), `${f} contains ${bad}`);
    }
    // Ordinary echo calls persist tool results, not explicit saveBranch snapshots.
    assert.deepEqual([first, fork, resumed].map(r => r.branchEntries), [0, 0, 0]);
  });

  await attempt('abortMidCall', () => {
    const r = run('abort');
    report.abortDetail = r;
    assert(r.turnMs < 3000, `turn took ${r.turnMs}ms after abort`);
    assert(readFileSync(log, 'utf8').split('\n').includes('notifications/cancelled'), 'server never saw notifications/cancelled');
    assert.equal(r.countLater, r.countAfterAbort, 'entries appended after abort');
    assert(!r.results.some(x => x.text.includes('slow done')), 'late result reached the model');
  });

  await attempt('uncertainWrite', () => {
    const r = run('write');
    report.uncertainWriteText = r.results[0]?.text ?? null;
    assert(/may or may not have run/i.test(report.uncertainWriteText ?? ''), JSON.stringify(r.results));
  });

  await attempt('urlConsent', () => {
    const want = {accept: 'consent accepted', decline: 'consent declined', cancel: 'consent cancelled'};
    report.consentResults = {};
    for (const decision of Object.keys(want)) {
      const r = run('consent', {}, {PI_TRIAL_CONSENT: decision, PI_TRIAL_CONSENT_LOG: consentLog});
      report.consentResults[decision] = r.results[0]?.text ?? null;
    }
    const logged = existsSync(consentLog) ? readFileSync(consentLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    report.consentLog = logged;
    assert.deepEqual(logged.map(l => l.decision), Object.keys(want));
    assert(logged.every(l => JSON.stringify(l.prompt).includes(URL_)), 'full URL missing from consent prompt');
    for (const [d, text] of Object.entries(want)) assert.equal(report.consentResults[d], text);
  });
} catch (error) {
  report.error = error.message;
} finally {
  if (before) try {
    const after = checksumDir(active, scratch);
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
    report.concurrentSessionFilesChanged = changed.filter(k => k.startsWith('sessions/')).length;
    report.activeConfigUnchanged = changed.length === report.concurrentSessionFilesChanged;
  } catch (error) { report.activeConfigUnchanged = false; report.checksumError = error.message; }
  if (process.env.PI_TRIAL_KEEP === '1') report.scratch = scratch;
  else rmSync(scratch, {recursive: true, force: true});
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.activeConfigUnchanged && Object.values(items).every(v => v === 'pass') ? 0 : 1;
}
