# Pi project sessions

Pi project sessions directs concrete work to a Git repository without changing the coordinator's working directory.
It uses the native interactive subagent runtime through `subagent`, `subagent_status`, and restrictive `subagent_message` calls.
It does not start a second runtime or control Herdr windows.
Historical `@tintinweb/pi-subagents` bindings remain listable and their results readable through that backend, but it cannot dispatch or resume the coordinator profile.

## Behavior

The hierarchy is principal → persistent project coordinator → non-delegating specialists.
Each principal session maintains one project coordinator per canonical Git root on its active session branch.
The coordinator keeps the compatibility profile name [`project-worker`](agents/project-worker.md) and also implements work directly.
In this document, “worker” means that project coordinator.
The worker uses that root for its tools and keeps its conversation between accepted tasks.
A finished interactive worker resumes the same session file in a new process.
A live worker remains busy, even when its model is idle.
An active worker returns a busy status instead of accepting an interruption or a duplicate worker.

Coordinators that share the same lease directory cannot claim the same root while another live parent owns its lease.
The default directory is `project-sessions/locks` under `PI_CODING_AGENT_DIR`, or under `~/.pi/agent` when that variable is absent.
Separate agent directories do not share this ownership guard.
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
- `list`: Show up to 100 managed repositories on the active session branch.
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

The project-worker profile has no model override, broad extension discovery, or automatic skills.
It grants native delegation to the seven canonical roles `scout`, `worker`, `reviewer`, `oracle`, `researcher`, `evidence-auditor`, and `delegate`, plus the local optional `ui-verifier` specialization.
Those named specialist profiles must be provided separately and must prohibit further delegation; this package does not install or rewrite them.
It inherits the coordinator's model through the native runtime.
Each run has a limit of 30 turns.
This limit is not a spending quota.

Before edits, the worker must read `~/.agents/SYSTEM.md` and the applicable `AGENTS.md` files.
The task brief must include relevant procedures, constraints, and acceptance checks.
The worker must stop when required capabilities are unavailable.

Task lists remain shared by project.
The worker uses `todo` from its repository, or `todo -p <root>`.
This extension does not move existing tasks from `~` or create private per-agent lists.

The profile requires `extensions: scoped`, the native mode for fixed tools and persisted bindings.
It retains its declared local file/shell tools and native delegation/control tools.
It enables no optional provider tools or broad extension discovery.
It declares `skill_catalog: diagnose-root,enforce-first,edit-document,simple-english,security-review,elaborate-spec,grounded-citations` for named procedure discovery without automatic bootstrap; the conflicting `skills: false` is absent.
This declaration requires the native named-catalog contract verified for the public release. The older sealed baseline does not satisfy the coordinator requirements.
The native runtime explicitly adds the restricted delegation/control toolset for its named spawn targets.
The coordinator implements straightforward work itself and delegates only independent/complex work or independent review.
The profile instructs the coordinator to keep at most two active specialists.
The deployment must also configure native `delegation.maxConcurrentChildren: 2` enforcement.
The adapter checks capability support, not the configured limit value. It does not set native limits.
The fixture uses depth 2, global concurrency 6, and two children per non-root parent. These values are not installation defaults.
On capacity refusal, do bounded direct work or report blocked; do not busy-loop or create another parent to bypass the limit.
Parallel writers require separate authorized Git worktrees; there are no automatic merges or conflict overwrites.
Specialists receive the same authorized scope and canonical shared todo root.
The coordinator must inspect their changes and checks before success; incomplete or cancelled work is not success.
Missing procedures or capabilities must be reported to the principal, never supplied by automatic permission or capability expansion.
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

Interactive workers use the surface backend selected by the native runtime.
The offline fixture uses process PTYs, not Herdr window controls.
The profile uses `auto-exit: true`, so the runtime closes the TUI after completion.
A later task resumes the same session file, not the previous live process.
Only the native runtime delivers automatic completion messages.
Result retrieval does not send another notification or start a model turn.

A completed worker does not release its project lease.
During parent shutdown, the extension waits for the selected runtime's disposal event before releasing reserved roots.
The runtime must emit that event only after its managed processes and surfaces close.
The historical backend uses `subagents:disposed`.
The interactive backend uses `interactive-subagents:disposed`.
An event from the other backend cannot release a worker's lease.

## Public release and installation pin

`publish/sanitized-coordinator` starts with aggregate coordinator commit `58b02fa776fe4bc0d9aca6ad0b3b3f5a6b9320c4`, based on public `main` at `3d5faa6f160d42d6981a23034e3a5fc5fc61b1f6`.
It does not include the intervening local coordinator commits as ancestors.
The activated harness release uses this public coordinator pin, not an unpublished local commit.
Later documentation commits on this branch do not change that pin.
Equivalent runtime bytes do not make a later documentation HEAD the same Git commit as the installation pin.

