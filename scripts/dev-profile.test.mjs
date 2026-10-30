import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'

import {
  DEFAULT_DEV_PROFILE_NAME,
  INSTANCE_FIXTURE_PATTERN,
  PRODUCTION_INSTANCE_IDENTITY,
  describeEarlyExit,
  devLaunchEnvironment,
  ensureProfileDirectory,
  expandHomePrefix,
  homeFromEnvironment,
  instanceIdentityFor,
  readProfileOwner,
  resolveDevProfile,
} from './dev-profile.mjs'

// A running Klaus injects these into every shell it spawns, so `./dev.sh` typed in the app's
// own terminal starts out pointing at the REAL profile. This is the state every test below
// treats as the default, because it is the state a developer actually hits.
const inheritedFromRunningApp = {
  HOME: '/Users/dev',
  KLAUS_CONFIG_DIR: '/Users/dev/.klaus',
  KLAUS_PLUGIN_HOME: '/Users/dev/.klaus/plugins',
}

test('a development launch defaults to its own profile and can run beside the installed app', () => {
  const plan = resolveDevProfile({ env: inheritedFromRunningApp, defaultHome: '/Users/dev' })
  assert.equal(plan.isolated, true)
  assert.equal(plan.configRoot, join('/Users/dev', DEFAULT_DEV_PROFILE_NAME))
  // The installed app uses the production identity; two holders of it means one silently loses.
  assert.notEqual(plan.identity, PRODUCTION_INSTANCE_IDENTITY)
  assert.match(plan.identity, INSTANCE_FIXTURE_PATTERN)
})

test('an inherited redirect to the real profile is overwritten, never honoured', () => {
  const plan = resolveDevProfile({ env: inheritedFromRunningApp, defaultHome: '/Users/dev' })
  const env = devLaunchEnvironment({ base: inheritedFromRunningApp, plan })
  assert.equal(env.KLAUS_CONFIG_DIR, plan.configRoot, 'the injected real profile must not survive')
  assert.equal(env.KLAUS_TEST, '1', 'the host accepts a fixture identity only with explicit test intent')
  assert.equal(env.KLAUS_INSTANCE_FIXTURE_ID, plan.identity)
})

test('the plugin home is dropped so the engine derives it from the development profile', () => {
  const plan = resolveDevProfile({ env: inheritedFromRunningApp, defaultHome: '/Users/dev' })
  const env = devLaunchEnvironment({ base: inheritedFromRunningApp, plan })
  // `main/engine/spawn.ts` derives KLAUS_PLUGIN_HOME from the config root ONLY when it is
  // absent, so an inherited value would leave the engine writing the installed profile's ledger.
  assert.equal('KLAUS_PLUGIN_HOME' in env, false)
  assert.equal('KLAUS_SESSION_DIR' in env, false)
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined, 'an inherited Node mode would break the GUI launch')
})

test('--shared-profile keeps the installed profile and its identity', () => {
  const plan = resolveDevProfile({ sharedProfile: true, env: inheritedFromRunningApp, defaultHome: '/Users/dev' })
  assert.equal(plan.isolated, false)
  assert.equal(plan.configRoot, '/Users/dev/.klaus')
  assert.equal(plan.identity, PRODUCTION_INSTANCE_IDENTITY)
  const env = devLaunchEnvironment({ base: inheritedFromRunningApp, plan })
  assert.equal(env.KLAUS_CONFIG_DIR, '/Users/dev/.klaus', 'a shared launch must not be redirected')
  assert.equal('KLAUS_TEST' in env, false)
  assert.equal('KLAUS_INSTANCE_FIXTURE_ID' in env, false)
})

test('a profile override that lands on the installed profile is refused with its reason', () => {
  assert.throws(
    () => resolveDevProfile({ profileOverride: '/Users/dev/.klaus', env: inheritedFromRunningApp, defaultHome: '/Users/dev' }),
    /installed application's profile|independent profile/,
  )
  assert.throws(
    () => resolveDevProfile({ sharedProfile: true, profileOverride: '/tmp/x', env: inheritedFromRunningApp, defaultHome: '/Users/dev' }),
    /cannot be combined/,
  )
})

