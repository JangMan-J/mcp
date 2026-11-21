import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { checksumDir, openSession, prepareScratchPi, resolver } from './pi-scratch.mjs';

const local = name => fileURLToPath(new URL(name, import.meta.url));
const prefix = 'mcp__trial__';
const expected = ['echo', 'needs_consent', 'secret_lookup', 'slow'].map(n => prefix + n);
const secret = prefix + 'secret_lookup';
const configs = {
  registration: {}, mcpCommand: {},
  exposure: {exposure: 'deferred', toolExposure: {secret_lookup: 'hidden'}},
  deferredSearch: {toolExposure: {secret_lookup: 'deferred'}},
};

async function check(opts, item) {
  const {session, extensionsResult, faux, fauxToolCall, fauxAssistantMessage} = await openSession(opts);
  const tools = () => session.getAllTools().filter(t => t.name.startsWith(prefix));
  const exposure = name => tools().find(t => t.name === name)?.exposure;
  async function waitForDirect(names) {
    const end = Date.now() + 5000;
    while (Date.now() < end && !names.every(n => exposure(n) === 'direct')) await delay(25);
    for (const n of names) assert.equal(exposure(n), 'direct', n);
  }
  async function call(name, args) {
    const start = session.messages.length;
    faux.setResponses([fauxAssistantMessage([fauxToolCall(name, args)]), fauxAssistantMessage('done')]);
    await session.prompt('go');
    const result = session.messages.slice(start).find(m => m.role === 'toolResult' && m.toolName === name);
    assert(result, `no result from ${name}`);
    const text = result.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    assert(!result.isError, text);
    return text;
  }
  try {
    assert.deepEqual(extensionsResult.errors, []);
    const owners = extensionsResult.extensions.filter(e => e.commands.has('mcp')).map(e => e.path);
    assert.deepEqual(owners, [local('./extension.ts')]);
    if (['exposure', 'deferredSearch'].includes(item)) {
      // Pi's search tool is opt-in; keep the same loadout plus search itself.
      session.setActiveToolsByName([...session.getActiveToolNames(), 'tool_search']);
    }
    if (item === 'registration') {
      await waitForDirect(expected);
      assert.match(await call(prefix + 'echo', {text: 'hi'}), /echo: hi/);
    } else if (item === 'mcpCommand') {
      const command = session.extensionRunner.getCommand('mcp');
      async function run(args) {
        const notices = [];
        await command.handler(args, {ui: {notify: msg => notices.push(msg)}});
        return notices.join('\n');
      }
      await waitForDirect(expected);
      for (const sub of ['list', 'status']) assert.match(await run(sub), /\btrial:/);
      await run('disable trial');
      assert(tools().every(t => t.exposure === 'hidden'), 'disabled tools still exposed');
      await run('enable trial');
      await waitForDirect(expected);
    } else if (item === 'exposure') {
      // Deferred tools are registered on discovery. Search before testing visibility.
      assert.match(await call('tool_search', {query: 'echo'}), /mcp__trial__echo/);
      assert.equal(exposure(prefix + 'echo'), 'deferred');
      assert(!(await call('tool_search', {query: 'secret_lookup'})).includes(secret));
      assert([undefined, 'hidden'].includes(exposure(secret)), 'hidden override was ignored');
    } else {
      await waitForDirect([prefix + 'echo']);
      assert(!session.getActiveToolNames().includes(secret));
      assert.match(await call('tool_search', {query: 'secret_lookup'}), /mcp__trial__secret_lookup/);
      assert.equal(exposure(secret), 'deferred');
      assert.match(await call(secret, {key: 'k'}), /found: k/);
    }
    return tools().map(t => t.name).sort();
  } finally {
    await session.extensionRunner.emit({type: 'session_shutdown', reason: 'quit'});
    await session.dispose();
  }
}

if (process.argv[2] === 'session') {
  console.log(JSON.stringify(await check(JSON.parse(process.argv[3]), process.argv[4])));
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'pi-trial-'));
  const active = join(homedir(), '.pi', 'agent');
  const report = {piRevision: null, pinned: null, items: Object.fromEntries(Object.keys(configs).map(k => [k, 'not run'])),
    toolNames: [], activeConfigUnchanged: false, concurrentSessionFilesChanged: null};
  let before;
  try {
    before = checksumDir(active);
    const opts = prepareScratchPi(scratch);
    Object.assign(report, {piRevision: opts.piRevision, pinned: opts.pinned});
    writeFileSync(join(opts.agentDir, 'settings.json'), JSON.stringify({extensions: [local('./extension.ts'), '-builtin:mcp']}));
    for (const [item, cfg] of Object.entries(configs)) {
      const trial = {command: process.execPath, args: [local('./server.mjs'), '--log', join(scratch, 'server.log')], ...cfg};
      writeFileSync(join(opts.agentDir, 'mcp.json'), JSON.stringify({mcpServers: {trial}}));
      try {
        const names = JSON.parse(execFileSync(process.execPath, ['--import', resolver(opts.pi), import.meta.filename, 'session', JSON.stringify(opts), item],
          {cwd: scratch, env: {...process.env, HOME: scratch, PI_CODING_AGENT_DIR: opts.agentDir, PI_CODING_AGENT_SESSION_DIR: join(scratch, 'sessions')}, encoding: 'utf8', timeout: 60000}));
        if (item === 'registration') report.toolNames = names;
        report.items[item] = 'pass';
      } catch (error) {
        report.items[item] = `fail: ${error.stderr?.trim() || error.message}`;
        process.exitCode = 1;
      }
    }
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    if (before) try {
      const after = checksumDir(active, scratch);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
      report.concurrentSessionFilesChanged = changed.filter(k => k.startsWith('sessions/')).length;
      report.activeConfigUnchanged = changed.length === report.concurrentSessionFilesChanged;
      assert(report.activeConfigUnchanged, 'active Pi files changed outside sessions/');
    } catch (error) { console.error(error); process.exitCode = 1; }
    if (process.env.PI_TRIAL_KEEP !== '1') rmSync(scratch, {recursive: true, force: true});
    else console.error('Retained scratch:', scratch);
    console.log(JSON.stringify(report));
  }
}
