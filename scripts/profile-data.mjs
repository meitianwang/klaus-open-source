import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
if (!process.versions.electron) {
  const child = spawnSync(require('electron'), [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', timeout: 60_000,
  });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const [action, ...args] = process.argv.slice(2);
if (action === '--help' || action === undefined) {
  process.stdout.write('Usage: profile-data.mjs backup --config-root <profile>\n       profile-data.mjs inspect --snapshot <directory>\n       profile-data.mjs restore --snapshot <directory> --new-profile <new directory>\nRestore creates a separate profile and never overwrites current data. Only settings.db is restored.\n');
  process.exit(action ? 0 : 1);
}
const allowed = { backup: ['--config-root'], inspect: ['--snapshot'], restore: ['--snapshot', '--new-profile'] }[action];
if (!allowed) throw new Error('Unknown profile-data action');
const values = new Map();
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!allowed.includes(name) || values.has(name) || !value || value.startsWith('--')) throw new Error('Invalid or duplicate profile-data argument');
  values.set(name, resolve(value));
}
if (allowed.some(name => !values.has(name))) throw new Error('Missing profile-data argument; use --help');
const { ensureSettingsBackup, inspectSettingsBackup, restoreSettingsBackup } = require('../dist/main/app/settings-backup.js');
if (action === 'backup') process.stdout.write(`${JSON.stringify(await ensureSettingsBackup(values.get('--config-root')))}\n`);
if (action === 'inspect') {
  const value = await inspectSettingsBackup(values.get('--snapshot'));
  process.stdout.write(`${JSON.stringify({ valid: true, createdAt: value.createdAt, database: value.database ? { file: value.database.file, size: value.database.size, sha256: value.database.sha256, userVersion: value.database.userVersion, tableCount: value.database.tables.length } : null })}\n`);
}
if (action === 'restore') {
  await restoreSettingsBackup(values.get('--snapshot'), values.get('--new-profile'));
  process.stdout.write(`${JSON.stringify({ restored: true, profile: values.get('--new-profile'), scope: 'settings.db only' })}\n`);
}