test('a profile override is resolved like the host resolves one and must be absolute', () => {
  const explicit = resolveDevProfile({ profileOverride: '/tmp/klaus-dev-second', env: inheritedFromRunningApp, defaultHome: '/Users/dev' })
  assert.equal(explicit.configRoot, '/tmp/klaus-dev-second')
  assert.equal(explicit.identity, 'ai.klaus.instance-fixture.klaus-dev-second')
  const tilde = resolveDevProfile({ profileOverride: '~/klaus-dev-second', env: inheritedFromRunningApp, defaultHome: '/Users/dev' })
  assert.equal(tilde.configRoot, '/Users/dev/klaus-dev-second', 'a ~ prefix expands like the host expands one')
  assert.equal(expandHomePrefix('~/klaus-dev-second', '/Users/dev'), tilde.configRoot)
  assert.throws(() => resolveDevProfile({ profileOverride: 'relative/dir', env: inheritedFromRunningApp, defaultHome: '/Users/dev' }), /absolute/)
  assert.throws(() => resolveDevProfile({ profileOverride: '   ', env: inheritedFromRunningApp, defaultHome: '/Users/dev' }), /needs a directory/)
})

test('the derived identity always satisfies the host-side shape rules', () => {
  for (const name of ['klaus-dev-preview', 'klaus.dev', 'Klaus Dev Preview', 'a'.repeat(120), '.hidden', 'dev-preview-2']) {
    const identity = instanceIdentityFor(join('/Users/dev', name))
    assert.match(identity, INSTANCE_FIXTURE_PATTERN, name)
    assert.ok(Buffer.byteLength(identity) <= 72, `${name} stays within the native guard's bound`)
  }
})

