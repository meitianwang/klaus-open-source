import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { join } from 'node:path';

/** Development tests build current sources while the release driver enforces identity. */
export function prepareTestEngine(repoRoot, { logFile } = {}) {
  const args = [join(repoRoot, 'engine/scripts/prepare-rust-release.mjs'), '--dev'];
  let descriptor;
  if (logFile !== undefined) {
    appendFileSync(logFile, `$ ${JSON.stringify([process.execPath, ...args])}\n`);
    descriptor = openSync(logFile, 'a');
  }
  let result;
  try {
    result = spawnSync(process.execPath, args, {
      cwd: repoRoot,
      stdio: descriptor === undefined ? 'inherit' : ['ignore', descriptor, descriptor],
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  if (logFile !== undefined) appendFileSync(logFile, `exit_code=${result.status}\nsignal=${result.signal ?? ''}\n`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`Current development engine preparation failed with exit code ${result.status ?? 'unknown'}${result.signal ? ` (${result.signal})` : ''}${logFile ? `; see ${logFile}` : ''}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
}
