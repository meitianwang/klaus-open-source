#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { spawnElectronGuiSync } from './electron-test-preflight.cjs';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), electron = createRequire(import.meta.url)('electron');
const onlyElectron = process.argv.includes('--electron-only'), nodeOnly = process.argv.includes('--node-only');
const profile = mkdtempSync(join(tmpdir(), 'klaus-feedback-electron-'));
try {
  for (const suite of [...(onlyElectron ? [] : ['external-agent-import', 'feedback']), ...(nodeOnly ? [] : ['feedback-electron'])]) {
    const env = { ...process.env, KLAUS_FEEDBACK_FIXTURE_PROFILE: profile }; if (suite.endsWith('-electron')) delete env.ELECTRON_RUN_AS_NODE; else env.ELECTRON_RUN_AS_NODE = '1';
    const launch = suite.endsWith('-electron') ? spawnElectronGuiSync : spawnSync;
    const result = launch(electron, [join(root, 'dist/tests/' + suite + '.test.js')], { cwd: root, env, stdio: 'inherit', windowsHide: true, timeout: 60_000 });
    if (result.error) throw result.error; if (result.status !== 0) process.exitCode = 1;
  }
} finally { rmSync(profile, { recursive: true, force: true }); }
