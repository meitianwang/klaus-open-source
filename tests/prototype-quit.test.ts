import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { transformSync } from 'esbuild';
import * as ts from 'typescript';
import { assert, assertEqual, Harness, waitFor } from './harness';

const logs = resolve(__dirname, '../prototype-figcraft-logs');
mkdirSync(logs, { recursive: true });
const source = ts.createSourceFile('index.ts', readFileSync(resolve(__dirname, '../../main/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
let callback: ts.ArrowFunction | undefined;
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText(source) === 'app' && node.expression.name.text === 'on'
    && node.arguments[0] !== undefined && node.arguments[1] !== undefined
    && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'before-quit'
    && ts.isArrowFunction(node.arguments[1])) callback = node.arguments[1];
  ts.forEachChild(node, visit);
}
visit(source);
assert(callback, 'the application registers its quit callback');
const code = transformSync(`const registeredQuit = ${callback.getText(source)};`, { loader: 'ts', target: 'node22' }).code;

// Exercise the registered production callback with external resources injected.
function scenario(options: { saveFails?: boolean; videoFails?: boolean; shutdownFails?: boolean; ownershipLost?: boolean; saveWait?: Promise<void> } = {}) {
  const calls: string[] = [];
  const state = { saveFails: options.saveFails === true };
  const context = createContext({
    quitting: false, quitReady: false, ownershipFailure: options.ownershipLost ? new Error('Profile ownership lost') : undefined,
    preparation: Promise.resolve(), startup: Promise.resolve(), process: { connected: false },
    console: { error: () => { calls.push('error'); } },
    app: { isReady: () => true, isPackaged: true, exit: (code: number) => { calls.push(`exit:${code}`); }, quit: () => { calls.push('quit'); } },
    runtime: {
      prototype: {
        prepareToClose: async () => { calls.push('save'); if (options.saveWait) await options.saveWait; if (state.saveFails) throw new Error('Design is still unsaved'); },
        abortClosePreparation: () => { calls.push('restore-design'); },
      },
      videoEditing: {
        prepareToClose: async () => { calls.push('video-save'); if (options.videoFails) throw new Error('Video export is active'); },
        abortClosePreparation: () => { calls.push('restore-video'); },
      },
      shutdown: async () => { calls.push('shutdown'); if (options.shutdownFails) throw new Error('Shutdown failed'); },
      show: () => { calls.push('show'); },
    },
    guard: { close: async () => { calls.push('release-lock'); } },
    dialog: { showErrorBox: () => { calls.push('save-error'); } },
  });
  const handler = runInContext(`${code}\nregisteredQuit`, context) as (event: { preventDefault(): void }) => void;
  return { calls, state, context, request: () => handler({ preventDefault: () => { calls.push('prevent-quit'); } }) };
}

const h = new Harness();
h.test('a failed design save retains the runtime and ownership lock, and quitting can be retried', async () => {
  const run = scenario({ saveFails: true });
  run.request();
  await waitFor(() => run.calls.includes('save-error'), 1000, 'the failed save is reported');
  assertEqual(run.context.quitting, false, 'a blocked quit does not latch the application into quitting');
  assertEqual(run.context.quitReady, false, 'the next quit must still run its save barrier');
  assert(run.calls.includes('show'), 'the user can return to the editor');
  assert(!run.calls.includes('shutdown') && !run.calls.includes('release-lock') && !run.calls.includes('quit') && !run.calls.some(call => call.startsWith('exit:')), 'the live editor and profile lock survive');
  run.state.saveFails = false;
  run.request();
  await waitFor(() => run.calls.includes('quit'), 1000, 'retry exits after saving');
  assertEqual(run.calls.filter(call => call === 'save').length, 2, 'retry saves again');
  assertEqual(run.calls.filter(call => call === 'shutdown').length, 1, 'resources close once');
  assert(run.calls.indexOf('shutdown') < run.calls.indexOf('release-lock') && run.calls.indexOf('release-lock') < run.calls.indexOf('quit'), 'the profile lock is released after its owners close');
});
h.test('lost profile ownership still forces exit even if an editor save would fail', async () => {
  const run = scenario({ saveFails: true, shutdownFails: true, ownershipLost: true });
  run.request();
  await waitFor(() => run.calls.includes('exit:1'), 1000, 'ownership loss is terminal');
  assert(!run.calls.includes('save-error') && !run.calls.includes('save'), 'a recoverable save dialog cannot block lost ownership');
  assert(!run.calls.includes('release-lock'), 'failed resource teardown keeps the lock until process exit');
});
h.test('a video close refusal restores both editors before returning to the live application', async () => {
  const run = scenario({ videoFails: true });
  run.request();
  await waitFor(() => run.calls.includes('save-error'), 1000, 'video refusal is reported');
  assert(run.calls.includes('restore-design') && run.calls.includes('restore-video'), 'all prepared editors are restored');
  assert(!run.calls.includes('shutdown') && !run.calls.includes('release-lock'), 'resources remain owned');
  assertEqual(run.context.quitting, false, 'quit can be retried');
});
h.test('ownership lost during a pending save remains terminal', async () => {
  let release = () => {};
  const saveWait = new Promise<void>(resolve => { release = resolve; });
  const run = scenario({ saveFails: true, saveWait });
  run.request();
  await waitFor(() => run.calls.includes('save'), 1000, 'the save is pending');
  run.context.ownershipFailure = new Error('Profile ownership lost');
  release();
  await waitFor(() => run.calls.includes('exit:1'), 1000, 'ownership loss during saving is terminal');
  assert(!run.calls.includes('save-error') && !run.calls.includes('release-lock'), 'a stale preflight check cannot reopen a profile owned by another process');
});
h.test('a teardown failure after saving retains the existing terminal shutdown behavior', async () => {
  const run = scenario({ shutdownFails: true });
  run.request();
  await waitFor(() => run.calls.includes('exit:1'), 1000, 'failed teardown exits');
  assert(run.calls.indexOf('save') < run.calls.indexOf('shutdown'), 'the save barrier precedes destructive teardown');
  assert(!run.calls.includes('save-error') && !run.calls.includes('release-lock'), 'terminal teardown errors cannot reopen partially closed resources');
});
void h.finish(join(logs, 'quit-result.json'), 'prototype-quit').then(code => { process.exitCode = code; });
