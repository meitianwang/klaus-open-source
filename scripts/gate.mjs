import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createGate } from './gate-runner.mjs';

const require = createRequire(import.meta.url), gate = createGate('desktop-gate');
const tsc = require.resolve('typescript/bin/tsc');
await gate.run('electron-test-preflight', process.execPath, ['--test', 'scripts/electron-test-preflight.test.cjs']);
// The development launcher's profile and instance identity are pure logic, so they are pinned
// here rather than only by the GUI lifecycle fixture: a regression re-silences a failed launch.
await gate.run('dev-launch-profile', process.execPath, ['--test', 'scripts/dev-profile.test.mjs']);
await gate.run('test-engine-preparation', process.execPath, ['--test', 'scripts/prepare-test-engine.test.mjs']);
await gate.run('host-types', process.execPath, [tsc, '-p', 'tsconfig.json', '--noEmit']);
await gate.run('native-types', process.execPath, [tsc, '-p', 'tsconfig.native-bindings.json']);
await gate.run('frontend-types', process.execPath, [tsc, '-p', 'tsconfig.frontend.json', '--noEmit']);
await gate.run('canvas-types', process.execPath, [tsc, '-p', 'tsconfig.canvas-sdk.json']);
await gate.run('host-build', process.execPath, [tsc, '-p', 'tsconfig.build.json']);
await gate.run('preload-build', process.execPath, ['scripts/build-preload.mjs']);
await gate.run('frontend-build', process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'), 'build', '--config', 'vite.config.mts']);
await gate.run('syntax-data-assets', process.execPath, ['--test', 'scripts/shiki-data-assets.test.mjs']);
await gate.run('diagram-parser-modules', process.execPath, ['--test', 'scripts/test-frontend-parser-modules.mjs']);
await gate.run('host-tests', process.execPath, ['scripts/run-tests.mjs']);
// A relative path keeps Bun from treating the argument as a filter over staging trees.
await gate.run('frontend-tests', 'bun', ['test', './frontend/src']);
await gate.run('composer-prediction-editor', process.execPath, ['scripts/run-composer-prediction-test.mjs']);
await gate.run('composer-prediction-settings', process.execPath, ['scripts/run-composer-prediction-settings-test.mjs']);
await gate.run('settings-navigation', process.execPath, ['scripts/run-settings-navigation-test.mjs']);
await gate.run('storage-settings', process.execPath, ['scripts/run-settings-navigation-test.mjs', '--storage']);
await gate.run('browser-tab-mentions-gui', process.execPath, ['scripts/run-browser-tab-mentions-test.mjs']);
await gate.run('subagent-lifecycle', process.execPath, ['scripts/run-subagent-lifecycle-test.mjs']);
await gate.run('workspace-file-browser', process.execPath, ['scripts/run-workspace-file-browser-test.mjs']);
await gate.run('diagram-layout-worker', process.execPath, ['scripts/run-diagram-layout-test.mjs']);
await gate.run('editor-dependency-assets', process.execPath, ['scripts/run-editor-assets-test.mjs']);
await gate.run('hooks-settings', process.execPath, ['scripts/run-hooks-settings-test.mjs']);
// The native gate owns Cargo sequentially. Do not run an engine Cargo gate in
// parallel with this aggregate on the same machine.
await gate.run('native-tests', process.execPath, ['scripts/test-native.mjs']);
await gate.run('companion-native-window', process.execPath, ['scripts/run-pet-window-native-test.mjs']);
await gate.run('companion-production-app', process.execPath, ['scripts/run-desktop-pet-app-test.mjs']);
await gate.run('packaging-tests', process.execPath, ['scripts/test-packaging.mjs']);
await gate.run('channel-audit', process.execPath, ['scripts/audit-runtime-channels.mjs']);
await gate.run('planning-goals-app', process.execPath, ['scripts/run-planning-goals-test.mjs']);
await gate.run('goal-controls-recovery', process.execPath, ['scripts/run-goal-controls-test.mjs']);
await gate.run('follow-up-queue', process.execPath, ['scripts/run-follow-up-queue-test.mjs']);
gate.finish();
