import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import extension from '../index.js';
import { repositoryRoot, LeaseStore } from '../lib/local.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'project sessions '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo space'); mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  return { dir, repo, locks: join(dir, 'agent', 'project-sessions', 'locks') };
}
function host(f, session = 'coordinator', mode = 'ok') {
  const listeners = new Map(), hooks = new Map(), entries = [], records = new Map(), calls = [];
  const bus = { on(n, fn) { const set = listeners.get(n) ?? new Set(); listeners.set(n, set); set.add(fn); return () => set.delete(fn); }, emit(n, data) { calls.push([n, data]); for (const fn of [...(listeners.get(n) ?? [])]) fn(data); } };
  bus.on('subagents:rpc:ping', p => bus.emit(`subagents:rpc:ping:reply:${p.requestId}`, { success: true, data: { version: 2, capabilities: mode === 'legacy' ? undefined : mode === 'exact-only' ? ['exact-type'] : mode === 'resume-only' ? ['resume-cwd'] : ['exact-type', 'resume-cwd'] } }));
  bus.on('subagents:rpc:spawn', p => {
    if (mode === 'silent') return;
    records.set('worker-1', { status: 'running' }); p.options.onSpawned('worker-1');
    if (mode === 'late') return;
    bus.emit(`subagents:rpc:spawn:reply:${p.requestId}`, { success: true, data: { id: 'worker-1' } });
  });
  const ctx = { cwd: f.dir, sessionManager: { getSessionId: () => session, getBranch: () => entries }, async executeTool(name, args) { calls.push([name, args]); return { toolCall: { type: 'toolCall', id: `call/${calls.length}`, name, arguments: args }, result: ctx.nested ?? { content: [{ type: 'text', text: 'accepted' }], details: { agentId: args.resume, status: 'background' } }, isError: ctx.nestedError ?? false }; } };
  let tool;
  extension({ getAllTools: () => [{ name: 'Agent' }, { name: 'get_subagent_result' }], events: bus, on: (n, fn) => hooks.set(n, fn), registerTool: t => { tool = t; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) }, { lockDir: f.locks, timeoutMs: 30, getRecord: id => records.get(id) });
  hooks.get('session_start')({}, ctx);
  return { ctx, entries, records, calls, hooks, bus, run: (args, signal) => tool.execute('call', args, signal, undefined, ctx), shutdown() { hooks.get('session_shutdown')({}, ctx); bus.emit('subagents:disposed', {}); }, listeners };
}
const dispatch = path => ({ action: 'dispatch', path, task: 'Implement requested change; run acceptance checks.' });