test('the home directory is resolved in the host order, without consulting the OS user database', () => {
  assert.equal(homeFromEnvironment({ HOME: '/a' }), '/a')
  assert.equal(homeFromEnvironment({ USERPROFILE: '/b' }), '/b')
  assert.equal(homeFromEnvironment({ HOME: '/a', USERPROFILE: '/b' }), '/a', 'HOME wins')
  assert.equal(homeFromEnvironment({ HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\c' }), 'C:\\Users\\c')
  assert.equal(homeFromEnvironment({ HOMEDRIVE: 'C:' }), undefined, 'a drive without a path is not a home')
  assert.equal(homeFromEnvironment({}), undefined)
})

test('without any home at all the launch explains itself instead of touching the process directory', () => {
  assert.throws(() => resolveDevProfile({ env: {}, defaultHome: undefined }), /No home directory|--profile/)
  const shared = resolveDevProfile({ sharedProfile: true, env: {}, defaultHome: undefined })
  assert.equal(shared.configRoot, undefined)
})

test('the profile directory is created because the host refuses one that does not exist', () => {
  const created = []
  ensureProfileDirectory('/tmp/klaus-dev-profile-fixture', {
    exists: () => false,
    mkdir: (path, options) => created.push({ path, options }),
  })
  assert.deepEqual(created, [{ path: '/tmp/klaus-dev-profile-fixture', options: { recursive: true, mode: 0o700 } }])
  const skipped = []
  ensureProfileDirectory('/tmp/klaus-dev-profile-fixture', { exists: () => true, mkdir: (path) => skipped.push(path) })
  assert.deepEqual(skipped, [], 'an existing profile is left alone')
})

// The failure this whole module exists to make visible: activation is forwarded to the instance
// that owns the profile and the process exits 0, printing nothing.
const lockFixture = ({ linkTarget, alive }) => ({
  platform: 'darwin',
  hostname: 'dev-mac.local',
  readlink: () => { if (linkTarget === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return linkTarget },
  isAlive: () => alive,
  describeProcess: () => '/Applications/Klaus.app/Contents/MacOS/Klaus',
})

test('a live owner of the profile is named, with the pid that holds it', () => {
  const diagnosis = describeEarlyExit({
    exitCode: 0,
    signal: null,
    configRoot: '/Users/dev/.klaus',
    isolated: false,
    deps: lockFixture({ linkTarget: 'dev-mac.local-33895', alive: true }),
  })
  assert.equal(diagnosis.occupied, true)
  const text = diagnosis.lines.join('\n')
  assert.match(text, /33895/, 'the holding pid is reported')
  assert.match(text, /Klaus\.app/, 'the holding command is reported')
  assert.match(text, /Quit the installed Klaus first|--shared-profile/, 'the shared-profile case names its own fix')
})

test('the isolated case points at a second profile rather than at quitting the app', () => {
  const diagnosis = describeEarlyExit({
    exitCode: 0,
    signal: null,
    configRoot: '/Users/dev/.klaus-dev-preview',
    isolated: true,
    deps: lockFixture({ linkTarget: 'dev-mac.local-43782', alive: true }),
  })
  assert.equal(diagnosis.occupied, true)
  assert.match(diagnosis.lines.join('\n'), /--profile=/)
})

test('a lock left behind by a dead process is reported as stale, not as an occupant', () => {
  const diagnosis = describeEarlyExit({
    exitCode: 1,
    signal: null,
    configRoot: '/Users/dev/.klaus-dev-preview',
    isolated: true,
    deps: lockFixture({ linkTarget: 'dev-mac.local-99999', alive: false }),
  })
  assert.equal(diagnosis.occupied, false)
  assert.match(diagnosis.lines.join('\n'), /stale single-instance lock/)
})

test('no lock at all still refuses to let a pre-readiness exit look like success', () => {
  const diagnosis = describeEarlyExit({
    exitCode: 1,
    signal: 'SIGSEGV',
    configRoot: '/Users/dev/.klaus-dev-preview',
    isolated: true,
    deps: lockFixture({ linkTarget: undefined, alive: false }),
  })
  assert.equal(diagnosis.occupied, false)
  const text = diagnosis.lines.join('\n')
  assert.match(text, /code 1, signal SIGSEGV/)
  assert.match(text, /launch failure rather than a build failure/, 'the build output above is a red herring and says so')
})

test('a reaped-but-unburied owner is reported as an unreaped exit, not a live window', () => {
  // A zombie answers the liveness probe yet can never serve its endpoint, so the
  // diagnosis must point at the parent still holding the corpse instead of telling
  // the operator to close a window that does not exist.
  const diagnosis = describeEarlyExit({
    exitCode: 0,
    signal: null,
    configRoot: '/Users/dev/.klaus-dev-preview',
    isolated: true,
    deps: {
      ...lockFixture({ linkTarget: 'dev-mac.local-69662', alive: true }),
      describeProcess: () => 'node scripts/dev.mjs',
      processState: () => 'Z',
    },
  });
  assert.equal(diagnosis.occupied, true);
  const text = diagnosis.lines.join('\n');
  assert.match(text, /never reaped/);
  assert.match(text, /69662/);
  assert.match(text, /resume or end it/, 'the fix named is the parent, not the window');
});

test('the owner probe reads the lock and never invents an owner', () => {
  const configRoot = '/Users/dev/.klaus'
  assert.deepEqual(
    readProfileOwner(configRoot, lockFixture({ linkTarget: 'dev-mac.local-33895', alive: true })),
    { link: join(configRoot, 'electron', 'SingletonLock'), pid: 33895, alive: true },
  )
  // A lock written by another machine says nothing about local pids.
  assert.equal(readProfileOwner(configRoot, lockFixture({ linkTarget: 'other-host-33895', alive: true })), undefined)
  for (const linkTarget of ['garbage', 'dev-mac.local-', 'dev-mac.local-abc', 'dev-mac.local-0']) {
    assert.equal(readProfileOwner(configRoot, lockFixture({ linkTarget, alive: true })), undefined, linkTarget)
  }
  assert.equal(readProfileOwner(configRoot, lockFixture({ linkTarget: undefined, alive: true })), undefined)
  assert.equal(readProfileOwner(configRoot, { ...lockFixture({ alive: true }), platform: 'win32' }), undefined, 'no symlink lock on Windows')
  assert.equal(readProfileOwner(undefined, lockFixture({ linkTarget: 'dev-mac.local-1', alive: true })), undefined)
})
