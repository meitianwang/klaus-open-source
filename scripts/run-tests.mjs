import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { prepareTestEngine } from './prepare-test-engine.mjs';

const require = createRequire(import.meta.url);
const executable = require('electron');
const root = fileURLToPath(new URL('..', import.meta.url));
const suites = [
  'source-isolation', 'source-selection-memory', 'antigravity', 'trae', 'kiro', 'media-inputs', 'composer-predictions', 'prediction-query', 'owned-edit-menu', 'menu-diagnostics', 'native-content-find',
  'browser-file-upload', 'browser-file-upload-extension', 'browser-debugger-session', 'browser-settings', 'browser-history', 'browser-input-cancellation', 'browser-profile-import', 'browser-profile-import-service', ...(process.platform === 'darwin' ? ['browser-profile-decryptor'] : []), 'browser-profile-import-helper', 'browser-credentials', 'browser-extensions',
  'power-save', 'desktop-log', 'session-view-interests',
  'voice-chat',
  'workspace-dependencies', 'workspace-dependency-tools', 'workspace-dependency-settings', 'workspace-skills',
  'skill-watcher', 'skill-reload-live',
  'git-diff', 'git-review-actions', 'last-turn-changes', 'browser-tab-mention', 'site-open', 'end-resource-open', 'chrome-tab-mentions', 'chrome-relay', 'chrome-setup',
  'team-collaboration',
  'feature-gates', 'desktop-edition', 'desktop-regional-profile',
  'resume-recovery',
  'mobile-transport', 'mobile-load-diagnostics',
  'system-trust', 'pending-turns', 'friends', 'friends-async', 'friend-conversation-groups', 'friends-receiver-lifecycle', 'friends-interactions', 'remote-thread-client', 'remote-thread-tools', 'mobile-catalog', 'mobile-push',
  'model-updates', 'ultra-mode', 'native-fast-mode', 'runtime-settings', 'runtime-settings-live',
  'html-preview', 'artifact-paths', 'inline-visualization', 'inline-visualization-dom', 'inline-visualization-wheel', 'visual-artifact-card-dom', 'ui-screenshot-delivery', 'image-zoom-commands', 'media-generation', 'qoder-media-facade', 'session-closing',
  'connectors-runtime', 'retired-private-sessions', 'windows-sandbox-setup', 'private-directory', 'settings-backup', 'legacy-ui-state', 'instance-guard', 'updater-profile', 'thread-tools-live', 'klaus-control', 'keymap', 'native-menu-labels', 'device-mention', 'conversation-mention',
  'device-storage', 'worktree-storage',
  'macos-organizers', 'macos-notes', 'macos-communications', 'macos-safari', 'macos-app-ui', 'macos-photos', 'notifications',
  'engine-protocol', 'engine-manager', 'startup-failure', 'ipc-router', 'ipc-contract', 'voice', 'voice-runtime', 'voice-streaming', 'pip', 'pip-runtime', 'recording', 'computer-use', 'computer-use-policy', 'documents', 'agent-tasks', 'auxiliary', 'composer-edit-commands', 'quick-input-delivery', 'updater-policy', 'updater', 'updater-handoff', 'permission-rules-live', 'skills-market', 'plugin-marketplaces', 'plugin-updates', 'official-plugins', 'extension-market-live', 'mcp-builtins', 'mcp-device', 'mcp-device-live', 'external-agent-import', 'external-agent-import-live', 'external-import-live', 'feedback',
  'ipc-binding', 'ipc-delivery', 'project', 'session-wire', 'session-fork-title', 'session-fork-cleanup', 'turn-reply', 'channel-turns', 'host-mcp', 'session-lifecycle', 'stored-history', 'thread-history-source', 'session-titles', 'side-tasks', 'session-side-tasks', 'session-mentions', 'side-questions', 'turn-input', 'follow-ups', 'client-queue', 'engine-client-queue', 'session-events', 'session-queries', 'profile-activity-diagnostic-log', 'hooks-trust', 'services', 'remote-workspace', 'tool-media', 'media-files', 'widgets', 'attachments', 'cron-runtime', 'mobile-bridge', 'macos-connectors', 'macos-system', 'dream', 'memory-snapshots', 'memory-snapshots-live', 'windows-profile', 'desktop-paths', 'engine-settings', 'engine-web-settings', 'directory-leases', 'browser-downloads', 'browser-reading', 'browser-locator', 'browser-policy', 'run-preview', 'browser-mcp-cancellation', 'canvas', 'model3d', 'model3d-kernel-geometry', 'model3d-authoring', 'model3d-gltf', 'model3d-production', 'digram', 'visual-artifacts', 'engine-live', 'extensions-live', 'plugins-live', 'mcp-configuration-live', 'mcp-auth-live', 'thread-wait-signals', 'model-tier-catalog', 'session-binding-recovery', 'session-interrupt-window',
  'host-prompt-policy', 'reply-prompt-contract', 'desktop-pet-activity', 'desktop-pet-summary', 'desktop-pet-realtime', 'desktop-pet-realtime-provider', 'desktop-pet-appshot', 'desktop-pet-presentation', 'desktop-pet-workflow', 'media-generation-publication', 'desktop-pet-host',
  'pasted-text', 'planning-goals', 'turn-interrupt', 'media-scope',
];
const selected = process.argv.slice(2);
for (const suite of selected) {
  if (!suites.includes(suite)) throw new Error(`Unknown host test suite: ${suite}`);
}

