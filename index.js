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
  let session, branchEpoch = 0, closing = false, disposed = false;
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
      if (entry.type === 'custom' && entry.customType === ENTRY && typeof data?.root === 'string' && isAbsolute(data.root) && typeof data.id === 'string' && data.id) bindings.set(data.root, data.id);
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
  let unsubscribeDisposed = pi.events.on('subagents:disposed', () => {
    disposed = true;
    if (closing) release();
  });
  function release() {
    for (const store of stores.values()) store.releaseAll();
    unsubscribeDisposed?.(); unsubscribeDisposed = undefined;
  }
  pi.on('session_shutdown', () => {
    closing = true;
    for (const cancel of [...waits]) cancel();
    // Native disposal is the only safe barrier: its shutdown hook may run after ours.
    if (disposed || !reserved.size) release();
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
    reachesTools: () => ['Agent', 'get_subagent_result'],
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
        if (args.action === 'list') return result({ records: [...bindings].slice(0, 100).map(([root, agentId]) => ({ root, agentId, status: getRecord(agentId)?.status ?? 'saved' })), truncated: bindings.size > 100 });
        if (typeof args.path !== 'string' || !args.path.trim() || args.path.length > 4096) throw new Error('A bounded repository path is required');
        if (args.action === 'dispatch' && (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 16000)) throw new Error('Task must be nonempty and at most 16000 characters');
        const root = await repositoryRoot(args.path, ctx.cwd);
        assertBranch();
        let id = bindings.get(root);
        if (args.action === 'result') {
          if (!id) throw new Error('No owned session for this repository on the active branch');
          const outcome = await ctx.executeTool('get_subagent_result', { agent_id: id }, { signal });
          return { ...outcome.result, isError: outcome.isError };
        }
        let currentRoot;
        try { currentRoot = await repositoryRoot(ctx.cwd); } catch { /* A home coordinator need not be a repository. */ }
        if (currentRoot === root) throw new Error('Already in this repository; do not delegate to the same root');
        assertBranch();
        id = bindings.get(root);
        if (pending.has(root)) return result({ root, agentId: id, status: 'busy' });
        if (reserved.has(root) && !id) throw new Error('Repository dispatch is uncertain or belongs to a different branch; refusing duplicate');
        pending.add(root);
        try {
          if (!session || session !== ctx.sessionManager.getSessionId()) throw new Error('Coordinator session not initialized');
          stores.get(session).acquire(root);
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
            if (bindings.get(root) !== agentId) { bindings.set(root, agentId); pi.appendEntry(ENTRY, { root, id: agentId }); }
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
