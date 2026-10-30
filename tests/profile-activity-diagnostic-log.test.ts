import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import type { ChannelRegistry } from '../main/ipc/registry';
import { registerSessionQueryHandlers } from '../main/ipc/handlers/session-queries';
import { HostState } from '../main/services/host-state';
import type { SessionService } from '../main/sessions/service';
import { assert, assertEqual, assertRejects, Harness } from './harness';

const h = new Harness(), roots: string[] = [];
type Handler = (context: never) => Promise<Json> | Json;

function fixture(respond: () => unknown) {
  const root = mkdtempSync(join(tmpdir(), 'klaus-profile-activity-log-')); roots.push(root);
  const handlers = new Map<string, Handler>();
  const registry = {
    register: (channel: string, handler: Handler) => { handlers.set(channel, handler); },
    registerAll: (map: Record<string, Handler>) => { for (const [channel, handler] of Object.entries(map)) handlers.set(channel, handler); },
  } as unknown as ChannelRegistry;
  const logs: string[] = [];
  const sessions = {
    request: async (method: string) => {
      if (method !== 'engine/profileActivity') throw new Error(`Unexpected request: ${method}`);
      return respond();
    },
  } as unknown as SessionService;
  registerSessionQueryHandlers(registry, { sessions, state: new HostState(), configRoot: root, profileActivityLog: detail => logs.push(detail) });
  return { logs, activity: handlers.get('profile:activity')! };
}

h.test('a failed engine aggregate read keeps its reason in the diagnostic log', async () => {
  const { logs, activity } = fixture(() => { throw new Error('engine fixture unavailable'); });
  await assertRejects(() => Promise.resolve(activity({} as never)), 'the renderer still sees the failure');
  assertEqual(logs.length, 1, 'exactly one diagnostic line per failed read');
  const line = JSON.parse(logs[0]!) as { stage: string; error: string };
  assertEqual(line.stage, 'engine', 'engine-side failures are attributed to the engine stage');
  assertEqual(line.error, 'engine fixture unavailable', 'the failure reason survives for the log');
});

h.test('a malformed aggregate snapshot keeps its validation reason in the diagnostic log', async () => {
  const { logs, activity } = fixture(() => ({ days: [] }) as unknown);
  await assertRejects(() => Promise.resolve(activity({} as never)), 'invalid measurements are still refused');
  assertEqual(logs.length, 1, 'exactly one diagnostic line per failed read');
  const line = JSON.parse(logs[0]!) as { stage: string; error: string };
  assertEqual(line.stage, 'snapshot', 'validation failures are attributed to the snapshot stage');
  assert(line.error.includes('Invalid profile activity'), 'the validation reason survives for the log');
});

h.test('a successful aggregate read writes no diagnostic line', async () => {
  const { logs, activity } = fixture(() => ({ days: [], totalTokens: 0, peakDailyTokens: 0, longestTaskMs: 0, longestStreakDays: 0, currentStreakDays: 0 }) as unknown);
  await activity({} as never);
  assertEqual(logs.length, 0, 'success stays silent in the diagnostic log');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'profile-activity-diagnostic-log-result.json'), 'profile-activity-diagnostic-log');
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exit(failed);
})();
