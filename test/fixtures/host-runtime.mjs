import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [host, native, source] = process.argv.slice(2);
let networkAttempts = 0;
const forbidden = () => { networkAttempts++; throw new Error('NETWORK_DISABLED'); };
globalThis.fetch = forbidden;
net.connect = net.createConnection = tls.connect = http.request = https.request = forbidden;
syncBuiltinESMExports();
const sdk = await import(pathToFileURL(path.join(host, 'dist/index.js')));
const ai = await import(pathToFileURL(path.join(host, 'node_modules/@earendil-works/pi-ai/dist/index.js')));
const home = process.env.HOME;
const coordinator = path.join(path.dirname(home), 'coordinator-link');
fs.symlinkSync(home, coordinator);
const agentDir = process.env.PI_CODING_AGENT_DIR;
fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
fs.symlinkSync(path.join(source, 'agents/project-worker.md'), path.join(agentDir, 'agents/project-worker.md'));
fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
fs.symlinkSync(source, path.join(agentDir, 'extensions/project-sessions'));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
  defaultProvider: 'project-fixture', defaultModel: 'fixture',
  packages: [native], extensions: [],
  defaultProjectTrust: 'no',
}));
fs.writeFileSync(path.join(agentDir, 'subagents.json'), JSON.stringify({ worktreeIsolation: false }));
const repoA = path.join(home, 'repo A'), repoB = path.join(home, 'repo B');
for (const [root, marker] of [[repoA, 'A_INSTRUCTIONS'], [repoB, 'B_INSTRUCTIONS']]) {
  fs.mkdirSync(root);
  execFileSync('git', ['init', '-q', root]);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), marker + '\n');
}
const requests = [], starts = [];
const loader = new sdk.DefaultResourceLoader({
  cwd: coordinator, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true,
  extensionFactories: [pi => {
    pi.events.on('subagents:started', data => starts.push(data.id));
    pi.registerProvider('project-fixture', {
      baseUrl: 'https://invalid.example', apiKey: 'offline-fixture', api: 'project-fixture',
      models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 200000,
        maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context) {
        const stream = ai.createAssistantMessageEventStream();
        const lastUser = context.messages.findLastIndex(m => m.role === 'user');
        const userContent = context.messages[lastUser]?.content ?? '';
        const text = typeof userContent === 'string' ? userContent : userContent.filter(c => c.type === 'text').map(c => c.text).join('\n');
        const task = text.match(/FIXTURE_TASK_[AB][123]/)?.[0];
        const results = context.messages.slice(lastUser + 1).filter(m => m.role === 'toolResult');
        let content = [{ type: 'text', text: 'COORDINATOR_NOTICE' }];
        if (text.startsWith('HOST_CALL ') && results.length === 0) {
          content = [{ type: 'toolCall', id: `host-${requests.length}-${Date.now()}`, name: 'project_session', arguments: JSON.parse(text.slice(10)) }];
        } else if (!text.startsWith('HOST_CALL ') && task && JSON.stringify(context).includes('You implement only the explicitly assigned task')) {
          requests.push(task);
          if (task === 'FIXTURE_TASK_A3') {
            assert(JSON.stringify(context.messages).includes('FIXTURE_TASK_A1'), 'first task context lost');
            assert(JSON.stringify(context.messages).includes('FIXTURE_TASK_A2'), 'second task context lost');
            assert(!JSON.stringify(context.messages).includes('FIXTURE_TASK_B1'), 'other repository task leaked into worker context');
          }
          assert(requests.length < 30, 'Unexpected fixture model loop');
          if (results.length === 0) content = [{ type: 'toolCall', id: `${task}-read`, name: 'read', arguments: { path: 'AGENTS.md' } }];
          else if (results.length === 1) content = [{ type: 'toolCall', id: `${task}-pwd`, name: 'bash', arguments: { command: 'pwd' } }];
          else if (results.length === 2) content = [{ type: 'toolCall', id: `${task}-write`, name: 'write', arguments: { path: 'proof.txt', content: task } }];
          else {
            assert(results.every(r => !r.isError), JSON.stringify(results));
            const root = task.includes('_A') ? repoA : repoB;
            assert(JSON.stringify(results[0]).includes(task.includes('_A') ? 'A_INSTRUCTIONS' : 'B_INSTRUCTIONS'));
            assert(JSON.stringify(results[1]).includes(root));
            content = [{ type: 'text', text: `${task} done in ${root}` }];
          }
        }
        const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: 'start', partial: message });
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
        return stream;
      },
    });
  }],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
let { session } = await sdk.createAgentSession({ cwd: coordinator, agentDir, resourceLoader: loader,
  sessionManager: sdk.SessionManager.inMemory(coordinator) });