The [public harness verification receipt](https://github.com/igalarey/agent-config/blob/publish/sanitized-harness/docs/scoped-source-verification.md) records the activated release and its reproducibility checks.
The public harness branch is `publish/sanitized-harness`.

| Component | Public pin or release |
| --- | --- |
| Coordinator | `58b02fa776fe4bc0d9aca6ad0b3b3f5a6b9320c4` |
| Harness source | `dbb8b4927427b48473431d77aae9f7f97ea06a5a` |
| Harness recipe | `18cddcced20826f6f03f844393d5f7d3227846e3` |
| Activated release | `h-dbb8b4927427-s-21628a941dbc-m-35275b8ce08a` |

The receipt records passing official verification groups of 14, 5, and 1 checks for both the candidate and the cold bootstrap.
The cold bootstrap used a clean GitHub clone without a source map or copied private sources.
It used the existing npm cache only and passed verification after temporary activation.
The runtime and `sourceDigest` matched between the candidate and the cold bootstrap.

Combined candidate verification passed one harness check and 37 coordinator tests, with one historical-backend test skipped.
The cold combined run also passed.
Doctor reported zero conflicts and zero pending changes.
These results do not certify public websites, real-model behavior, or every future host configuration.

## Local installation

Use the public coordinator pin with the compatible harness release recorded in the verification receipt.
A source-snapshot test alone is not installation certification.

The installed Pi host and native subagent package are prerequisites.
The interactive runtime must provide owned status and the `resume_only`, `expected_cwd`, and `expected_agent` parameters.
It must also publish all four grants in the [capability handshake](#fail-closed-rollout-handshake).
Historical RPC launch/resume support is removed; it cannot establish the coordinator capability contract.
This package has no npm dependencies. It is a separate user extension, not part of the sealed harness package set.
The repository is public. The SSH clone command requires a GitHub SSH key.

Clone the public branch. Then check out the exact installation pin:

```sh
git clone --branch publish/sanitized-coordinator git@github.com:igalarey/pi-project-sessions.git
cd pi-project-sessions
git checkout --detach 58b02fa776fe4bc0d9aca6ad0b3b3f5a6b9320c4
```

The installed checkout must remain clean at that pin, even when the branch contains newer documentation.

1. Run the tests from this directory:

   ```sh
   npm test
   ```

2. If the destinations do not exist, create these links:

   ```sh
   ln -s "$PWD" ~/.pi/agent/extensions/project-sessions
   ln -s "$PWD/agents/project-worker.md" ~/.pi/agent/agents/project-worker.md
   ```

3. After a native runtime upgrade, restart Pi with the compatible runtime. Reloading only this extension does not establish runtime compatibility.

4. Ask the coordinator to delegate one concrete task to an explicit repository.

The extension uses separate user-owned files.
It does not modify a sealed harness release or the shared instruction file.

## Verification

Unit and integration fixtures use temporary directories and synthetic tasks.
The historical host test uses the official Pi loader and tintinweb runtime to check that coordinator dispatch is refused before lease acquisition or worker launch.
It retains external-write refusal and incidental-read checks in temporary repositories without network requests.
Synthetic fixtures also verify historical result retrieval and branch/list preservation; they never grant new capabilities to a historical runtime.

To include the host test, set the paths to the installed packages:

```sh
PI_TEST_HOST_ROOT=/path/to/@earendil-works/pi-coding-agent \
PI_TEST_SUBAGENTS_ROOT=/path/to/@tintinweb/pi-subagents \
npm test
```

The interactive host test uses Pi 1.5+, the interactive runtime, and a faux provider.
`PI_TEST_INTERACTIVE_ROOT` can select a source checkout or a prepared release package.
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

### Coordinator scope

This extension supplies the bounded coordinator profile. The harness owns release activation and the real specialist profiles.
Binding/backend identity, busy refusal, restrictive same-session resume, and lease/disposal handling remain in place. A dispatch capability gate now runs before acquiring any project lease, with no fallback to historical launch/resume.
Previously saved native loadouts are replayed exactly: changing this profile does not upgrade old sessions or convert historical backend bindings.
No automatic skills, broad discovery, model escalation, or runtime per-parent policy is added here.
Before activation, verify named personal skill discovery without auto-bootstrap and the two-active-specialists per-parent policy.
Verify that all seven canonical targets and the local optional `ui-verifier` prohibit further delegation.
The seven canonical names follow the user-provided canonical nicobailon/pi-subagents inventory at `52e68e9ef0e563d5c97b28519f9999f1b5fbbbea`; this repository does not fetch or adapt those role bodies.
The main harness owns those real profiles. Even the `delegate` specialist must not delegate further.
The host still needs owned status, restrictive resume, and a truthful disposal event after descendant process termination.

Offline coordinator scenarios use temporary specialist definitions (read-only, no delegation), two Git roots, the official Pi 1.5 SDK and process PTYs.
The fixture explicitly sets depth 2, global concurrency 6, per-non-root-parent concurrency 2, and unlimited cumulative launches; these are fixture limits, not installed configuration changes.
`drain` holds a specialist alive while the second project completes and refuses a busy dispatch.
It then forces a two-turn incomplete specialist result.
The coordinator must receive that result before it returns incomplete.
`cancel` and `shutdown` assert specialist process death and repository ownership through native disposal.
The cancellation fixture now holds the independent project alive and requires it to survive and complete after cancelling the other coordinator.
`capacity` requires two real specialist launches, refusal of a third, third-level delegation denial, and descendant process death before the coordinator completion.
It repeats the same checks after resuming the identical project binding in a new process.
Synthetic named skills are created only under the isolated HOME; assertions require their descriptions in discovery, no body auto-bootstrap, and exclusion of an unlisted skill.
These scenarios passed against the coordinated native source snapshot described below, including the tightened refusal and distinct-child completion assertions.
The baseline retains inherited model, resume/new-PID, branch/backend, result-delivery, and 30-turn checks.
These synthetic cases do not prove arbitrary descendant failure handling or real-model compliance with the instructions.

### Prior source-snapshot acceptance (before the capability handshake)

The reviewed coordinator log reports 19 passed, 0 failed, and 1 skipped (the historical backend host test).
Before adding the rollout capability handshake, the full suite was rerun with the command below and again passed 19/0/1. That snapshot intentionally lacks the marker and must now fail dispatch; these prior results do not certify the new gate against a phase-three runtime.
The refusal checks now inspect native error text for `concurrent child limit reached (2 active children for parent ...)`, rather than matching child names in serialized results.
Completion requires distinct incomplete notifications for both children; their PIDs must be gone when the coordinator completion is inspected.
Both rounds use the same project binding/session file but different coordinator PIDs, and each round must admit two children and refuse the third.
The named-catalog description/body/exclusion checks run in both coordinator processes.

The phase-two snapshot used an existing dependency symlink. It was not an installed or final packaged release.
Depth 2 and global concurrency 6 are configured fixture bounds, not saturation proofs. The two-child per-parent refusal is exercised behaviorally before and after resume.
No compatibility fallback removes these requirements or accepts unavailable catalog capabilities.

```sh
PI_TEST_HOST_ROOT=/path/to/@earendil-works/pi-coding-agent \
PI_TEST_INTERACTIVE_ROOT=/path/to/phase-two-snapshot/pi-interactive-subagents \
npm test
```

The older sealed baseline still fails at configuration loading with `delegation limits have unsupported key(s): maxConcurrentChildren`.
Historical failure reproduction:

```sh
PI_TEST_HOST_ROOT=/path/to/@earendil-works/pi-coding-agent \
PI_TEST_INTERACTIVE_ROOT=/path/to/older-release/packages/pi-interactive-subagents \
npm test
```

To isolate a scenario, replace `npm test` with
`node --test --test-name-pattern='drain:' test/interactive-host.test.mjs`
(or `cancel:` / `shutdown:` / `capacity:`). No packages are installed by these commands.

### Validation requirements for later releases

- Run the full suite against the final packaged native runtime, not only `capacity`. Temporary snapshots can disappear.
- Reverify after changes to native binding propagation. Historical snapshot runs do not certify later changes.
- Verify that the seven real adapted specialist profiles and local optional `ui-verifier` prohibit delegation.
- Verify their approved capabilities. Synthetic fixtures do not test the real role bodies.
- Verify the real named procedure catalog and final installed configuration without broad discovery or automatic bootstrap.
- Keep runtime-level coverage for atomic concurrent admission, global reservation/resume accounting, and failure-path cleanup; this fixture does not exhaustively prove those races.

Do not run against a concurrently edited native checkout without coordination. Historical source preparation alone did not imply activation.

### Fail-closed rollout handshake

Every coordinating dispatch, including saved resume, requires the interactive backend and the native shared registry marker:

```js
globalThis[Symbol.for('pi.subagents.tool-extension-registry')].capabilities
// { version: 1, personalSkillCatalog: true,
//   perParentChildLimit: true, persistedExtensionBindings: true,
//   scopedExtensionProfiles: true }
```

The native runtime publishes the frozen marker; this extension only reads it, without importing another runtime or adding a tool.
Missing, incomplete, wrong-version, or non-boolean grants produce an upgrade/restart error before lease acquisition or any native status/launch/resume call.
This prevents an older loaded runtime from ignoring `skill_catalog` and allowing ambient discovery after `skills:false` was removed.
The check is repeated immediately before launch/resume after any asynchronous status query.

There is no grandfathered resume exception: a saved binding records identity, not enough loadout evidence to prove an old runtime's catalog and extension restrictions safe.
A compatible runtime can resume only the original owned native session under its persisted loadout.
The extension never upgrades that loadout or converts backend identities.
Lists and owned results remain readable without the marker, subject to the existing backend and identity checks. Refused dispatch does not drop existing ownership leases or mutate saved bindings.

Regression fixtures explicitly install the complete capability marker only for supported synthetic interactive runtimes and test absent/incomplete grants before any lease directory is created.
The source host suite passed against the coordinated native source with the four-grant marker and persisted extension bindings.
For later releases, run it against the final packaged artifact before activation.
Tests do not make the phase-two snapshot compatible.

### Scoped-profile backward-rollout barrier

`extensions: scoped` also blocks launch when an old adapter and old runtime operate together.
The older parser accepts only `true`/`false` and rejects the new enum before launch.
It cannot silently ignore `skill_catalog` and launch the new profile.
The current adapter additionally requires `scopedExtensionProfiles: true` alongside the other three version-one capability grants for both dispatch and resume.
Old loaded sessions must fail closed and require a compatible runtime restart; no saved loadout is silently expanded or migrated. Historical lists/results remain readable under their existing backend rules.
The seven real specialist profiles are adapted separately by the main harness; synthetic fixtures use scoped mode without adding delegation or optional providers.

The reviewed coordinator log records 33 passed, 0 failed, 1 skipped against native commit `bda58d857386ffc75f228b59b9dc11d62baa4ac9` for the preceding three-grant guard.
That earlier evidence does not certify the scoped-mode followup. The subsequent reviewed log records 37 passed, 0 failed, 1 skipped against native `c3bf7936929584c642b9f0ab36e84e67ea6fbb1a` with scoped parsing and all four grants.
These are historical source results, not the current release receipt.
For later releases, rerun the full offline host suite against the packaged artifact.
Include old-parser rejection, capacity, saved resume, draining, cancellation isolation, and catalog restrictions. Actual host tests must not inject a substitute marker.

### Local optional public-interface verifier

`ui-verifier` is a local optional specialization, not an eighth upstream canonical role.
Use it only for explicitly requested public URL verification within the user's authorization.
Do not start automatic UI/desktop testing or expand permissions.
The coordinator itself gains no browser tools. Missing restricted profiles or capabilities must be reported, not replaced with broader access.
The harness owns the actual scoped profile.
It permits read-only built-in inspection plus `browser_goto`, `browser_read`, `browser_click`, `browser_screenshot`, and `browser_close`.
It prohibits form filling, sensitive actions, desktop control, Bash, file writes, and descendants.
Its specified limits are 20 turns, Sol/medium, and the `smoke-test`/`grounded-citations` catalog.
This repository neither installs that profile nor certifies its browser tools. Real-profile/browser verification belongs to the harness suite, not these synthetic fixtures.

The offline fixture adds `ui-verifier` as a synthetic read-only, non-delegating, two-turn profile using the inherited faux model, without browser tools or network access.
It occupies the second child slot in the capacity/resume scenario; the two-child cap, global-six limit, and depth-two configuration are unchanged. The fixture asserts absence of Bash/edit/write in specialists and still requires third-child refusal, no descendant delegation, draining, and the same project session on resume.

The historical ui-verifier source alignment passed the full suite: **37 passed, 0 failed, 1 skipped** (historical backend host package not supplied), with:

```sh
PI_TEST_HOST_ROOT=/path/to/@earendil-works/pi-coding-agent \
PI_TEST_INTERACTIVE_ROOT=/path/to/pi-interactive-subagents \
npm test
```

The native checkout reported HEAD `c3bf7936929584c642b9f0ab36e84e67ea6fbb1a`; it had pre-existing executable-mode/end-of-line differences (zero textual changes under `git diff --ignore-space-at-eol --numstat`), left untouched.
This historical result verifies the synthetic ui-verifier lifecycle, not public websites, browser tooling, real-profile permissions, or desktop behavior.
The public release receipt records the subsequent packaged verification and cold bootstrap.
