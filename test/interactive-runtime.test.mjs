import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import extension from '../index.js';

const registryKey = Symbol.for('pi.subagents.tool-extension-registry');
const supportedCapabilities = Object.freeze({ version: 1, personalSkillCatalog: true, perParentChildLimit: true, persistedExtensionBindings: true, scopedExtensionProfiles: true });
function capabilities(t, marker = supportedCapabilities) {
  const previous = globalThis[registryKey];
  globalThis[registryKey] = Object.freeze({ capabilities: marker });
  t.after(() => { if (previous === undefined) delete globalThis[registryKey]; else globalThis[registryKey] = previous; });
}
const entryType = 'project-sessions:binding';
const tools = [
  { name: 'subagent', parameters: { properties: { agent: {}, name: {}, cwd: {}, task: {} } } },
  { name: 'subagent_status', parameters: { properties: { name: {} } } },
  { name: 'subagent_message', parameters: { properties: { name: {}, message: {}, resume_only: {}, expected_cwd: {}, expected_agent: {} } } },
];
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'project-interactive-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const roots = ['A', 'B'].map(name => join(dir, name));
  for (const root of roots) { mkdirSync(root); execFileSync('git', ['init', '-q', root]); }
  return { dir, roots, locks: join(dir, 'locks') };
}
function host(t, f, entries = [], session = 'parent') {
  const hooks = new Map(), listeners = new Map(), calls = [], workers = new Map();
  let tool;
  const bus = {
    on(name, fn) { const set = listeners.get(name) ?? new Set(); listeners.set(name, set); set.add(fn); return () => set.delete(fn); },
    emit(name, value) { calls.push([name, value]); for (const fn of listeners.get(name) ?? []) fn(value); },
  };
  const h = { entries, calls, workers, hooks, bus, metadata: tools };
  const ctx = { cwd: f.dir, sessionManager: { getSessionId: () => session, getBranch: () => entries },
    async executeTool(name, args) {
      calls.push([name, args]);
      if (h.intercept) { const value = await h.intercept(name, args); if (value) return value; }
      let details;
      if (name === 'subagent') {
        details = { id: `id-${workers.size}`, name: args.name, agent: args.agent, cwd: args.cwd,
          sessionFile: join(f.dir, `${workers.size}.jsonl`), status: 'started', capabilities: {} };
        workers.set(args.name, { ...details, status: 'running' });
      } else if (name === 'subagent_status') details = workers.get(args.name) ?? { status: 'unknown' };
      else if (name === 'subagent_message') {
        assert.equal(args.resume_only, true);
        assert.equal(args.expected_cwd, workers.get(args.name).cwd);
        assert.equal(args.expected_agent, 'project-worker');
        details = { ...workers.get(args.name), status: 'started' };
        workers.set(args.name, { ...details, status: 'running' });
      } else throw new Error(`Forbidden runtime call: ${name}`);
      return { isError: false, result: { content: [{ type: 'text', text: JSON.stringify(details) }], details } };
    },
  };
  extension({ events: bus, getAllTools: () => h.metadata, on: (name, fn) => hooks.set(name, fn),
    registerTool: value => { tool = value; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) },
  { lockDir: f.locks, timeoutMs: 10 });
  hooks.get('session_start')({}, ctx);
  h.ctx = ctx;
  h.run = args => tool.execute('call', args, undefined, undefined, ctx);
  h.dispatch = root => h.run({ action: 'dispatch', path: root, task: 'Bounded implementation. Run acceptance checks.' });
  h.shutdown = () => { hooks.get('session_shutdown')({}, ctx); bus.emit('interactive-subagents:disposed', {}); };
  t.after(h.shutdown);
  return h;
}

