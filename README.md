# Pi project sessions

Pi project sessions directs concrete work to a Git repository without changing the coordinator's working directory.
It uses the installed `@tintinweb/pi-subagents` runtime.
It does not start a second execution runtime or control Herdr windows.

## Behavior

Each coordinator maintains one managed worker per canonical Git root.
The worker uses that root for its tools and keeps its conversation between accepted tasks.
An idle worker receives the next task through the native resume mechanism.
An active worker returns a busy status instead of accepting an interruption or a duplicate worker.

Different coordinators cannot claim the same root while its owner remains active.
The extension does not adopt unrelated Pi sessions.
Git worktrees have separate roots and separate workers.
The existing `todo` command determines whether those worktrees share a task list.

The coordinator selects a repository from concrete work, not from incidental file reads.
The extension blocks direct `edit` and `write` calls into another repository.
The block asks the coordinator to delegate the work through `project_session`.
It does not start a worker by itself.

The write guard is not a filesystem sandbox.
Shell commands and other tools can still modify files outside their working directory.
The coordinator and workers must obey the user's scope and shared instructions.

## Tool

The tool accepts three actions:

- `dispatch`: Start or resume a worker for a repository and a bounded task.
- `list`: Show this coordinator's managed repositories.
- `result`: Read the native worker result for a repository.

Example arguments:

```json
{
  "action": "dispatch",
  "path": "/absolute/path/to/repository/src/file.ts",
  "task": "Fix the specified bug in src/file.ts. Preserve unrelated edits. Run the existing regression suite and report its result."
}
```

The path can identify a directory, an existing file, or a new file inside a repository.
The tool rejects paths outside Git repositories.
Work in the coordinator's own repository does not require another worker.

Dispatch runs in the background.
The native runtime owns progress, cancellation, completion notifications, and result delivery.
The coordinator must verify the worker's changes before reporting completion.

## Instructions and tasks

The worker profile has no model override, extensions, skills, or nested delegation.
It inherits the coordinator's model through the native runtime.
Each run has a limit of 30 turns.
This limit is not a spending quota.

Before edits, the worker must read `~/.agents/SYSTEM.md` and the applicable `AGENTS.md` files.
The task brief must include relevant procedures, constraints, and acceptance checks.
The worker must stop when required capabilities are unavailable.

Task lists remain shared by project.
The worker uses `todo` from its repository, or `todo -p <root>`.
This extension does not move existing tasks from `~` or create private per-agent lists.

The native runtime keeps configuration discovery at the coordinator's directory for cross-directory workers.
It does not trust or execute the target repository's `.pi` extensions automatically.
Reading repository instructions does not grant permission for network access, publication, or desktop control.

## Session lifetime

The mapping belongs to the coordinator's session branch.
Native session records remain the authority for worker continuation.
The extension does not inspect arbitrary session histories.

The required native runtime preserves the original repository for saved-session continuation.
Older native records without launch metadata cannot resume from disk.
Existing results remain available.
Capability changes, a missing repository, or a different coordinator configuration can prevent continuation.
The extension reports these refusals without starting a replacement worker or bypassing the native checks.

A crash during lease bookkeeping can leave an acquisition guard without valid ownership data.
The extension refuses automatic recovery in that case.
An operator must inspect the affected lease before manual removal.

Workers appear in Pi's `/agents` interface.
They are not separate interactive Herdr tabs.

## Local installation

The installed Pi host and native subagent package are prerequisites.
The native RPC must report the `exact-type` and `resume-cwd` capabilities.
The extension refuses older runtimes instead of selecting a fallback worker.
This package has no npm dependencies.

1. Run the tests from this directory:

   ```sh
   npm test
   ```

2. If the destinations do not exist, create these links:

   ```sh
   ln -s "$PWD" ~/.pi/agent/extensions/project-sessions
   ln -s "$PWD/agents/project-worker.md" ~/.pi/agent/agents/project-worker.md
   ```

3. In the coordinator, run `/reload` while idle.

4. Ask the coordinator to delegate one concrete task to an explicit repository.

The extension uses separate user-owned files.
It does not modify a sealed harness release, the retired interactive-subagent package, or the shared instruction file.

## Verification

Unit and integration fixtures use temporary directories and synthetic tasks.
The host test uses the official Pi loader, the native subagent runtime, and a synthetic provider.
It performs real file operations in temporary repositories without remote model requests.
It checks separate roots, live reuse, saved-session continuation, and refusal of a missing worker profile.
It uses the installation links to test automatic extension and profile discovery.
It also checks a symlinked coordinator and refuses continuation after that link changes its target.

To include the host test, set the paths to the installed packages:

```sh
PI_TEST_HOST_ROOT=/path/to/@earendil-works/pi-coding-agent \
PI_TEST_SUBAGENTS_ROOT=/path/to/@tintinweb/pi-subagents \
npm test
```

Without those paths, the test output explicitly marks the host test as skipped.
Synthetic-provider tests do not prove how a real model will interpret a task.
