import { join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { throws } from 'node:assert/strict';
import { instanceIdentity } from '../main/app/instance-identity';
import { DesktopInstanceGuard, instanceActivation } from '../main/native/instance-guard';
import { NativeInstanceGuardBinding } from '../main/native/binding';
import { Harness, assert, assertDeepEqual, assertEqual, waitFor } from './harness';

const h = new Harness();
h.test('packaged applications always share the legacy identity even with fixture environment variables', () => {
  assertEqual(instanceIdentity({ packaged: true, configRoot: '/fixture', defaultConfigRoot: '/default', env: { KLAUS_TEST: '1', KLAUS_CONFIG_DIR: '/fixture', KLAUS_INSTANCE_FIXTURE_ID: 'ai.klaus.instance-fixture.fake' } }), 'ai.klaus.desktop', 'no packaged bypass');
  assertEqual(instanceIdentity({ packaged: false, configRoot: '/fixture', defaultConfigRoot: '/default', env: { KLAUS_TEST: '1', KLAUS_CONFIG_DIR: '/fixture' } }), 'ai.klaus.desktop', 'test env alone cannot bypass ownership');
});
h.test('an isolated development identity requires an existing independent profile and explicit test intent', () => {
  const directory = mkdtempSync(join(tmpdir(), 'klaus-instance-identity-'));
  try {
    const profile = join(directory, 'profile'), defaultRoot = join(directory, 'default'); mkdirSync(profile); mkdirSync(defaultRoot);
    const options = { packaged: false, configRoot: profile, defaultConfigRoot: defaultRoot, env: { KLAUS_TEST: '1', KLAUS_CONFIG_DIR: profile, KLAUS_INSTANCE_FIXTURE_ID: 'ai.klaus.instance-fixture.unit' } };
    assertEqual(instanceIdentity(options), 'ai.klaus.instance-fixture.unit', 'explicit fixture');
    throws(() => instanceIdentity({ ...options, configRoot: defaultRoot }), /independent/);
    throws(() => instanceIdentity({ ...options, env: { ...options.env, KLAUS_TEST: undefined } }), /explicit/);
    throws(() => instanceIdentity({ ...options, env: { ...options.env, KLAUS_INSTANCE_FIXTURE_ID: 'ai.klaus.desktop.other' } }), /explicit/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
function binding(acquired = true) {
  let closed = false, finish: ((event: string | null) => void) | undefined;
  const fake: NativeInstanceGuardBinding = {
    acquisition: () => JSON.stringify({ acquired, forwarded: !acquired, acknowledged: false }),
    assertHeld: () => { if (closed) throw new Error('INSTANCE_NOT_HELD'); },
    report: () => JSON.stringify({ acquired, held: acquired && !closed, complete: closed, error: null }),
    readEvent: () => new Promise(resolve => { finish = resolve; }),
    closeSync: () => { closed = true; finish?.(null); return fake.report(); },
  };
  return { fake, send: (event: unknown) => { assert(finish, 'reader attached'); const resolve = finish; finish = undefined; resolve(JSON.stringify(event)); } };
}
h.test('activation only forwards one canonical existing deep-link action', () => {
  assertDeepEqual(instanceActivation(['Klaus', '--profile=/secret', 'https://example.com', 'klaus://settings?injected=1', 'klaus://new']), { deepLink: 'klaus://settings' }, 'discard flags, query and later URL');
  assertDeepEqual(instanceActivation(['klaus://open?session=thread_123', 'klaus://settings']), { deepLink: 'klaus://open/thread_123' }, 'canonical session');
  assertDeepEqual(instanceActivation(['klaus://open/..%2fsecret', 'file:///secret', 'klaus://user:pass@new']), {}, 'invalid paths and authorities are only focus');
  assertDeepEqual(instanceActivation(['klaus:friend?v=1&email=owner%40example.com']), { deepLink: 'klaus:friend?v=1&email=owner%40example.com' }, 'friend invite keeps its email payload');
  assertDeepEqual(instanceActivation(['klaus:friend?v=1']), {}, 'payload-less friend link is only focus');
});
h.test('acquire is synchronous and no event reader starts before explicit listen', async () => {
  const f = binding(); let yielded = false, input: unknown; queueMicrotask(() => { yielded = true; });
  const result = DesktopInstanceGuard.acquireWithBinding({ identity: 'ai.klaus.instance-fixture.unit', argv: ['--user-data-dir=/other', 'klaus://new'] }, raw => { input = JSON.parse(raw); return f.fake; });
  assert(!yielded, 'acquisition returned before first yield'); assert(result.acquired, 'primary acquired');
  assertDeepEqual(input, { identity: 'ai.klaus.instance-fixture.unit', cwd: '', args: ['Klaus', 'klaus://new'], timeoutMs: 2000 }, 'no cwd or arbitrary args reach old process');
  result.guard.assertHeld(); await result.guard.close();
});
h.test('international guard sanitizes outgoing and incoming activations with the same protocol', async () => {
  const f = binding(), protocol = 'klaus-international'; let input: { identity: string; args: string[] } | undefined;
  const result = DesktopInstanceGuard.acquireWithBinding({ identity: 'ai.klaus.desktop.international', protocol, argv: ['klaus://new', protocol + '://settings'] }, raw => { input = JSON.parse(raw); return f.fake; });
  assertDeepEqual(input?.args, ['Klaus', protocol + '://settings'], 'foreign activation discarded');
  assertEqual(input?.identity, 'ai.klaus.desktop.international', 'real international identity');
  assert(result.acquired, 'primary'); const events: unknown[] = [];
  result.guard.listen({ onActivation: event => events.push(event), onLost: error => { throw error; } });
  f.send({ kind: 'activation', cwd: '', args: ['klaus://settings'] });
  await waitFor(() => events.length === 1, 1000, 'foreign activation'); assertDeepEqual(events[0], {}, 'foreign link cannot reach application');
  f.send({ kind: 'activation', cwd: '', args: [protocol + '://open/thread_123'] });
  await waitFor(() => events.length === 2, 1000, 'local activation'); assertDeepEqual(events[1], { deepLink: protocol + '://open/thread_123' }, 'local link retained');
  await result.guard.close();
});
h.test('secondary reports unacknowledged legacy transport and cleans only its resource', () => {
  const f = binding(false);
  assertDeepEqual(DesktopInstanceGuard.acquireWithBinding({ identity: 'ai.klaus.instance-fixture.unit', argv: [] }, () => f.fake), { acquired: false, forwarded: true, acknowledged: false }, 'no fabricated activation acknowledgement');
  assert(JSON.parse(f.fake.report()).complete, 'secondary native resource drained');
});
h.test('endpoint loss reaches the application and close drains the event waiter', async () => {
  const f = binding(); const result = DesktopInstanceGuard.acquireWithBinding({ identity: 'ai.klaus.instance-fixture.unit', argv: [] }, () => f.fake);
  assert(result.acquired, 'primary'); const events: unknown[] = [], failures: string[] = [];
  result.guard.listen({ onActivation: value => events.push(value), onLost: failure => failures.push(failure.message) });
  f.send({ kind: 'activation', cwd: '/untrusted', args: ['--execute=bad', 'klaus://settings'] });
  await waitFor(() => events.length === 1, 1000, 'activation'); assertDeepEqual(events, [{ deepLink: 'klaus://settings' }], 'sanitized event');
  f.send({ kind: 'lost', code: 'INSTANCE_ENDPOINT_LOST' }); await waitFor(() => failures.length === 1, 1000, 'lost callback');
  assertEqual(failures[0], 'INSTANCE_ENDPOINT_LOST', 'fatal event'); assert((await result.guard.close()).complete, 'close complete');
});
void h.finish(join(__dirname, 'instance-guard-result.json'), 'instance-guard').then(code => { process.exitCode = code; });
