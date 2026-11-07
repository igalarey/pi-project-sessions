import { realpath, stat } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';

const exec = promisify(execFile);
export async function repositoryRoot(input, cwd = process.cwd()) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('A local Git path is required');
  let path = resolve(cwd, input.replace(/^@/, ''));
  for (;;) {
    try { path = await realpath(path); if (!(await stat(path)).isDirectory()) path = dirname(path); break; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || dirname(path) === path) throw error;
      path = dirname(path);
    }
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  try {
    const { stdout } = await exec('git', ['-C', path, 'rev-parse', '--show-toplevel'], { env, shell: false, timeout: 5000, maxBuffer: 65536 });
    return await realpath(stdout.replace(/\r?\n$/, ''));
  } catch { throw new Error('Path is not inside a local non-bare Git repository'); }
}

export class LeaseStore {
  constructor(directory, session) { this.directory = directory; this.session = session; this.token = randomUUID(); this.owned = new Set(); }
  path(root) { return join(this.directory, createHash('sha256').update(root).digest('hex')); }
  acquire(root) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = this.path(root), guard = `${lock}.guard`;
    try { mkdirSync(guard, { mode: 0o700 }); } catch { throw new Error(`Project lease acquisition is locked. Automatic recovery refused. Inspect ${guard} and its owner before manual recovery.`); }
    try {
      let exists = false;
      try { mkdirSync(lock, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; exists = true; }
      if (exists) {
        let owner;
        try { owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')); } catch { throw new Error('Project lease is unknown or corrupt'); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.session !== 'string' || typeof owner.token !== 'string') throw new Error('Project lease owner is invalid');
        if (owner.pid === process.pid && owner.session === this.session && owner.token === this.token) return;
        let dead = false;
        try { process.kill(owner.pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
        if (!dead) throw new Error('Project lease held by another live coordinator');
      }
      writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, session: this.session, token: this.token }), { mode: 0o600 });
      this.owned.add(root);
    } finally { rmSync(guard, { recursive: true }); }
  }
  releaseAll() {
    for (const root of this.owned) {
      const lock = this.path(root), guard = `${lock}.guard`;
      try { mkdirSync(guard, { mode: 0o700 }); } catch { continue; }
      try {
        const owner = JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8'));
        if (owner.pid === process.pid && owner.session === this.session && owner.token === this.token) rmSync(lock, { recursive: true });
        this.owned.delete(root);
      } catch { /* An unreadable lease is never reclaimed. */ }
      finally { rmSync(guard, { recursive: true }); }
    }
  }
}
