import './offline.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LeaseStore } from '../../lib/local.mjs';
import provider from './interactive-provider.mjs';

const [host, native, source] = process.argv.slice(2);
const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
const home = process.env.HOME, agentDir = process.env.PI_CODING_AGENT_DIR;
const providerFile = path.join(source, 'test/fixtures/interactive-provider.mjs');
const quote = text => `'${text.replaceAll("'", "'\\''")}'`;
const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'pi'), `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(path.join(source, 'test/fixtures/offline.mjs'))} ${quote(path.join(host, 'dist/cli.js'))} "$@" -e ${quote(providerFile)}\n`, { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;
fs.mkdirSync(path.join(agentDir, 'extensions'));
fs.mkdirSync(path.join(agentDir, 'agents'));
fs.symlinkSync(source, path.join(agentDir, 'extensions/project-sessions'));
fs.symlinkSync(native, path.join(agentDir, 'extensions/interactive-subagents'));
fs.symlinkSync(path.join(source, 'agents/project-worker.md'), path.join(agentDir, 'agents/project-worker.md'));
const config = path.join(home, 'runtime.json');
fs.writeFileSync(config, JSON.stringify({ status: { enabled: false }, surfaceBackend: 'process', requireProfile: true, includeBundledAgents: false, allowProjectAgents: false, herdrViewer: { enabled: false } }));
process.env.PI_SUBAGENTS_CONFIG = config;
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'project-faux', defaultModel: 'inherited', defaultProjectTrust: 'no', packages: [] }));
const roots = ['repo A', 'repo B'].map(name => path.join(home, name));
for (const root of roots) {
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `Fixture root ${root}\n`);
}
const notices = [], calls = [], waiters = new Set();
let disposed = 0;
const loader = new sdk.DefaultResourceLoader({ cwd: home, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true,
  extensionFactories: [provider, pi => {
    pi.on('message_end', event => {
      if (event.message.customType === 'subagent_result') { notices.push(event.message); for (const notify of waiters) notify(); }
    });
    pi.on('tool_call', event => { calls.push({ name: event.toolName, input: event.input }); });
    pi.events.on('interactive-subagents:disposed', () => { disposed++; });
  }],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
let { session } = await sdk.createAgentSession({ cwd: home, agentDir, resourceLoader: loader, sessionManager: sdk.SessionManager.create(home) });
const bind = async () => { await session.bindExtensions({ mode: 'rpc' }); await session.setModel(session.modelRuntime.getModel('project-faux', 'inherited')); };
await bind();
const waitNotice = (name, from = 0) => {
  const existing = notices.slice(from).find(message => message.details?.name === name);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`No native completion for ${name}`)); }, 25000);
    const check = () => { const found = notices.slice(from).find(message => message.details?.name === name); if (found) { clearTimeout(timer); waiters.delete(check); resolve(found); } };
    waiters.add(check);
  });
};
const call = async args => {
  await session.waitForIdle();
  await session.prompt('HOST_CALL ' + JSON.stringify(args));
  const message = session.messages.findLast(m => m.role === 'toolResult' && m.toolName === 'project_session');
  assert(message, 'missing project tool response');
  return message;
};
const dispatch = (root, task) => call({ action: 'dispatch', path: root, task });
const binding = root => session.sessionManager.getBranch().findLast(entry => entry.customType === 'project-sessions:binding' && entry.data.root === root)?.data;
const records = () => fs.readFileSync(path.join(home, 'requests.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
try {
  assert(session.getToolDefinition('subagent_status'), 'native owned status contract is missing');
  assert(session.getToolDefinition('project_session'), 'automatic discovery failed');
  const first = await dispatch(roots[0], 'TASK_A1');
  assert.equal(first.details?.status, 'started', JSON.stringify(first));
  const a = binding(roots[0]);
  assert.equal(a.backend, 'interactive');
  const loadout = JSON.parse(fs.readFileSync(`${a.sessionFile}.loadout.json`, 'utf8'));
  assert.equal(loadout.maxTurns, 30);
  assert.equal(loadout.model, 'project-faux/inherited');
  assert.equal(loadout.cwd, roots[0]);
  const beforeBusy = calls.filter(c => c.name === 'subagent_message').length;
  assert.equal((await dispatch(roots[0], 'TASK_A2')).details.status, 'busy');
  assert.equal(calls.filter(c => c.name === 'subagent_message').length, beforeBusy);
  const bStart = await dispatch(roots[1], 'TASK_B1');
  assert.equal(bStart.details?.status, 'started', JSON.stringify(bStart));
  const b = binding(roots[1]);
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.name, b.name);
  fs.writeFileSync(path.join(home, 'release-child'), 'release');
  const [aDone, bDone] = await Promise.all([waitNotice(a.name), waitNotice(b.name)]);
  assert.match(aDone.content, /TASK_A1 complete/);
  assert.match(bDone.content, /TASK_B1 complete/);
  const offset = notices.length;
  const repeated = await dispatch(roots[0], 'TASK_A2');
  assert.equal(repeated.details?.agentId, a.id, JSON.stringify(repeated));
  await waitNotice(a.name, offset);
  assert.equal(binding(roots[0]).sessionFile, a.sessionFile);
  const r = records();
  assert.notEqual(r.find(x => x.task === 'TASK_A1').pid, r.find(x => x.task === 'TASK_A2').pid);
  assert.equal(fs.readFileSync(path.join(roots[0], 'proof.txt'), 'utf8'), 'TASK_A2');
  assert.equal(fs.readFileSync(path.join(roots[1], 'proof.txt'), 'utf8'), 'TASK_B1');
  const noticeCount = notices.length;
  const output = await call({ action: 'result', path: roots[0] });
  assert.equal(output.isError, false, JSON.stringify(output));
  assert.match(JSON.stringify(output), /TASK_A2 complete/);
  assert.equal(notices.length, noticeCount);
  assert.equal(session.sessionManager.getCwd(), home);
  assert(!calls.some(c => ['Agent', 'get_subagent_result'].includes(c.name)));

  const saved = session.sessionManager;
  const activeLeaf = saved.getLeafId();
  const beforeBindings = saved.getBranch().find(entry => entry.customType === 'project-sessions:binding');
  saved.branch(beforeBindings.parentId);
  await session.extensionRunner.emit({ type: 'session_tree', newLeafId: saved.getLeafId() });
  assert.equal((await call({ action: 'result', path: roots[0] })).isError, true);
  assert.equal((await dispatch(roots[0], 'TASK_A2')).isError, true);
  saved.branch(activeLeaf);
  await session.extensionRunner.emit({ type: 'session_tree', newLeafId: activeLeaf });
  const competing = new LeaseStore(path.join(agentDir, 'project-sessions/locks'), 'another-parent');
  assert.throws(() => competing.acquire(roots[0]), /lease/i);
  await session.waitForIdle();
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
  assert(disposed > 0, 'native disposal barrier missing');
  session.dispose();
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await sdk.createAgentSession({ cwd: home, agentDir, resourceLoader: loader, sessionManager: saved }));
  await bind();
  const afterRestart = notices.length;
  const cap = await dispatch(roots[0], 'TASK_A3');
  assert.equal(cap.details?.agentId, a.id, JSON.stringify(cap));
  const capped = await waitNotice(a.name, afterRestart);
  assert.match(JSON.stringify(capped), /turn limit|incomplete/i);
  assert.equal(records().filter(x => x.task === 'TASK_A3').length, 30);
  assert.equal(binding(roots[0]).sessionFile, a.sessionFile);
  const receiptPath = `${a.sessionFile}.result.json`;
  const receipt = fs.readFileSync(receiptPath);
  fs.unlinkSync(receiptPath);
  const beforeUnknown = calls.filter(c => c.name === 'subagent_message').length;
  const unknown = await dispatch(roots[0], 'TASK_A2');
  assert.equal(unknown.isError, true, JSON.stringify(unknown));
  assert.match(JSON.stringify(unknown), /unknown/i);
  assert.equal(calls.filter(c => c.name === 'subagent_message').length, beforeUnknown);
  fs.writeFileSync(receiptPath, receipt);
  assert.equal(fs.existsSync(path.join(home, 'proof.txt')), false);
  console.log('PROJECT_INTERACTIVE_HOST_OK: official SDK discovery, two repos, inherited faux model, native callback, busy no-message, same session/new PID, owned result, restart and 30-turn cap. Process PTY only; no Herdr dashboard control.');
} finally {
  fs.writeFileSync(path.join(home, 'release-child'), 'release');
  await session.waitForIdle();
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
