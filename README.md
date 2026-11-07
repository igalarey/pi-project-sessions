# Pi project sessions

Pi project sessions directs concrete work to a Git repository without changing the coordinator's working directory.
It uses the native interactive subagent runtime through `subagent`, `subagent_status`, and restrictive `subagent_message` calls.
It does not start a second runtime or control Herdr windows.
The historical `@tintinweb/pi-subagents` backend remains supported when the interactive tools are absent.

## Behavior

Each coordinator maintains one managed worker per canonical Git root.
The worker uses that root for its tools and keeps its conversation between accepted tasks.
A finished interactive worker resumes the same session file in a new process.
A live worker remains busy, even when its model is idle.
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

The worker profile disables extensions and skills and restricts tools to local file and shell operations.
The native runtime preserves that loadout on continuation.
Reading repository instructions does not grant permission for network access, publication, or desktop control.

## Session lifetime

The mapping belongs to the coordinator's session branch.
Native session records remain the authority for worker continuation.
The extension does not inspect arbitrary session histories.

Each new binding records its backend and native identity.
Interactive bindings also record the unique worker name and session file.
Before continuation or result retrieval, the extension verifies the native ID, root, profile, name, and session file.
Unknown status prevents continuation and result retrieval.
The native restrictive resume flag prevents a status-check race from steering a live worker.
The extension never starts a replacement worker after a refusal.

Bindings without a backend tag belong to `tintinweb`.
The interactive backend cannot continue these bindings or retrieve their results.
The extension preserves those records and reports the mismatch without converting IDs or starting another worker.
When interactive tools exist but lack the required contract, the extension refuses dispatch instead of selecting the historical backend.

A crash during lease bookkeeping can leave an acquisition guard without valid ownership data.
The extension refuses automatic recovery in that case.
An operator must inspect the affected lease before manual removal.

Interactive workers use the native runtime's visible TUI surfaces in Herdr while they work.
The profile uses `auto-exit: true`, so the runtime closes the TUI after completion.
A later task resumes the same session file, not the previous live process.
Only the native runtime delivers automatic completion messages.
Result retrieval does not send another notification or start a model turn.

Project leases remain held until the selected runtime emits its disposal event after all surfaces close.
The historical backend uses `subagents:disposed`.
The interactive backend uses `interactive-subagents:disposed`.
An event from the other backend cannot release a worker's lease.

## Local installation

The installed Pi host and native subagent package are prerequisites.
The interactive runtime must provide owned status and the `resume_only`, `expected_cwd`, and `expected_agent` parameters.
Only the historical backend uses RPC with the `exact-type` and `resume-cwd` capabilities.
This package has no npm dependencies.
These instructions describe a later installation step, not automatic activation of this worktree.

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
It does not modify a sealed harness release or the shared instruction file.

## Verification

Unit and integration fixtures use temporary directories and synthetic tasks.
The historical host test uses the official Pi loader, the tintinweb runtime, and a synthetic provider.
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

The interactive host test uses Pi 1.5+, the interactive source runtime, and a faux provider.
It creates two temporary Git repositories and projects extension and profile links into a temporary HOME.
Its explicit process backend uses PTYs, not Herdr window controls.
The fixture blocks network calls in both the parent and child processes.

The test checks automatic discovery, inherited model selection, root-bound tools, native completion, and refusal of a busy worker without a message.
It also checks session reuse with a new PID, owned results, branch isolation, restart, unknown status, leases, and the 30-turn limit.
Contract fixtures cover uncertain launches, identity mismatches, restrictive resume races, legacy records, and backend-specific shutdown barriers.
They do not read unrelated conversations.

To include the interactive host test, run:

```sh
PI_TEST_HOST_ROOT=/path/to/@earendil-works/pi-coding-agent \
PI_TEST_INTERACTIVE_ROOT=/path/to/pi-interactive-subagents \
npm test
```

Without the required paths, the test output explicitly marks each optional host test as skipped.
The interactive fixture also requires Linux and the existing process-PTY prerequisites of the native runtime.
It does not install dependencies.
These fixtures do not verify Herdr dashboard behavior or real-model interpretation of a task.