test('canonical Git discovery handles prospective files, symlinks, worktrees and ignores redirects', async t => {
  const f = fixture(t), link = join(f.dir, 'link'); symlinkSync(f.repo, link);
  assert.equal(await repositoryRoot(join(link, 'new', 'file.txt')), f.repo);
  const old = process.env.GIT_DIR; process.env.GIT_DIR = '/invalid';
  try { assert.equal(await repositoryRoot(f.repo), f.repo); } finally { if (old === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = old; }
  await assert.rejects(repositoryRoot(f.dir), /Git/);
  execFileSync('git', ['-C', f.repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  const worktree = join(f.dir, 'worktree'); execFileSync('git', ['-C', f.repo, 'worktree', 'add', '-qb', 'other', worktree]);
  assert.equal(await repositoryRoot(worktree), worktree);
  const bare = join(f.dir, 'bare'); execFileSync('git', ['init', '--bare', '-q', bare]); await assert.rejects(repositoryRoot(bare), /Git/);
});

test('dispatch, busy, stable resume, result, branch ownership and native-only notification', async t => {
  const f = fixture(t), h = host(f); t.after(() => h.shutdown());
  const results = await Promise.all([h.run(dispatch(f.repo)), h.run(dispatch(f.repo))]);
  assert.equal(h.calls.filter(([n]) => n === 'subagents:rpc:spawn').length, 1);
  assert.ok(results.some(r => r.details?.status === 'busy'));
  const spawn = h.calls.find(([n]) => n === 'subagents:rpc:spawn')[1];
  assert.equal(spawn.options.cwd, f.repo); assert.equal(spawn.options.inheritContext, false); assert.equal(spawn.options.isBackground, true); assert.equal(spawn.options.signal, undefined); assert.equal(spawn.options.requireExactType, true);
  assert.deepEqual(h.entries[0].data, { root: f.repo, id: 'worker-1', backend: 'tintinweb' });
  h.records.set('worker-1', { status: 'completed' });
  assert.equal((await h.run(dispatch(f.repo))).details.status, 'background');
  assert.equal(h.calls.find(([n]) => n === 'Agent')[1].resume, 'worker-1');
  h.ctx.nested = { content: [{ type: 'text', text: 'cwd contract refused' }] };
  const refused = await h.run(dispatch(f.repo));
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /cwd contract refused/);
  assert.equal(h.calls.filter(([n]) => n === 'subagents:rpc:spawn').length, 1);
  h.ctx.nested = { content: [{ type: 'text', text: 'native error' }], details: { reason: 'blocked' } };
  h.ctx.nestedError = true;
  assert.deepEqual(await h.run(dispatch(f.repo)), { ...h.ctx.nested, isError: true });
  assert.deepEqual(await h.run({ action: 'result', path: f.repo }), { ...h.ctx.nested, isError: true });
  assert.equal(h.calls.find(([n]) => n === 'get_subagent_result')[1].agent_id, 'worker-1');
  assert.ok(!h.calls.some(([n]) => /consume|steer|stop/.test(n)));
  h.entries.length = 0; h.hooks.get('session_tree')({}, h.ctx);
  assert.equal((await h.run({ action: 'result', path: f.repo })).isError, true);
  assert.equal((await h.run(dispatch(f.repo))).isError, true);
});

test('native runtime without required capabilities fails closed before spawn', async t => {
  for (const mode of ['legacy', 'exact-only', 'resume-only']) {
    const f = fixture(t), h = host(f, 'coordinator', mode); t.after(() => h.shutdown());
    const refused = await h.run(dispatch(f.repo));
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /upgrade required/i);
    assert.equal(h.calls.filter(([n]) => n === 'subagents:rpc:spawn').length, 0);
    assert.equal(h.entries.length, 0);
    h.entries.push({ type: 'custom', customType: 'project-sessions:binding', data: { root: f.repo, id: 'saved-id' } });
    h.hooks.get('session_tree')({}, h.ctx);
    const resume = await h.run(dispatch(f.repo));
    assert.equal(resume.isError, true);
    assert.match(resume.content[0].text, /upgrade required/i);
    assert.equal(h.calls.filter(([n]) => n === 'Agent').length, 0);
  }
});

test('result unwraps native content and details rather than exposing the call outcome', async t => {
  const f = fixture(t), h = host(f); t.after(() => h.shutdown());
  await h.run(dispatch(f.repo));
  h.ctx.nested = { content: [{ type: 'text', text: 'verified work' }], details: { status: 'completed', agentId: 'worker-1' } };
  assert.deepEqual(await h.run({ action: 'result', path: f.repo }), { ...h.ctx.nested, isError: false });
});

test('same repo, invalid tasks and arbitrary overrides never launch', async t => {
  const f = fixture(t), h = host(f); t.after(() => h.shutdown());
  h.ctx.cwd = f.repo;
  assert.equal((await h.run(dispatch(f.repo))).isError, true);
  h.ctx.cwd = f.dir;
  for (const args of [{ ...dispatch(f.repo), task: ' ' }, { ...dispatch(f.repo), model: 'other' }, { ...dispatch(f.repo), task: 'a'.repeat(16001) }]) assert.equal((await h.run(args)).isError, true);
  assert.equal(h.calls.filter(([n]) => n === 'subagents:rpc:spawn').length, 0);
  const event = { systemPromptOptions: { promptGuidelines: [] } }; h.hooks.get('before_agent_start')(event, h.ctx);
  assert.match(event.systemPromptOptions.promptGuidelines.join(' '), /IMPLEMENTATION/);
});

test('proposed external edit/write is blocked without launching; reads, global files and local edits allowed', async t => {
  const f = fixture(t), h = host(f); t.after(() => h.shutdown());
  const hook = h.hooks.get('tool_call');
  assert.equal(typeof hook, 'function');
  for (const toolName of ['edit', 'write']) {
    const blocked = await hook({ toolName, input: { path: join(f.repo, 'new-file.txt') } }, h.ctx);
    assert.equal(blocked.block, true); assert.match(blocked.reason, /project_session/);
    assert.equal(await hook({ toolName, input: { path: join(f.dir, 'global-config') } }, h.ctx), undefined);
    h.ctx.cwd = f.repo;
    assert.equal(await hook({ toolName, input: { path: 'new-file.txt' } }, h.ctx), undefined);
    h.ctx.cwd = f.dir;
  }
  assert.equal(await hook({ toolName: 'read', input: { path: f.repo } }, h.ctx), undefined);
  assert.equal(h.calls.filter(([n]) => n === 'subagents:rpc:spawn').length, 0);
});

test('leases refuse other coordinators and corrupt owners, reclaim only dead owners', t => {
  const f = fixture(t), a = new LeaseStore(f.locks, 'a'), b = new LeaseStore(f.locks, 'b');
  a.acquire(f.repo); assert.throws(() => b.acquire(f.repo), /lease/i);
  a.releaseAll(); b.acquire(f.repo); b.releaseAll();
  const lock = a.path(f.repo); mkdirSync(lock); writeFileSync(join(lock, 'owner.json'), 'broken');
  assert.throws(() => a.acquire(f.repo), /lease/i);
  rmSync(lock, { recursive: true }); mkdirSync(lock);
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, session: 'dead', token: 'dead' }));
  a.acquire(f.repo); a.releaseAll();
});

