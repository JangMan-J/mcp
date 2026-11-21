import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const pin = '7d80b45f62f8a8b8cd0f91a71d78ba56f229b1ec';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export const resolver = pi => pathToFileURL(join(pi, 'packages/coding-agent/src/experimental/source-resolver.ts')).href;

// Hash links themselves, never traverse a link out of the tree.
export function checksumDir(dir, forbiddenPath) {
  const hashes = Object.create(null);
  function walk(path) {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, e.name);
      if (e.isDirectory()) walk(file);
      else if (e.isFile() || e.isSymbolicLink()) {
        const bytes = e.isSymbolicLink() ? 'link:' + readlinkSync(file) : readFileSync(file);
        if (forbiddenPath && bytes.includes(forbiddenPath)) throw new Error('scratch path found in active Pi files');
        hashes[relative(dir, file)] = createHash('sha256').update(bytes).digest('hex');
      }
    }
  }
  walk(dir);
  return hashes;
}

function checkScratch(scratch) {
  if (dirname(realpathSync(scratch)) !== realpathSync(tmpdir()) || !/\/pi-trial-[\w-]+$/.test(scratch))
    throw new Error('expected a fresh pi-trial-* directory under TMPDIR');
}

export function prepareScratchPi(scratch) {
  checkScratch(scratch);
  const src = realpathSync(join(homedir(), 'pi'));
  const pi = join(scratch, 'pi');
  const agentDir = join(scratch, 'agent');
  mkdirSync(agentDir);
  function linkEntries(from, to) {
    mkdirSync(to);
    for (const e of readdirSync(from, {withFileTypes: true})) {
      const source = join(from, e.name), dest = join(to, e.name);
      if (e.name.startsWith('@') && e.isDirectory()) linkEntries(source, dest);
      else {
        const target = realpathSync(source);
        symlinkSync(target.startsWith(src + '/packages/') && !target.includes('/node_modules/') || target.startsWith(src + '/apps/')
          ? join(pi, relative(src, target)) : source, dest);
      }
    }
  }
  try {
    git('clone', '--quiet', '--shared', '--no-checkout', src, pi);
    git('-C', pi, 'checkout', '--quiet', pin);
    linkEntries(join(src, 'node_modules'), join(pi, 'node_modules'));
    for (const pkg of readdirSync(join(pi, 'packages'))) {
      const dir = join('packages', pkg, 'node_modules');
      if (existsSync(join(src, dir))) linkEntries(join(src, dir), join(pi, dir));
    }
    // The model catalog is generated, gitignored dependency data. Use the local
    // offline copy only if it passes the pinned validator; no HEAD code is copied.
    const data = 'packages/ai/src/providers/data';
    if (!existsSync(join(pi,data))) cpSync(join(src,data), join(pi,data), {recursive:true});
    execFileSync(process.execPath, [join(pi,'packages/ai/scripts/check-model-data.ts')], {cwd:pi, stdio:'pipe'});
    execFileSync(process.execPath, ['--import', resolver(pi), '--input-type=module', '-e', `import ${JSON.stringify(pathToFileURL(join(pi, 'packages/coding-agent/src/index.ts')).href)}`],
      {cwd:scratch, env:{...process.env, PI_CODING_AGENT_DIR:agentDir}, stdio:'pipe'});
    return {scratch, pi, agentDir, piRevision:git('-C', pi, 'rev-parse', 'HEAD'), pinned:true};
  } catch (error) {
    console.error('Pinned checkout unavailable offline:', error.message);
    return {scratch, pi:src, agentDir, piRevision:git('-C', src, 'rev-parse', 'HEAD'), pinned:false, fallbackReason:error.message};
  }
}

// Call inside a child launched with --import resolver(pi), with scratch as cwd.
export async function openSession({scratch, pi, agentDir, sessionManager, bindings = {}}) {
  checkScratch(scratch);
  if (realpathSync(agentDir) !== join(realpathSync(scratch), 'agent') || process.env.PI_CODING_AGENT_DIR !== agentDir)
    throw new Error('refusing non-scratch Pi config');
  const {createAgentSession, SessionManager, ModelRuntime, DefaultResourceLoader, SettingsManager} = await import(pathToFileURL(join(pi, 'packages/coding-agent/src/index.ts')));
  const {fauxProvider, fauxAssistantMessage, fauxToolCall} = await import(pathToFileURL(join(pi, 'packages/ai/src/index.ts')));
  const faux = fauxProvider({provider:'pi-trial', api:'pi-trial-faux'});
  const modelRuntime = await ModelRuntime.create({authPath:join(agentDir,'auth.json'), modelsPath:null, refreshOnCreate:false});
  modelRuntime.registerProvider(faux.provider.id, {api:faux.api, apiKey:'faux-key', baseUrl:faux.getModel().baseUrl, models:faux.models, streamSimple:faux.provider.streamSimple});
  // The SDK does not install the CLI's built-in extension factories by default.
  const {builtInExtensions} = await import(pathToFileURL(join(pi,'packages/coding-agent/src/extensions/index.ts')));
  const settingsManager = SettingsManager.create(scratch, agentDir);
  const resourceLoader = new DefaultResourceLoader({cwd:scratch, agentDir, settingsManager, extensionFactories:builtInExtensions});
  await resourceLoader.reload();
  const result = await createAgentSession({cwd:scratch, agentDir, modelRuntime, resourceLoader, settingsManager, model:faux.getModel(), sessionManager:sessionManager ?? SessionManager.inMemory(scratch)});
  await result.session.bindExtensions(bindings);
  return {...result, faux, fauxAssistantMessage, fauxToolCall};
}
