import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.PI_TEST_HOST_ROOT;
const native = process.env.PI_TEST_INTERACTIVE_ROOT;
const available = host && native && process.platform === 'linux' && fs.existsSync(path.join(host, 'dist/cli.js'));

for (const scenario of ['', 'drain', 'cancel', 'shutdown', 'capacity']) test(`${scenario || 'baseline'}: SDK host discovers interactive project workers, owns results and resumes bounded PTY sessions offline`, {
  skip: !available ? 'Requires Linux, PI_TEST_HOST_ROOT (Pi 1.5+) and PI_TEST_INTERACTIVE_ROOT; no dependencies are installed.' : false,
  timeout: 120000,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-project-interactive-host-'));
  try {
    const home = path.join(temp, 'home');
    const agentDir = path.join(home, '.pi', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), TMPDIR: temp,
      PI_OFFLINE: '1', PI_E2E_LIVE: '0', PI_RUN_LIVE_SUBAGENT_TESTS: '0', TERM: 'xterm-256color',
      PI_SUBAGENT_SURFACE_BACKEND: 'process',
      PI_TEST_FAUX: path.join(host, 'node_modules/@earendil-works/pi-ai/dist/providers/faux.js') };
    const outcome = spawnSync(process.execPath, [path.join(source, 'test/fixtures/interactive-host.mjs'), host, native, source, scenario], {
      cwd: home, env, encoding: 'utf8', timeout: 110000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(outcome.status, 0, `${outcome.error?.message ?? ''}\n${outcome.stderr}\n${outcome.stdout}`);
    assert.match(outcome.stdout, scenario ? /PROJECT_COORDINATOR_HOST_OK/ : /PROJECT_INTERACTIVE_HOST_OK/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
