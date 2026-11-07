import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { repositoryRoot, LeaseStore } from './lib/local.mjs';

const ENTRY = 'project-sessions:binding';
const guidance = 'Delegate concrete IMPLEMENTATION in external Git repositories via project_session with an explicit brief, user-authorized scope and acceptance checks; do not execute those changes locally. Incidental reads and repository mentions are not tasks and must not launch workers. After root detection, use the shared todo -p <root> list, not the coordinator home list. Delegation does not expand ownership or permissions. Native background completion notifications are the sole automatic delivery; do not poll.';
const result = details => ({ content: [{ type: 'text', text: JSON.stringify(details) }], details });
const failure = message => ({ isError: true, content: [{ type: 'text', text: message }] });

export default function projectSessions(pi, options = {}) {
  const bindings = new Map(), reserved = new Set(), pending = new Set(), waits = new Set();
  const stores = new Map();
  let session, backend, branchEpoch = 0, closing = false;
  const disposed = new Set();
  function selectBackend() {
    const tools = pi.getAllTools();
    const has = name => tools.some(tool => tool.name === name);
    const selected = ['subagent', 'subagent_status', 'subagent_message'].some(has) ? 'interactive' : has('Agent') && has('get_subagent_result') ? 'tintinweb' : undefined;
    if (!selected) throw new Error('No supported native runtime is available. No fallback worker will be launched.');
    if (backend && backend !== selected) throw new Error('Native backend changed. Reload before dispatch.');
    if (selected === 'interactive') {
      const properties = tools.find(tool => tool.name === 'subagent_message')?.parameters?.properties;
      if (!has('subagent') || !has('subagent_status') || !['resume_only', 'expected_cwd', 'expected_agent'].every(key => properties && key in properties)) {
        throw new Error('Interactive runtime upgrade required: owned status and restrictive resume contract are missing. No fallback worker will be launched.');
      }
    }
    backend = selected;
    return backend;
  }
  function assertBackend(binding) {
    if (binding && binding.backend !== selectBackend()) throw new Error(`Saved ${binding.backend} binding cannot continue with the active ${backend} runtime. The saved record is unchanged. No fallback worker will be launched.`);
  }
  function assertIdentity(data, binding) {
    if (!data || data.id !== binding.id || data.name !== binding.name || data.agent !== 'project-worker' || data.cwd !== binding.root || data.sessionFile !== binding.sessionFile) {
      throw new Error('Native worker identity does not match the owned binding. Continuation and result refused.');
    }
  }
  const getRecord = options.getRecord ?? (id => globalThis[Symbol.for('pi-subagents:manager')]?.getRecord(id));
  const lockDir = options.lockDir ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'project-sessions', 'locks');
  const timeoutMs = options.timeoutMs ?? 10000;
  function restore(_event, ctx) {
    branchEpoch++;
    session = ctx.sessionManager.getSessionId();
    if (!stores.has(session)) stores.set(session, new LeaseStore(lockDir, session));
    bindings.clear();
    for (const entry of ctx.sessionManager.getBranch()) {
      const data = entry.data;
      if (entry.type === 'custom' && entry.customType === ENTRY && typeof data?.root === 'string' && isAbsolute(data.root) && typeof data.id === 'string' && data.id) bindings.set(data.root, { ...data, backend: data.backend ?? 'tintinweb' });
    }
  }
  pi.on('session_start', restore);
  pi.on('session_tree', restore);
  pi.on('tool_call', async (event, ctx) => {
    if (!['edit', 'write'].includes(event.toolName) || typeof event.input?.path !== 'string') return;
    let target;
    try { target = await repositoryRoot(event.input.path, ctx.cwd); } catch { return; }
    let current;
    try { current = await repositoryRoot(ctx.cwd); } catch { /* Non-Git coordinators can still delegate. */ }
    if (target !== current) return { block: true, reason: `External repository ${target}: use project_session dispatch with a bounded task and acceptance checks before changing files. No worker was launched.` };
  });
  pi.on('before_agent_start', event => {
    const rules = event.systemPromptOptions.promptGuidelines ??= [];
    if (!rules.includes(guidance)) rules.push(guidance);
  });
  const disposalListeners = ['tintinweb', 'interactive'].map(kind => pi.events.on(kind === 'interactive' ? 'interactive-subagents:disposed' : 'subagents:disposed', () => {
    disposed.add(kind);
    if (closing && backend === kind) release();
  }));
  function release() {
    for (const store of stores.values()) store.releaseAll();
    for (const off of disposalListeners.splice(0)) off();
  }
  pi.on('session_shutdown', () => {
    closing = true;
    for (const cancel of [...waits]) cancel();
    // Native disposal is the only safe barrier: its shutdown hook may run after ours.
    if (disposed.has(backend) || !reserved.size) release();
  });
  function rpc(method, payload, signal) {
    return new Promise((resolve, reject) => {
      if (closing || signal?.aborted) { reject(new Error('Request cancelled')); return; }
      const requestId = randomUUID(), channel = `subagents:rpc:${method}`;
      let timer, off;
      const finish = (error, data) => {
        clearTimeout(timer); off?.(); signal?.removeEventListener('abort', cancel); waits.delete(cancel);
        if (error) reject(error); else resolve(data);
      };
      const cancel = () => finish(new Error('Request cancelled; emitted dispatch may still be active'));
      off = pi.events.on(`${channel}:reply:${requestId}`, reply => {
        if (reply?.success === true) finish(null, reply.data);
        else finish(new Error(reply?.error || 'Native RPC refused request'));
      });
      waits.add(cancel); signal?.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish(new Error(`Native ${method} timed out; dispatch state may be uncertain`)), timeoutMs);
      try { pi.events.emit(channel, { ...payload, requestId }); } catch (e) { finish(e); }
    });
  }
  pi.registerTool({
    name: 'project_session', label: 'Project session',
    description: 'Dispatch bounded implementation tasks to stable per-Git-repo background project-worker sessions (30 turns), list up to 100 owned sessions, or retrieve one result by path. Existing/prospective file paths accepted. Busy workers are never steered. Reuses only this coordinator branch; no cwd switch, model override, arbitrary IDs, or automatic launches. Native completion notification will arrive; do not poll. Workers have local file/shell tools, not a sandbox; user permissions still apply.',
    reachesTools: () => ['subagent', 'subagent_status', 'subagent_message', 'Agent', 'get_subagent_result'],
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ['dispatch', 'list', 'result'] },
      path: { type: 'string', minLength: 1, maxLength: 4096 },
      task: { type: 'string', minLength: 1, maxLength: 16000 },
    } },
    async execute(_id, args, signal, _update, ctx) {
      const epoch = branchEpoch;
      const assertBranch = () => { if (epoch !== branchEpoch || closing) throw new Error('Coordinator branch changed; request refused'); };
      try {
        if (closing || signal?.aborted) throw new Error('Request cancelled');
        if (Object.keys(args).some(key => !['action', 'path', 'task'].includes(key))) throw new Error('Unsupported project_session argument');
        if (!['dispatch', 'list', 'result'].includes(args.action)) throw new Error('Invalid action');
        if (args.action === 'list') return result({ records: [...bindings.values()].slice(0, 100).map(binding => ({ root: binding.root, agentId: binding.id, backend: binding.backend, name: binding.name, status: binding.backend === 'tintinweb' ? getRecord(binding.id)?.status ?? 'saved' : 'saved' })), truncated: bindings.size > 100 });
        if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 4096) throw new Error('A bounded repository path is required');
        if (args.action === 'dispatch' && (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 16000)) throw new Error('Task must be nonempty and at most 16000 characters');
        const root = await repositoryRoot(args.path, ctx.cwd);
        assertBranch();
        let binding = bindings.get(root);
        selectBackend();
        assertBackend(binding);
        const ownedStatus = async () => {
          if (typeof binding.name !== 'string' || !binding.name || typeof binding.sessionFile !== 'string' || !isAbsolute(binding.sessionFile)) throw new Error('Saved interactive binding is incomplete. No fallback worker will be launched.');
          const outcome = await ctx.executeTool('subagent_status', { name: binding.name }, { signal });
          assertBranch();
          if (outcome.isError) throw new Error(outcome.result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || 'Native status refused');
          const data = outcome.result.details;
          assertIdentity(data, binding);
          if (!['running', 'finished'].includes(data.status)) throw new Error('Native worker status is unknown. Continuation and result refused.');
          return data;
        };
        if (args.action === 'result') {
          if (!binding) throw new Error('No owned session for this repository on the active branch');
          if (backend === 'interactive') return result({ root, agentId: binding.id, ...await ownedStatus() });
          const outcome = await ctx.executeTool('get_subagent_result', { agent_id: binding.id }, { signal });
          assertBranch();
          return { ...outcome.result, isError: outcome.isError };
        }
        let currentRoot;
        try { currentRoot = await repositoryRoot(ctx.cwd); } catch { /* A home coordinator need not be a repository. */ }
        if (currentRoot === root) throw new Error('Already in this repository; do not delegate to the same root');
        assertBranch();
        binding = bindings.get(root);
        const id = binding?.id;
        if (pending.has(root)) return result({ root, agentId: id, status: 'busy' });
        if (reserved.has(root) && !binding) throw new Error('Repository dispatch is uncertain or belongs to a different branch; refusing duplicate');
        pending.add(root);
        try {
          if (!session || session !== ctx.sessionManager.getSessionId()) throw new Error('Coordinator session not initialized');
          stores.get(session).acquire(root);
          if (backend === 'interactive') {
            if (binding) {
              reserved.add(root);
              const status = await ownedStatus();
              if (status.status === 'running') return result({ root, agentId: id, status: 'busy' });
            }
            assertBranch();
            if (signal?.aborted) throw new Error('Request cancelled');
            reserved.add(root);
            const name = binding?.name ?? `project-${randomUUID()}`;
            const outcome = await ctx.executeTool(binding ? 'subagent_message' : 'subagent', binding ? {
              name, message: args.task, resume_only: true, expected_cwd: root, expected_agent: 'project-worker',
            } : { agent: 'project-worker', name, cwd: root, task: args.task }, { signal });
            assertBranch();
            if (outcome.isError) return { ...outcome.result, isError: true };
            const data = outcome.result.details;
            if (data?.status !== 'started' || typeof data.id !== 'string' || !data.id || data.name !== name || ((!binding || data.agent !== undefined) && data.agent !== 'project-worker') || typeof data.sessionFile !== 'string' || !isAbsolute(data.sessionFile)) {
              throw new Error('Native launch acknowledgement is invalid. Repository remains reserved. No fallback worker will be launched.');
            }
            if (binding && (data.id !== id || data.sessionFile !== binding.sessionFile)) throw new Error('Native resume changed worker identity. Repository remains reserved.');
            if (!binding) {
              binding = { backend: 'interactive', root, id: data.id, name, sessionFile: data.sessionFile };
              bindings.set(root, binding);
              pi.appendEntry(ENTRY, binding);
            }
            return result({ root, agentId: binding.id, name, status: 'started', backend });
          }
          if (id && ['running', 'queued'].includes(getRecord(id)?.status)) return result({ root, agentId: id, status: 'busy' });
          if (signal?.aborted) throw new Error('Request cancelled');
          const description = args.task.trim().slice(0, 120);
          const ping = await rpc('ping', {}, signal);
          if (ping?.version !== 2 || !Array.isArray(ping.capabilities) || !['exact-type', 'resume-cwd'].every(capability => ping.capabilities.includes(capability))) {
            throw new Error('Native runtime upgrade required: project_session needs RPC v2 capabilities exact-type and resume-cwd. No fallback worker will be launched.');
          }
          assertBranch();
          if (id) {
            reserved.add(root);
            const outcome = await ctx.executeTool('Agent', { resume: id, prompt: args.task, description, subagent_type: 'project-worker', run_in_background: true });
            const resumed = outcome.result;
            if (outcome.isError) return { ...resumed, isError: true };
            if (resumed.details?.agentId !== id || resumed.details?.status !== 'background') return failure(`Native resume not accepted; no fallback spawn. ${resumed.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') ?? ''}`);
            return result({ root, agentId: id, status: 'background' });
          }
          const ownerSession = session;
          const bind = agentId => {
            if (typeof agentId !== 'string' || !agentId) return;
            if (session !== ownerSession || epoch !== branchEpoch || closing) return;
            if (bindings.get(root)?.id !== agentId) {
              const saved = { root, id: agentId, backend: 'tintinweb' };
              bindings.set(root, saved); pi.appendEntry(ENTRY, saved);
            }
          };
          reserved.add(root);
          const spawned = await rpc('spawn', { type: 'project-worker', prompt: args.task, options: {
            cwd: root, description, name: 'project-worker', isBackground: true,
            inheritContext: false, isolated: true, maxTurns: 30, requireExactType: true, onSpawned: bind,
          } }, signal);
          if (typeof spawned?.id !== 'string' || !spawned.id) throw new Error('Native spawn acknowledgement has no ID; repository remains reserved');
          bind(spawned.id);
          return result({ root, agentId: spawned.id, status: 'background' });
        } finally { pending.delete(root); }
      } catch (error) { return failure(error.message ?? String(error)); }
    },
  });
}