try {
  await session.bindExtensions({ mode: 'rpc' });
  await session.setModel(session.modelRuntime.getModel('project-fixture', 'fixture'));
  assert.equal(session.model?.provider, 'project-fixture', JSON.stringify(session.model));
  const tool = session.getToolDefinition('project_session');
  assert(tool, 'project_session not registered by the official loader');
  const call = async args => {
    await session.prompt('HOST_CALL ' + JSON.stringify(args));
    const message = session.messages.findLast(m => m.role === 'toolResult' && m.toolName === 'project_session');
    assert(message, 'Expected project_session tool result');
    return message;
  };
  const blocked = await session.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'guard-write',
    toolName: 'write', input: { path: path.join(repoA, 'must-not-write.txt'), content: 'blocked' } });
  assert.equal(blocked?.block, true, 'external repository write was not redirected');
  const readAllowed = await session.extensionRunner.emitToolCall({ type: 'tool_call', toolCallId: 'guard-read',
    toolName: 'read', input: { path: path.join(repoA, 'AGENTS.md') } });
  assert.notEqual(readAllowed?.block, true, 'incidental read was blocked');
  const manager = globalThis[Symbol.for('pi-subagents:manager')];
  assert(manager, 'native subagent manager missing');
  const launch = async (root, task) => {
    const result = await call({ action: 'dispatch', path: root, task });
    assert(!result.isError, JSON.stringify(result));
    assert(result.details?.agentId, JSON.stringify(result));
    const liveManager = globalThis[Symbol.for('pi-subagents:manager')];
    await liveManager.waitForAll();
    const record = liveManager.getRecord(result.details.agentId);
    assert.equal(record?.status, 'completed', JSON.stringify({ error: record?.error, model: record?.session?.model, type: record?.type }));
    assert.equal(record.session.sessionManager.getCwd(), root);
    assert.match(record.result, new RegExp(task + ' done'));
    return result.details.agentId;
  };
  const first = await launch(repoA, 'FIXTURE_TASK_A1');
  const second = await launch(repoB, 'FIXTURE_TASK_B1');
  assert.notEqual(first, second);
  const repeated = await launch(repoA, 'FIXTURE_TASK_A2');
  assert.equal(first, repeated, 'idle repository worker was not reused');
  assert.equal(fs.readFileSync(path.join(repoA, 'proof.txt'), 'utf8'), 'FIXTURE_TASK_A2');
  assert.equal(fs.readFileSync(path.join(repoB, 'proof.txt'), 'utf8'), 'FIXTURE_TASK_B1');
  assert.equal(fs.existsSync(path.join(home, 'proof.txt')), false);
  assert.equal(session.sessionManager.getCwd(), coordinator);
  const result = await call({ action: 'result', path: repoA });
  assert(!result.isError, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), /FIXTURE_TASK_A2 done/);
  const listed = await call({ action: 'list' });
  assert.match(JSON.stringify(listed), /repo A/);
  assert.match(JSON.stringify(listed), /repo B/);
  const savedManager = session.sessionManager;
  const rebuild = async () => {
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
    session.dispose();
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await sdk.createAgentSession({ cwd: coordinator, agentDir, resourceLoader: loader, sessionManager: savedManager }));
    await session.bindExtensions({ mode: 'rpc' });
    await session.setModel(session.modelRuntime.getModel('project-fixture', 'fixture'));
  };
  await rebuild();
  assert.equal(globalThis[Symbol.for('pi-subagents:manager')].getRecord(first), undefined);
  const reopened = await launch(repoA, 'FIXTURE_TASK_A3');
  assert.equal(reopened, first, 'saved repository session was not reopened under the same ID');
  assert.equal(fs.readFileSync(path.join(repoA, 'proof.txt'), 'utf8'), 'FIXTURE_TASK_A3');
  assert.equal(fs.readFileSync(path.join(repoB, 'proof.txt'), 'utf8'), 'FIXTURE_TASK_B1');
  assert.equal(session.sessionManager.getCwd(), coordinator);

  const changedConfigRoot = path.join(home, 'changed-config-root');
  fs.mkdirSync(changedConfigRoot);
  fs.unlinkSync(coordinator); fs.symlinkSync(changedConfigRoot, coordinator);
  await rebuild();
  const beforeRetarget = starts.length;
  const retargeted = await call({ action: 'dispatch', path: repoA, task: 'FIXTURE_TASK_A3' });
  assert.equal(retargeted.isError, true, 'retargeted coordinator symlink accepted old worker');
  assert.equal(starts.length, beforeRetarget, 'retargeted config root started a worker');
  fs.unlinkSync(coordinator); fs.symlinkSync(home, coordinator);

  fs.unlinkSync(path.join(agentDir, 'agents/project-worker.md'));
  await rebuild();
  const repoC = path.join(home, 'repo C');
  fs.mkdirSync(repoC); execFileSync('git', ['init', '-q', repoC]);
  const startCount = starts.length;
  const refused = await call({ action: 'dispatch', path: repoC, task: 'FIXTURE_TASK_B1' });
  assert.equal(refused.isError, true, 'missing profile silently used fallback');
  assert.equal(starts.length, startCount, 'missing profile started a worker');
  assert.equal(networkAttempts, 0);
  console.log('PROJECT_HOST_OK: two repos, real read/bash/write, live and saved resume, unchanged coordinator cwd, missing-profile refusal, no network.');
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
