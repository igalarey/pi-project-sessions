import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.PI_TEST_HOST_ROOT;
const native = process.env.PI_TEST_SUBAGENTS_ROOT;

test('official host and native subagents keep separate repo sessions and reuse the idle worker', {
  skip: !host || !native ? 'Set PI_TEST_HOST_ROOT and PI_TEST_SUBAGENTS_ROOT for the offline host test.' : false,
  timeout: 90_000,
}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-project-host-'));
  try {
    const home = path.join(temp, 'home');
    const agentDir = path.join(home, '.pi', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const env = {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      PI_CODING_AGENT_DIR: agentDir, XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local/share'), TMPDIR: temp,
      PI_OFFLINE: '1', PI_E2E_LIVE: '0', PI_RUN_LIVE_SUBAGENT_TESTS: '0',
      NO_COLOR: '1', TERM: 'dumb',
    };
    const result = spawnSync(process.execPath, [path.join(source, 'test/fixtures/host-runtime.mjs'), host, native, source], {
      cwd: home, env, encoding: 'utf8', timeout: 80_000, maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.error?.message ?? `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /PROJECT_HOST_OK/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