if (!selected.length || selected.some(name => ['skill-reload-live', 'engine-live', 'extensions-live', 'plugins-live', 'mcp-configuration-live', 'mcp-auth-live', 'permission-rules-live', 'extension-market-live', 'external-agent-import-live', 'external-import-live', 'mcp-device-live', 'memory-snapshots-live', 'thread-tools-live', 'runtime-settings-live'].includes(name))) {
  prepareTestEngine(root);
}

// Exercise the host's shipped Node runtime, including its SQLite implementation.
// This does not replace integration tests inside a normal Electron application.
for (const suite of selected.length ? selected : suites) {
  if (suite === 'browser-profile-decryptor') {
    const built = spawnSync(process.execPath, ['native/browser-import/build-macos-helper.mjs', '--mode', 'test', '--arch', process.arch, '--output', 'dist/browser-import-decrypt-test/browser-import-decrypt-test'], { cwd: root, stdio: 'inherit' });
    if (built.error) throw built.error;
    if (built.status !== 0) process.exit(built.status ?? 1);
  }
  const nodeTest = suite === 'menu-diagnostics' || suite === 'native-content-find' || suite === 'browser-file-upload' || suite === 'browser-file-upload-extension' || suite === 'browser-debugger-session' || ['workspace-dependencies', 'workspace-dependency-tools', 'workspace-dependency-settings', 'workspace-skills', 'worktree-storage'].includes(suite) || suite === 'mobile-push' || suite === 'team-collaboration' || suite === 'run-preview' || suite === 'widgets' || suite === 'inline-visualization-dom' || suite === 'inline-visualization-wheel' || suite === 'visual-artifact-card-dom' || suite === 'ui-screenshot-delivery' || suite === 'chrome-tab-mentions';
  const result = await new Promise((resolveResult, reject) => {
    // node:test owns its worker exit status; the legacy guard would force every
    // passing worker to exit 1. Both runners still require a complete report below.
    const runner = nodeTest ? ['--test', '--test-reporter=tap'] : ['--require', resolve(root, 'scripts/test-exit-guard.cjs')];
    const testEntry = suite === 'desktop-pet-host' ? 'tests/desktop-pet-host.cjs' : ['chrome-tab-mentions', 'browser-file-upload-extension'].includes(suite) ? `tests/${suite}.test.mjs` : `dist/tests/${suite}.test.js`;
    const child = spawn(executable, [...runner, testEntry], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KLAUS_ENGINE_BINARY: resolve(root, 'resources/bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'klaus-agent-stdio.exe' : 'klaus-agent-stdio') },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
    });
    let tail = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { process.stdout.write(chunk); tail = (tail + chunk).slice(-65_536); });
    child.stderr.on('data', chunk => process.stderr.write(chunk));
    child.on('error', reject);
    child.on('close', (status, signal) => resolveResult({ status, signal, tail }));
  });
  if (result.status !== 0) {
    if (result.signal) console.error(`Host test ${suite} terminated by ${result.signal}`);
    process.exit(result.status ?? 1);
  }
  if (nodeTest) {
    const count = key => [...result.tail.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))].map(match => Number(match[1]));
    const tests = count('tests'), passed = count('pass');
    if (tests.length !== 1 || tests[0] < 1 || passed.length !== 1 || passed[0] !== tests[0]
      || ['fail', 'cancelled', 'skipped'].some(key => { const values = count(key); return values.length !== 1 || values[0] !== 0; })) {
      throw new Error(`Host test ${suite} did not complete every node:test assertion successfully`);
    }
    continue;
  }
  const reports = [...result.tail.matchAll(new RegExp(`^${suite}: (\\d+) passed, (\\d+) failed, (\\d+) info$`, 'gm'))];
  if (reports.length !== 1 || Number(reports[0][1]) < 1 || Number(reports[0][2]) !== 0) {
    throw new Error(`Host test ${suite} exited without one complete successful assertion report`);
  }
}
