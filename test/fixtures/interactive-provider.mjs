import assert from 'node:assert/strict';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export default async function provider(pi) {
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(process.env.PI_TEST_FAUX));
  const faux = fauxProvider({ provider: 'project-faux', models: [{ id: 'inherited' }] });
  let mode, nestedTask, capacityTask, checkedCatalog = false;
  pi.on('session_start', (_event, ctx) => { mode = ctx.mode; });
  const child = !!process.env.PI_SUBAGENT_ID;
  const respond = async (context, _options, _state, model) => {
    const last = context.messages.findLastIndex(m => m.role === 'user');
    const content = context.messages[last]?.content ?? '';
    const text = typeof content === 'string' ? content : content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    const results = context.messages.slice(last + 1).filter(m => m.role === 'toolResult');
    const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
    if (!child) {
      if (text.startsWith('HOST_NATIVE ') && !results.length) return call('subagent_cancel', JSON.parse(text.slice(12)));
      if (text.startsWith('HOST_CALL ') && !results.length) return fauxAssistantMessage(fauxToolCall('project_session', JSON.parse(text.slice(10))), { stopReason: 'toolUse' });
      return fauxAssistantMessage('COORDINATOR_NOTICE');
    }
    capacityTask ??= text.match(/TASK_CAPACITY_[12]|TASK_LIMIT_CHILD_[12]_[12]/)?.[0];
    if (capacityTask) {
      const specialist = capacityTask.startsWith('TASK_LIMIT_CHILD_');
      const round = capacityTask.match(/(?:CAPACITY_|CHILD_)([12])/)[1];
      const allResults = context.messages.filter(m => m.role === 'toolResult');
      assert.equal(model.id, 'inherited');
      assert.equal(process.cwd(), join(process.env.HOME, 'repo A'));
      assert.equal(pi.getActiveTools().includes('subagent'), !specialist);
      if (specialist) {
        assert(!pi.getActiveTools().some(name => ['bash', 'edit', 'write'].includes(name)), 'synthetic specialist must remain read-only');
        const number = capacityTask.at(-1);
        if (!allResults.length) return call('subagent', { agent: 'worker', name: 'forbidden-grandchild', task: 'FORBIDDEN' });
        const denied = allResults.find(r => r.toolName === 'subagent');
        assert.equal(denied?.isError, true, 'specialist spawn must be refused');
        writeFileSync(join(process.env.HOME, `no-delegation-${round}-${number}.json`), JSON.stringify({ pid: process.pid, result: denied }));
        const deadline = Date.now() + 60000;
        while (!existsSync(join(process.env.HOME, `release-capacity-${round}`))) {
          assert(Date.now() < deadline, 'capacity release timeout');
          await delay(25);
        }
        return call('read', { path: 'AGENTS.md' });
      }
      if (!checkedCatalog) {
        const instructions = JSON.stringify(context.messages.filter(m => m.role === 'system'));
        for (const skill of ['diagnose-root', 'enforce-first', 'edit-document', 'simple-english', 'security-review', 'elaborate-spec', 'grounded-citations']) {
          assert(instructions.includes(`SYNTHETIC_CATALOG_${skill}`), `named skill absent from discovery: ${skill}`);
          assert(!instructions.includes(`SYNTHETIC_BODY_${skill}`), `skill was auto-bootstrapped: ${skill}`);
        }
        assert(!instructions.includes('SYNTHETIC_CATALOG_not-authorized'), 'unlisted personal skill discovered');
        checkedCatalog = true;
      }
      const roundStart = context.messages.findLastIndex(m => m.role === 'user' && JSON.stringify(m.content).includes(`TASK_CAPACITY_${round}`));
      const current = context.messages.slice(roundStart + 1);
      const launches = current.filter(m => m.role === 'toolResult' && m.toolName === 'subagent');
      if (launches.length < 3) return call('subagent', {
        agent: ['scout', 'ui-verifier', 'worker'][launches.length], name: `limit-${round}-${launches.length + 1}`,
        cwd: process.cwd(), task: `TASK_LIMIT_CHILD_${round}_${launches.length + 1}`,
      });
      assert(launches.slice(0, 2).every(r => !r.isError), JSON.stringify(launches));
      assert.equal(launches[2].isError, true, 'third child admitted despite two-child parent limit');
      assert.match(launches[2].content.filter(c => c.type === 'text').map(c => c.text).join('\n'), /concurrent child limit reached \(2 active children for parent /i);
      writeFileSync(join(process.env.HOME, `capacity-${round}.json`), JSON.stringify({ pid: process.pid, children: launches.slice(0, 2).map(r => r.details), refusal: launches[2] }));
      const drained = [1, 2].every(number => current.some(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(c =>
        c.type === 'text' && c.text.startsWith(`Sub-agent "limit-${round}-${number}"`) && /turn limit reached.*incomplete/i.test(c.text))));
      return fauxAssistantMessage(drained ? 'incomplete: two children drained' : 'waiting for two children');
    }
    nestedTask ??= text.match(/TASK_NEST|TASK_SPECIALIST/)?.[0];
    if (process.env.PI_TEST_COORDINATOR && nestedTask) {
      const specialist = nestedTask === 'TASK_SPECIALIST';
      assert.equal(process.cwd(), join(process.env.HOME, 'repo A'));
      assert.equal(model.id, 'inherited');
      assert.equal(pi.getActiveTools().includes('subagent'), !specialist);
      if (specialist) {
        writeFileSync(join(process.env.HOME, 'specialist-ready'), String(process.pid));
        const deadline = Date.now() + 60000;
        while (!existsSync(join(process.env.HOME, 'release-specialist'))) {
          assert(Date.now() < deadline, 'specialist release timeout');
          await delay(25);
        }
        return call('read', { path: 'AGENTS.md' });
      }
      if (!context.messages.some(m => m.role === 'toolResult' && m.toolName === 'subagent')) return call('subagent', { agent: 'scout', name: 'review', cwd: process.cwd(), task: 'TASK_SPECIALIST' });
      assert(results.every(r => !r.isError), JSON.stringify(results));
      writeFileSync(join(process.env.HOME, 'coordinator-waiting'), 'waiting');
      const childResult = context.messages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c.type === 'text' && c.text.startsWith('Sub-agent "review"')));
      if (childResult) {
        writeFileSync(join(process.env.HOME, 'specialist-result.json'), JSON.stringify(childResult));
        assert.match(JSON.stringify(childResult), /turn limit|incomplete/i);
      }
      return fauxAssistantMessage(childResult ? 'TASK_NEST incomplete: child hit turn limit' : 'TASK_NEST waiting for child');
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
    assert(snapshot.active.includes('subagent'), 'project coordinator must have bounded delegation');
    if (task === 'TASK_A2') {
      assert(JSON.stringify(context).includes('TASK_A1'), 'resume lost context');
      assert(!JSON.stringify(context).includes('TASK_B1'), 'other repo leaked into context');
    }
    if (task === 'TASK_B1' && process.env.PI_TEST_COORDINATOR === 'cancel') {
      writeFileSync(join(process.env.HOME, 'project-b-ready'), String(process.pid));
      const deadline = Date.now() + 60000;
      while (!existsSync(join(process.env.HOME, 'release-project-b'))) {
        assert(Date.now() < deadline, 'independent project release timeout');
        await delay(25);
      }
    }
    if (task === 'TASK_A1') {
      writeFileSync(join(process.env.HOME, 'child-ready'), 'ready');
      const deadline = Date.now() + 15000;
      while (!existsSync(join(process.env.HOME, 'release-child'))) {
        assert(Date.now() < deadline, 'busy fixture release timeout');
        await delay(20);
      }
    }
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
