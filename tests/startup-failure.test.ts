// The fatal startup dialog must never print `[object Object]`: the engine RPC client
// rejects with bare `RpcError` records, so a startup path that awaits the engine can
// hand the dialog a plain object, and `String()` on it hides the only record of why
// the app refused to come up.

import { join } from 'node:path';
import { describeStartupFailure } from '../main/app/startup-failure';
import { assert, assertEqual, Harness } from './harness';

const h = new Harness();

h.test('an Error keeps its stack for the dialog', () => {
  const error = new Error('engine startup failed: app-server client closed');
  assert(describeStartupFailure(error).includes('engine startup failed'), 'message survives');
});

h.test('a bare RPC rejection record is rendered as JSON, not [object Object]', () => {
  const rendered = describeStartupFailure({ kind: 'closed' });
  assertEqual(rendered, '{"kind":"closed"}', 'record renders as JSON');
  assert(!rendered.includes('[object Object]'), 'no [object Object]');
});

h.test('a server RPC record keeps its code and message', () => {
  const rendered = describeStartupFailure({ kind: 'server', code: -32603, message: 'config.toml is not valid TOML' });
  assert(rendered.includes('-32603') && rendered.includes('config.toml'), `fields survive: ${rendered}`);
});

h.test('a circular value falls back instead of throwing', () => {
  const circular: Record<string, unknown> = { kind: 'io' };
  circular.self = circular;
  const rendered = describeStartupFailure(circular);
  assert(rendered.length > 0 && !rendered.includes('[object Object]'), `readable fallback: ${rendered}`);
});

h.test('primitives pass through', () => {
  assertEqual(describeStartupFailure('boom'), 'boom', 'string passes through');
  assertEqual(describeStartupFailure(7), '7', 'number passes through');
  assertEqual(describeStartupFailure(null), 'null', 'null passes through');
});

void (async () => { process.exit(await h.finish(join(__dirname, 'startup-failure-result.json'), 'startup-failure')); })();