test('interactive contract: separate roots, owned results, busy refusal, restrictive resume and backend barrier', async t => {
  capabilities(t);
  const f = setup(t), h = host(t, f), [a, b] = f.roots;
  const first = await h.dispatch(a);
  assert.equal(first.details?.status, 'started', JSON.stringify(first));
  await h.dispatch(b);
  assert.equal(h.entries.length, 2);
  const binding = h.entries[0].data;
  assert.equal(binding.backend, 'interactive');
  assert.equal(binding.root, a);
  assert.equal(binding.id, first.details.agentId);
  assert(binding.sessionFile && binding.name);
  assert.notEqual(binding.name, h.entries[1].data.name);
  assert.equal((await h.dispatch(a)).details.status, 'busy');
  assert.equal(h.calls.filter(([name]) => name === 'subagent_message').length, 0);
  h.workers.get(binding.name).status = 'finished';
  h.workers.get(binding.name).result = 'OWNED_RESULT';
  const result = await h.run({ action: 'result', path: a });
  assert.match(JSON.stringify(result), /OWNED_RESULT/);
  assert.equal((await h.dispatch(a)).details.agentId, binding.id);
  assert.equal(h.calls.filter(([name]) => name === 'subagent_message').length, 1);
  assert(!h.calls.some(([name]) => /rpc:|^Agent$|get_subagent_result|sendMessage/.test(name)));
  const other = host(t, f, [], 'other');
  h.hooks.get('session_shutdown')({}, h.ctx);
  h.bus.emit('subagents:disposed', {});
  assert.equal((await other.dispatch(a)).isError, true);
  h.bus.emit('interactive-subagents:disposed', {});
  assert.equal((await other.dispatch(a)).details?.status, 'started');
});

test('interactive continuation fails closed for unknown, mismatched and legacy bindings without losing data', async t => {
  capabilities(t);
  for (const field of ['id', 'cwd', 'agent', 'sessionFile', 'status']) {
    const f = setup(t), h = host(t, f), root = f.roots[0];
    assert.equal((await h.dispatch(root)).isError, undefined);
    const binding = h.entries[0].data;
    h.workers.get(binding.name)[field] = 'unknown';
    assert.equal((await h.dispatch(root)).isError, true, field);
    assert.equal((await h.run({ action: 'result', path: root })).isError, true, field);
    assert.equal(h.calls.filter(([name]) => name === 'subagent_message').length, 0);
    assert.equal(h.calls.filter(([name]) => name === 'subagent').length, 1);
  }
  const f = setup(t), saved = { type: 'custom', customType: entryType, data: { root: f.roots[0], id: 'legacy-id' } };
  const h = host(t, f, [saved]);
  for (const action of ['dispatch', 'result']) {
    const refused = await h.run({ action, path: f.roots[0], task: 'bounded task' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /tintinweb|legacy/i);
  }
  assert.deepEqual(h.entries, [saved]);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.run({ action: 'list' })).details.records[0].backend, 'tintinweb');
});

test('interactive branch changes, uncertain launch and status/dispatch race never spawn a replacement', async t => {
  capabilities(t);
  for (const scenario of ['branch', 'uncertain', 'race']) {
    const f = setup(t), h = host(t, f), root = f.roots[0];
    if (scenario === 'uncertain') h.intercept = name => name === 'subagent' ? { isError: true, result: { content: [{ type: 'text', text: 'lost ack' }] } } : undefined;
    const first = await h.dispatch(root);
    if (scenario === 'uncertain') assert.equal(first.isError, true);
    else {
      const binding = h.entries[0].data;
      h.workers.get(binding.name).status = 'finished';
      h.intercept = name => {
        if (scenario === 'branch' && name === 'subagent_status') {
          h.entries.length = 0; h.hooks.get('session_tree')({}, h.ctx);
        }
        if (scenario === 'race' && name === 'subagent_message') return { isError: true, result: { content: [{ type: 'text', text: 'busy: no steering' }] } };
      };
    }
    assert.equal((await h.dispatch(root)).isError, true);
    assert.equal(h.calls.filter(([name]) => name === 'subagent').length, 1);
    if (scenario === 'branch') assert.equal(h.calls.filter(([name]) => name === 'subagent_message').length, 0);
  }
});

test('interactive tools without restrictive resume contract never fall back to the historical runtime', async t => {
  const f = setup(t), h = host(t, f);
  h.metadata = [{ name: 'subagent' }, { name: 'Agent' }, { name: 'get_subagent_result' }];
  const refused = await h.dispatch(f.roots[0]);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /upgrade|contract/i);
  assert.equal(h.calls.length, 0);
});

