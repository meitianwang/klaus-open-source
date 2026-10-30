import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createGate, desktopDirectory } from './gate-runner.mjs';

// This opt-in integration gate downloads only into its own reusable test profile.
// Normal host tests exercise installer failures and cancellation without network.
const require = createRequire(import.meta.url);
const { WorkspaceDependenciesManager } = require('../dist/main/services/workspace-dependencies.js');
const { registerWorkspaceDependencyTool } = require('../dist/main/services/workspace-dependency-tools.js');
const gate = createGate('workspace-pdf-gate');
const logs = join(desktopDirectory, 'dist', 'workspace-pdf-gate-logs');
const resources = resolve(desktopDirectory, 'resources');
const manager = new WorkspaceDependenciesManager({
  rootDir: join(desktopDirectory, 'dist', 'workspace-pdf-test-profile', 'workspace-runtime'),
  resourcesDir: join(resources, 'workspace-runtime'), logPath: join(logs, 'runtime.log'),
});
const cancel = () => { void manager.close(); };
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  let handler;
  registerWorkspaceDependencyTool({ register(spec, execute) {
    assert.equal(spec.name, 'load_workspace_dependencies'); handler = execute;
  } }, manager, join(resources, 'workspace-skills'), () => ({ local: true, assertCurrent() {} }));
  console.log('Preparing the managed runtime in the isolated PDF test profile.');
  const reply = await handler({}, 'fixture', new AbortController().signal, 'fixture', 'fixture');
  mkdirSync(logs, { recursive: true });
  writeFileSync(join(logs, 'tool-result.json'), JSON.stringify(reply, null, 2) + '\n');
  if (!reply.success) throw new Error(`Runtime preparation failed: ${JSON.stringify(reply)}`);
  const details = JSON.parse(reply.contentItems[0].text);
  assert.equal(details.state, 'ready');
  assert.equal(details.pdfHelperPath, join(resources, 'workspace-skills', 'pdf', 'scripts', 'pdf.py'));
  readFileSync(details.pdfHelperPath);
  console.log(`Managed runtime ready: ${details.version}`);
  await gate.run('pdf-helper', details.pythonPath, ['-I', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'pdf_skill_test.py', '-v'], { timeout: 120_000 });
  // A new manager must verify and reuse the persisted installation.
  const reopened = new WorkspaceDependenciesManager({
    rootDir: join(desktopDirectory, 'dist', 'workspace-pdf-test-profile', 'workspace-runtime'),
    resourcesDir: join(resources, 'workspace-runtime'), logPath: join(logs, 'runtime.log'),
    fetch: async () => { throw new Error('A healthy runtime must not download again.'); },
  });
  try {
    const reused = await reopened.ensure();
    assert.equal(reused.state, 'ready', reused.error);
    assert.equal(reused.pythonPath, details.pythonPath);
    console.log('Persisted runtime revalidated and reused without downloading.');
  } finally { await reopened.close(); }
  gate.finish();
} finally {
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel);
  await manager.close();
}
