import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checksumDir, openSession, prepareScratchPi, resolver} from './pi-scratch.mjs';

const entry = fileURLToPath(new URL('./extension.ts', import.meta.url));
if (process.argv[2] === 'session') {
  const opts = JSON.parse(process.argv[3]);
  const {session, extensionsResult} = await openSession(opts);
  try {
    assert.deepEqual(extensionsResult.errors, []);
    const paths = extensionsResult.extensions.map(e => e.path);
    const expected = opts.rollback ? 'builtin:mcp' : entry;
    assert(!paths.includes(opts.rollback ? entry : 'builtin:mcp'));
    assert.deepEqual(extensionsResult.extensions.filter(e => e.commands.has('mcp')).map(e => e.path), [expected]);
    assert(session.extensionRunner.getCommand('mcp'));
  } finally { await session.dispose(); }
} else {
  const scratch = mkdtempSync(join(tmpdir(), 'pi-trial-'));
  const active = join(homedir(), '.pi', 'agent');
  const report = {piRevision:null, pinned:null, steps:{}};
  let before, stage = 'checksumBefore';
  try {
    before = checksumDir(active);
    report.steps[stage] = 'pass';
    stage = 'bootstrap';
    const opts = prepareScratchPi(scratch);
    Object.assign(report, {piRevision:opts.piRevision, pinned:opts.pinned});
    if (!opts.pinned) report.fallbackReason = opts.fallbackReason;
    const settings = join(opts.agentDir, 'settings.json');
    const auth = join(opts.agentDir, 'mcp-auth.json');
    const run = rollback => execFileSync(process.execPath, ['--import',resolver(opts.pi), import.meta.filename, 'session', JSON.stringify({...opts,rollback})],
      {cwd:scratch, env:{...process.env, HOME:scratch, PI_CODING_AGENT_DIR:opts.agentDir, PI_CODING_AGENT_SESSION_DIR:join(scratch,'sessions')}, stdio:['ignore','ignore','inherit'], timeout:60000});
    writeFileSync(join(opts.agentDir,'mcp.json'), '{"mcpServers":{}}');
    writeFileSync(settings, JSON.stringify({extensions:[entry, '-builtin:mcp']}));
    report.steps[stage] = 'pass';
    stage = 'adapter';
    run(false);
    report.steps[stage] = 'pass';
    stage = 'untouchedLegacyAuth';
    assert(!existsSync(auth));
    report.steps[stage] = 'pass';
    stage = 'rollback';
    writeFileSync(settings, '{}');
    run(true);
    report.steps[stage] = 'pass';
  } catch (error) {
    report.steps[stage] = `fail: ${error.message}`;
    process.exitCode = 1;
  } finally {
    if (before) try {
      const after = checksumDir(active, scratch);
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
      // Supervising Pi processes append to their own live transcripts. Report
      // those separately; no trial process uses the active session directory.
      report.concurrentSessionFilesChanged = changed.filter(k => k.startsWith('sessions/')).length;
      report.activeConfigUnchanged = Object.fromEntries(['settings.json','mcp.json','auth.json','mcp-auth.json','extensions/'].map(key =>
        [key, !changed.some(k => key.endsWith('/') ? k.startsWith(key) : k === key)]));
      assert(changed.length === report.concurrentSessionFilesChanged, 'active Pi files changed outside sessions/');
      report.steps.checksumAfter = 'pass';
    } catch (error) {report.steps.checksumAfter = `fail: ${error.message}`; process.exitCode = 1;}
    if (process.env.PI_TRIAL_KEEP === '1') report.scratch = scratch;
    else rmSync(scratch, {recursive:true, force:true});
    console.log(JSON.stringify(report));
  }
}