for (const [label, marker] of [
  ['absent', undefined], ['empty', {}], ['wrong version', { ...supportedCapabilities, version: 2 }],
  ...['personalSkillCatalog', 'perParentChildLimit', 'persistedExtensionBindings', 'scopedExtensionProfiles'].flatMap(key => [
    [`missing ${key}`, Object.fromEntries(Object.entries(supportedCapabilities).filter(([name]) => name !== key))],
    [`false ${key}`, { ...supportedCapabilities, [key]: false }],
    [`nonboolean ${key}`, { ...supportedCapabilities, [key]: 'true' }],
  ]),
]) test(`coordinator capability gate rejects ${label} before lease or native calls`, async t => {
  capabilities(t, marker);
  if (label === 'absent') delete globalThis[registryKey];
  const f = setup(t), h = host(t, f);
  const refused = await h.dispatch(f.roots[0]);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /upgrade.*restart/i);
  assert.equal(existsSync(f.locks), false, 'refusal created a lease directory');
  assert.equal(h.calls.length, 0);
  assert.equal(h.entries.length, 0);
});

test('capability gate is checked on resume, but owned historical results remain readable', async t => {
  capabilities(t);
  const f = setup(t), h = host(t, f), root = f.roots[0];
  assert.equal((await h.dispatch(root)).details.status, 'started');
  const saved = structuredClone(h.entries);
  const record = h.workers.get(saved[0].data.name);
  record.status = 'finished'; record.result = 'SAVED_RESULT';
  delete globalThis[registryKey];
  const before = h.calls.length;
  const refused = await h.dispatch(root);
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /upgrade.*restart/i);
  assert.equal(h.calls.length, before, 'unsafe resume queried or called the native runtime');
  assert.deepEqual(h.entries, saved);
  assert.match(JSON.stringify(await h.run({ action: 'result', path: root })), /SAVED_RESULT/);
  assert.equal((await h.run({ action: 'list' })).details.records.length, 1);
  globalThis[registryKey] = Object.freeze({ capabilities: supportedCapabilities });
  assert.equal((await h.dispatch(root)).details.agentId, saved[0].data.id);
});

test('complete marker does not authorize tintinweb dispatch, but its saved results stay readable', async t => {
  capabilities(t);
  const f = setup(t), saved = { type: 'custom', customType: entryType, data: { root: f.roots[0], id: 'historical' } };
  const h = host(t, f, [saved]);
  h.metadata = [{ name: 'Agent' }, { name: 'get_subagent_result' }];
  h.intercept = name => name === 'get_subagent_result' ? { isError: false, result: { content: [{ type: 'text', text: 'HISTORICAL_RESULT' }] } } : undefined;
  for (const root of f.roots) {
    assert.equal((await h.dispatch(root)).isError, true);
    assert.equal(existsSync(f.locks), false);
  }
  assert.equal(h.calls.length, 0);
  assert.match(JSON.stringify(await h.run({ action: 'result', path: f.roots[0] })), /HISTORICAL_RESULT/);
  assert.deepEqual(h.entries, [saved]);
});

test('saved interactive resume without marker refuses before acquiring any lease', async t => {
  capabilities(t, {});
  const f = setup(t);
  const saved = { type: 'custom', customType: entryType, data: { backend: 'interactive', root: f.roots[0], id: 'old', name: 'saved', sessionFile: join(f.dir, 'saved.jsonl') } };
  const h = host(t, f, [saved]);
  assert.equal((await h.dispatch(f.roots[0])).isError, true);
  assert.equal(existsSync(f.locks), false);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.entries, [saved]);
});

test('coordinator profile requires scoped parsing without broad tools or model override', () => {
  const profile = readFileSync(new URL('../agents/project-worker.md', import.meta.url), 'utf8').split('---')[1];
  assert.match(profile, /^extensions: scoped$/m);
  assert.match(profile, /^tools: read,grep,find,ls,bash,edit,write$/m);
  assert.match(profile, /^name: project-worker$/m);
  assert.match(profile, /^subagent_agents: scout,worker,reviewer,oracle,researcher,evidence-auditor,delegate,ui-verifier$/m);
  assert.match(profile, /^max_turns: 30$/m);
  assert(!/^model:/m.test(profile));
});
