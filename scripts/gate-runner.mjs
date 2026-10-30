import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const desktopDirectory = fileURLToPath(new URL('..', import.meta.url));

// Variables the running Klaus app injects into every shell it spawns. KLAUS_CONFIG_DIR
// points at the developer's REAL profile, and this machine's profile enables
// `worktree = true`; the host's config-root guard and the engine SDK's config isolation
// both used to key off "is the override set", so a gate run inherited the real profile and
// two unrelated tests went red depending on who ran the gate. Stripping them at the gate
// entry makes every gate-run path deterministic; the guards no longer depend on it, but the
// tests must not read the developer's profile either way.
const CONFIG_LEAK_VARS = ['KLAUS_CONFIG_DIR', 'KLAUS_PLUGIN_HOME', 'KLAUS_SESSION_DIR'];

/** Environment for a gate child: inherited, minus the profile variables above. */
export function gateEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of CONFIG_LEAK_VARS) delete env[key];
  return env;
}

/** Save each command and its original output before proceeding to the next gate. */
export function createGate(name) {
  const directory = join(desktopDirectory, 'dist', `${name}-logs`);
  mkdirSync(directory, { recursive: true });
  const journal = join(directory, 'progress.jsonl'), results = [];
  rmSync(join(desktopDirectory, 'dist', `${name}-result.json`), { force: true });
  writeFileSync(journal, '');
  const record = value => appendFileSync(journal, JSON.stringify(value) + '\n');
  return {
    async run(label, command, args, options = {}) {
      const started = Date.now(), log = join(directory, `${String(results.length + 1).padStart(2, '0')}-${label}.log`);
      const row = { label, command, args, log, startedAt: new Date(started).toISOString() };
      record({ ...row, state: 'running' });
      console.log(`[${name}] ${label}: ${command} ${args.join(' ')}`);
      const file = openSync(log, 'w');
      let child;
      try {
        // Strip the profile variables AFTER merging the caller's env, so a caller that
        // re-spreads process.env (test-native.mjs does) cannot reintroduce them.
        const childEnv = gateEnvironment(options.env);
        child = spawn(command, args, { cwd: desktopDirectory, windowsHide: true, ...options, env: childEnv, stdio: ['inherit', 'pipe', 'pipe'] });
        child.stdout.on('data', bytes => { writeSync(file, bytes); process.stdout.write(bytes); });
        child.stderr.on('data', bytes => { writeSync(file, bytes); process.stderr.write(bytes); });
        const result = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
        results.push({ ...row, ...result, elapsedMs: Date.now() - started });
        record({ ...results.at(-1), state: result.code === 0 ? 'passed' : 'failed' });
        if (result.code !== 0) throw new Error(`${label} failed (${result.signal ?? result.code}); original output: ${log}`);
      } catch (error) {
        record({ ...row, state: 'error', error: String(error) });
        throw error;
      } finally { closeSync(file); }
    },
    finish() {
      writeFileSync(join(desktopDirectory, 'dist', `${name}-result.json`), JSON.stringify(results, null, 2) + '\n');
      console.log(`${name}: ${results.length} commands passed`);
    },
  };
}
