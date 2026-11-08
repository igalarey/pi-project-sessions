import './offline.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { LeaseStore } from '../../lib/local.mjs';
import provider from './interactive-provider.mjs';
import { setTimeout as delay } from 'node:timers/promises';

const [host, native, source, scenario] = process.argv.slice(2);
process.env.PI_TEST_COORDINATOR = scenario ?? '';
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
for (const name of ['scout', 'worker', 'reviewer', 'oracle', 'researcher', 'evidence-auditor', 'delegate', 'ui-verifier']) {
  fs.writeFileSync(path.join(agentDir, 'agents', `${name}.md`), `---\nname: ${name}\ntools: read\nextensions: scoped\nskills: false\nallowed_subagents: none\nauto-exit: true\nmax_turns: 2\n---\nOffline non-delegating specialist.\n`);
}
const skillNames = ['diagnose-root', 'enforce-first', 'edit-document', 'simple-english', 'security-review', 'elaborate-spec', 'grounded-citations'];
for (const name of [...skillNames, 'not-authorized']) {
  const dir = path.join(agentDir, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: SYNTHETIC_CATALOG_${name}\n---\nSYNTHETIC_BODY_${name}\n`);
}
const profile = fs.readFileSync(path.join(source, 'agents/project-worker.md'), 'utf8').split('---')[1];
assert.match(profile, /^subagent_agents: scout,worker,reviewer,oracle,researcher,evidence-auditor,delegate,ui-verifier$/m);
assert.equal(profile.match(/^skill_catalog: (.+)$/m)?.[1], skillNames.join(','));
assert(!/^skills:/m.test(profile), 'catalog must not conflict with skills:false or auto-bootstrap skills');
assert.match(profile, /^extensions: scoped$/m);
assert.match(profile, /^max_turns: 30$/m);
assert(!/^model:/m.test(profile), 'coordinator must inherit its model');
const config = path.join(home, 'runtime.json');
fs.writeFileSync(config, JSON.stringify({ delegation: { maxDepth: 2, maxConcurrentDescendants: 6, maxConcurrentChildren: 2, maxLaunchesPerLineage: null }, status: { enabled: false }, surfaceBackend: 'process', requireProfile: true, includeBundledAgents: false, allowProjectAgents: false, herdrViewer: { enabled: false } }));
process.env.PI_SUBAGENTS_CONFIG = config;
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'project-faux', defaultModel: 'inherited', defaultProjectTrust: 'no', packages: [] }));
const roots = ['repo A', 'repo B'].map(name => path.join(home, name));
for (const root of roots) {
  fs.mkdirSync(root); execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), `Fixture root ${root}\n`);
}
const notices = [], calls = [], waiters = new Set();
let disposed = 0, disposalCheck = () => {};
const loader = new sdk.DefaultResourceLoader({ cwd: home, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true,
  extensionFactories: [provider, pi => {
    pi.on('message_end', event => {
      if (event.message.customType === 'subagent_result') { notices.push(event.message); for (const notify of waiters) notify(); }
    });
    pi.on('tool_call', event => { calls.push({ name: event.toolName, input: event.input }); });
    pi.events.on('interactive-subagents:disposed', () => { disposalCheck(); disposed++; });
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
  if (scenario === 'capacity') {
    await capacityScenario();
    console.log('PROJECT_COORDINATOR_HOST_OK');
  } else if (scenario) {
    await coordinatorScenario();
    console.log('PROJECT_COORDINATOR_HOST_OK');
  } else {
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
  }
} finally {
  fs.writeFileSync(path.join(home, 'release-child'), 'release');
  fs.writeFileSync(path.join(home, 'release-specialist'), 'release');
  fs.writeFileSync(path.join(home, 'release-project-b'), 'release');
  for (const round of [1, 2]) fs.writeFileSync(path.join(home, `release-capacity-${round}`), 'release');
  await session.waitForIdle();
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}

async function coordinatorScenario() {
  const waitFile = async name => {
    const deadline = Date.now() + 20000;
    while (!fs.existsSync(path.join(home, name))) {
      assert(Date.now() < deadline, `Missing ${name}; records: ${fs.existsSync(path.join(home, 'requests.jsonl')) ? JSON.stringify(records()) : 'none'}`);
      await delay(25);
    }
  };
  assert.equal((await dispatch(roots[0], 'TASK_NEST')).details?.status, 'started');
  const a = binding(roots[0]);
  const loadout = JSON.parse(fs.readFileSync(`${a.sessionFile}.loadout.json`, 'utf8'));
  assert.deepEqual(loadout.spawnable, ['scout', 'worker', 'reviewer', 'oracle', 'researcher', 'evidence-auditor', 'delegate', 'ui-verifier']);
  await waitFile('specialist-ready');
  await waitFile('coordinator-waiting');
  const competitor = new LeaseStore(path.join(agentDir, 'project-sessions/locks'), 'competitor');
  assert.throws(() => competitor.acquire(roots[0]), /lease/i);
  assert.equal((await dispatch(roots[0], 'TASK_NEST')).details.status, 'busy');
  assert.equal((await dispatch(roots[1], 'TASK_B1')).details.status, 'started');
  if (scenario === 'cancel') await waitFile('project-b-ready');
  else await waitNotice(binding(roots[1]).name);
  assert(!notices.some(n => n.details?.name === a.name), 'coordinator exited before child drained');
  if (scenario === 'drain') {
    fs.writeFileSync(path.join(home, 'release-specialist'), 'release');
    const done = await waitNotice(a.name);
    assert.match(done.content, /incomplete/i);
    assert.match(fs.readFileSync(path.join(home, 'specialist-result.json'), 'utf8'), /turn limit|incomplete/i);
    assert.equal(notices.filter(n => n.details?.name === a.name).length, 1);
    assert.throws(() => competitor.acquire(roots[0]), /lease/i);
  } else {
    const pid = Number(fs.readFileSync(path.join(home, 'specialist-ready'), 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    disposalCheck = () => assert(!alive(), 'disposal event emitted while specialist still alive');
    if (scenario === 'cancel') {
      await session.waitForIdle();
      await session.prompt('HOST_NATIVE ' + JSON.stringify({ name: a.name }));
      await waitNotice(a.name);
      assert(!alive(), 'cancellation delivered completion while specialist still alive');
      assert.throws(() => competitor.acquire(roots[0]), /lease/i);
      const bPid = Number(fs.readFileSync(path.join(home, 'project-b-ready'), 'utf8'));
      assert.doesNotThrow(() => process.kill(bPid, 0), 'unrelated project killed by cancellation');
      assert(!notices.some(n => n.details?.name === binding(roots[1]).name));
      fs.writeFileSync(path.join(home, 'release-project-b'), 'release');
      assert.match((await waitNotice(binding(roots[1]).name)).content, /TASK_B1 complete/);
    }
    let premature = false;
    const monitor = setInterval(() => {
      try { competitor.acquire(roots[0]); if (alive()) premature = true; competitor.releaseAll(); } catch {}
    }, 5);
    try {
      await session.waitForIdle();
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      assert(!alive(), 'runtime disposal returned while specialist still alive');
      assert(!premature, 'repository lease released before specialist disposal');
      assert(disposed > 0);
      competitor.acquire(roots[0]); competitor.releaseAll();
    } finally { clearInterval(monitor); }
  }
}

async function capacityScenario() {
  let owned;
  const pids = [];
  for (const round of [1, 2]) {
    const from = notices.length;
    const started = await dispatch(roots[0], `TASK_CAPACITY_${round}`);
    assert.equal(started.details?.status, 'started', JSON.stringify(started));
    const current = binding(roots[0]);
    if (owned) assert.deepEqual(current, owned, 'resume changed the project binding');
    else owned = current;
    const deadline = Date.now() + 20000;
    const receipt = path.join(home, `capacity-${round}.json`);
    while (!fs.existsSync(receipt)) {
      assert(Date.now() < deadline, `No capacity refusal receipt for round ${round}: ${JSON.stringify(notices.slice(from))}`);
      await delay(25);
    }
    const evidence = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    assert.equal(evidence.refusal.isError, true);
    assert.match(evidence.refusal.content.filter(c => c.type === 'text').map(c => c.text).join('\n'), /concurrent child limit reached \(2 active children for parent /i);
    assert.equal(evidence.children.length, 2);
    pids.push(evidence.pid);
    assert.equal((await dispatch(roots[0], 'TASK_CAPACITY_1')).details.status, 'busy');
    assert(!notices.slice(from).some(n => n.details?.name === owned.name));
    for (const child of evidence.children) {
      const loadout = JSON.parse(fs.readFileSync(`${child.sessionFile}.loadout.json`, 'utf8'));
      assert.deepEqual(loadout.spawnable ?? [], []);
    }
    const descendantPids = [];
    for (const n of [1, 2]) {
      const file = path.join(home, `no-delegation-${round}-${n}.json`);
      while (!fs.existsSync(file)) {
        assert(Date.now() < deadline, `Specialist ${n} did not exercise delegation refusal`);
        await delay(25);
      }
      const denied = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(denied.result.isError, true, 'specialist delegated to a third level');
      descendantPids.push(denied.pid);
      assert.doesNotThrow(() => process.kill(denied.pid, 0));
    }
    fs.writeFileSync(path.join(home, `release-capacity-${round}`), 'release');
    const done = await waitNotice(owned.name, from);
    assert.match(done.content, /incomplete.*two children drained/i);
    assert.equal(notices.slice(from).filter(n => n.details?.name === owned.name).length, 1);
    for (const pid of descendantPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'completion arrived before descendants exited');
  }
  assert.notEqual(pids[0], pids[1], 'resume must run a new bounded process');
}