test('spawn uncertainty stays reserved, callback retains id, abort does not kill detached work', async t => {
  for (const mode of ['late', 'silent']) {
    const f = fixture(t), h = host(f, mode, mode); t.after(() => h.shutdown());
    assert.equal((await h.run(dispatch(f.repo))).isError, true);
    await h.run(dispatch(f.repo));
    assert.equal(h.calls.filter(([n]) => n === 'subagents:rpc:spawn').length, 1);
    assert.equal(h.entries.length, mode === 'late' ? 1 : 0);
    assert.equal([...h.listeners].filter(([n, s]) => n.includes(':reply:') && s.size).length, 0);
  }
  const f = fixture(t), h = host(f); t.after(() => h.shutdown());
  const abort = new AbortController(); abort.abort();
  assert.equal((await h.run(dispatch(f.repo), abort.signal)).isError, true);
  assert.equal(h.calls.filter(([n]) => n === 'subagents:rpc:spawn').length, 0);
});

test('late spawn callback cannot bind a worker into a different coordinator branch', async t => {
  const f = fixture(t), h = host(f, 'coordinator', 'silent'); t.after(() => h.shutdown());
  await h.run(dispatch(f.repo));
  const spawn = h.calls.find(([n]) => n === 'subagents:rpc:spawn')[1];
  h.hooks.get('session_tree')({}, h.ctx);
  spawn.options.onSpawned('late-id');
  assert.equal(h.entries.length, 0);
  assert.equal((await h.run(dispatch(f.repo))).isError, true);
});

test('shutdown retains lease until native disposal; list bounded and branch rehydrated', async t => {
  const f = fixture(t), h = host(f), other = host(f, 'other'); t.after(() => other.shutdown());
  await h.run(dispatch(f.repo)); h.hooks.get('session_shutdown')({}, h.ctx);
  assert.equal((await other.run(dispatch(f.repo))).isError, true);
  h.bus.emit('subagents:disposed', {});
  assert.equal((await other.run(dispatch(f.repo))).details.status, 'background');
  other.entries.length = 0;
  for (let i = 0; i < 101; i++) other.entries.push({ type: 'custom', customType: 'project-sessions:binding', data: { root: `/repo/${i}`, id: `id-${i}` } });
  other.hooks.get('session_tree')({}, other.ctx);
  const list = await other.run({ action: 'list' }); assert.equal(list.details.records.length, 100); assert.equal(list.details.truncated, true);
});
