// Actual filesystem events, host publication and an existing engine session.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngineManager } from '../main/engine/manager';
import { HostState } from '../main/services/host-state';
import { SessionService } from '../main/sessions/service';
import { ExtensionDiscovery } from '../main/services/extensions/discovery';
import { SkillWatcher } from '../main/services/extensions/skill-watcher';
import { object } from '../main/services/service-types';
import type { Json } from '../main/ipc/contract';
import { Harness, assert, assertEqual, waitFor } from './harness';

const binary = process.env.KLAUS_ENGINE_BINARY;
if (!binary) throw new Error('KLAUS_ENGINE_BINARY must identify the engine under test');
const h = new Harness();

h.test('filesystem skill changes update an existing live engine session without recreating it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'klaus-skill-reload-live-'));
  const manager = new EngineManager('0.0.0-skill-reload-test'), state = new HostState();
  const discovery = new ExtensionDiscovery({ configRoot: root });
  const service = new SessionService({ manager, state, configRoot: root, extensions: discovery,
    spawnOptions: () => ({ command: binary!, args: [], cwd: root,
      env: [['KLAUS_CONFIG_DIR', root], ['KLAUS_SESSION_DIR', join(root, 'sessions')], ['KLAUS_PLUGIN_HOME', join(root, 'plugins')]] }),
    pushChatEvents: () => {},
  });
  let notifications = 0;
  const errors: string[] = [];
  const watcher = new SkillWatcher({ configRoot: root, throttleMs: 20,
    invalidate: () => discovery.invalidateSkills(),
    onChanged: async () => { notifications++; await service.publishSkillChanges(); },
    diagnostic: (path, error) => errors.push(path + ': ' + String(error)),
  });
  try {
    const client = await service.client();
    const initial = await discovery.sessionSkills(root);
    const started = object(await client.requestWithTimeout('session/start', {
      init: { cwd: root, threadId: 'live-skill-thread', skills: initial }, resume: null, fork: null,
    }, 15_000));
    assert(typeof started.sessionId === 'string', 'the actual engine created the initial session');
    const engineId = started.sessionId;
    await client.requestWithTimeout('session/subscribe', { sessionId: engineId }, 15_000);
    state.rememberSession('renderer-skill-thread', engineId, { cwd: root, skills: initial });
    await watcher.subscribe([]);
    const skill = join(root, 'skills', 'live-added');
    await mkdir(skill, { recursive: true });
    const document = join(skill, 'SKILL.md');
    await writeFile(document, '---\nname: live-added\ndescription: Added after session start\n---\nInitial live instructions');
    const effective = async (): Promise<Array<Record<string, Json>>> => {
      const reply = object(await client.requestWithTimeout('session/extensionRuntime', { sessionId: engineId }, 15_000));
      const runtime = object(reply.extensionRuntime);
      assert(Array.isArray(runtime.skills), 'the actual engine returned its effective skill catalog');
      return runtime.skills as Array<Record<string, Json>>;
    };
    await waitFor(async () => (await effective()).some(row => row.name === 'live-added'), 10_000,
      'an external install reaches the existing engine binding: ' + errors.join('\n'));
    assert((await discovery.slashCommands(root)).some(row => row.name === 'live-added'), 'slash discovery sees the installed skill');
    await writeFile(document, '---\nname: live-edited\ndescription: Edited after installation\n---\nUpdated live instructions');
    await waitFor(async () => (await effective()).some(row => row.name === 'live-edited'), 10_000, 'editing replaces the active catalog metadata');
    assert(!(await effective()).some(row => row.name === 'live-added'), 'the old identity is removed');
    await rm(skill, { recursive: true });
    await waitFor(async () => !(await effective()).some(row => row.name === 'live-edited'), 10_000, 'deletion removes the effective skill');
    assert(!(await discovery.slashCommands(root)).some(row => row.name === 'live-edited'), 'slash discovery removes the deleted skill');
    assertEqual(state.liveSession('renderer-skill-thread'), engineId, 'all mutations retain the original engine session');
    assertEqual(state.isStale('renderer-skill-thread'), false, 'no mutation schedules a replacement');
    assertEqual(manager.liveProcessCount(), 1, 'one engine process serves the full lifecycle');
    assert(notifications >= 3, 'filesystem mutations reach the change notification callback');
    assertEqual(errors.length, 0, 'no watcher or engine publication failure was hidden');
  } finally {
    await watcher.close(); await service.shutdown(); await manager.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

void h.finish(join(__dirname, 'skill-reload-live-result.json'), 'skill-reload-live').then(code => { process.exitCode = code; });
