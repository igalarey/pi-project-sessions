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
        } else if (task && !text.startsWith('HOST_CALL ')) {
          assert.fail('Historical runtime must never launch the coordinator profile');
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
  for (const root of [repoA, repoB]) {
    const refused = await call({ action: 'dispatch', path: root, task: 'FIXTURE_TASK_A1' });
    assert.equal(refused.isError, true, JSON.stringify(refused));
    assert.match(JSON.stringify(refused.content), /upgrade.*restart/i);
  }
  assert.equal(starts.length, 0);
  assert.equal(fs.existsSync(path.join(agentDir, 'project-sessions/locks')), false);
  assert.equal(session.sessionManager.getCwd(), coordinator);
  assert.equal(networkAttempts, 0);
  console.log('PROJECT_HOST_OK: historical native backend refuses coordinator dispatch before lease or launch, write guard and read access preserved, no network.');
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  session.dispose();
}
