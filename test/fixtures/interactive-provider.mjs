import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export default async function provider(pi) {
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(process.env.PI_TEST_FAUX));
  const faux = fauxProvider({ provider: 'project-faux', models: [{ id: 'inherited' }] });
  let mode;
  pi.on('session_start', (_event, ctx) => { mode = ctx.mode; });
  const child = !!process.env.PI_SUBAGENT_ID;
  const respond = async (context, _options, _state, model) => {
    const last = context.messages.findLastIndex(m => m.role === 'user');
    const content = context.messages[last]?.content ?? '';
    const text = typeof content === 'string' ? content : content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const results = context.messages.slice(last + 1).filter(m => m.role === 'toolResult');
    if (!child) {
      if (text.startsWith('HOST_CALL ') && !results.length) return fauxAssistantMessage(fauxToolCall('project_session', JSON.parse(text.slice(10))), { stopReason: 'toolUse' });
      return fauxAssistantMessage('COORDINATOR_NOTICE');
    }
    const task = text.match(/TASK_[AB][123]/)?.[0];
    assert(task, 'worker task marker missing');
    assert.equal(model.id, 'inherited');
    assert.equal(model.provider, 'project-faux');
    assert.equal(mode, 'tui');
    assert(process.stdin.isTTY && process.stdout.isTTY, 'child needs a process PTY');
    const root = join(process.env.HOME, task.includes('_A') ? 'repo A' : 'repo B');
    assert.equal(process.cwd(), root);
    const snapshot = { pid: process.pid, task, cwd: process.cwd(), model: model.id, mode, maxTurns: process.env.PI_SUBAGENT_MAX_TURNS,
      active: pi.getActiveTools(), context };
    appendFileSync(join(process.env.HOME, 'requests.jsonl'), JSON.stringify(snapshot) + '\n');
    assert.equal(snapshot.maxTurns, '30');
    assert(snapshot.active.includes('write'));
    assert(!snapshot.active.includes('subagent'));
    if (task === 'TASK_A2') {
      assert(JSON.stringify(context).includes('TASK_A1'), 'resume lost context');
      assert(!JSON.stringify(context).includes('TASK_B1'), 'other repo leaked into context');
    }
    if (task === 'TASK_A1') {
      writeFileSync(join(process.env.HOME, 'child-ready'), 'ready');
      const deadline = Date.now() + 15000;
      while (!existsSync(join(process.env.HOME, 'release-child'))) {
        assert(Date.now() < deadline, 'busy fixture release timeout');
        await delay(20);
      }
    }
    const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
    if (task === 'TASK_A3' || !results.length) return call('read', { path: 'AGENTS.md' });
    if (results.length === 1) return call('bash', { command: 'pwd' });
    if (results.length === 2) return call('write', { path: 'proof.txt', content: task });
    assert(results.every(r => !r.isError), JSON.stringify(results));
    assert(JSON.stringify(results[1]).includes(root));
    return fauxAssistantMessage(`${task} complete in ${root}`);
  };
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  pi.registerProvider(faux.provider);
}
