// Host contract for branch cleanup after a failed fork.
//
// A cut point the engine cannot resolve aborts the branch after the new
// endpoint was already started. Removing that half-built endpoint is cleanup,
// not the story: it must never replace the startup failure the user needs to
// see. The previous aggregate led with the cleanup error and hid the real
// reason behind "Branch creation failed and its incomplete thread could not
// be removed".

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import { assertEqual, Harness } from './harness';
import { HostState } from '../main/services/host-state';
import { SessionService, type EngineAttacherLike, type EngineClientLike } from '../main/sessions/service';
import { kvSet } from '../main/services/settings';
import type { Json } from '../main/ipc/contract';
import { FakeEngineQueue } from './engine-queue-fixture';

const h = new Harness();

process.env.KLAUS_TEST = '1';
const roots: string[] = [];
function byoRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'klaus-fork-cleanup-'));
  roots.push(root);
  assertEqual(kvSet('auth_mode', 'custom', root), true, 'the BYO precondition was written');
  return root;
}

const CUT_ERROR = 'fork cut point submission:cut does not exist in thread source';

class CleanupFakeClient extends EventEmitter implements EngineClientLike {
  readonly queue = new FakeEngineQueue();
  readonly calls: Array<{ method: string; params: Json }> = [];
  closed = false;
  private deleteFailures: number;

  constructor(failDeletes: number | 'always') {
    super();
    this.deleteFailures = failDeletes === 'always' ? Number.MAX_SAFE_INTEGER : failDeletes;
  }

  isClosed(): boolean {
    return this.closed;
  }

  sent(method: string): Json[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  async requestWithTimeout(method: string, params: Json): Promise<unknown> {
    this.calls.push({ method, params });
    if (method.startsWith('thread/queue/')) return this.queue.request(method, params);
    const ack = (envelope: Record<string, unknown>) => {
      this.emit('event', { type: 'engineEvent', params: { submissionId: 'fixture-submission', ...envelope } });
      return { submissionId: 'fixture-submission' };
    };
    switch (method) {
      case 'session/start': return { sessionId: 'engine-branch' };
      case 'session/forkSession': throw new Error(CUT_ERROR);
      case 'session/close': return ack({ closed: true });
      case 'session/deleteSession':
        if (this.deleteFailures > 0) {
          this.deleteFailures -= 1;
          throw new Error('delete refused while the endpoint retires');
        }
        return ack({ deleted: true });
      case 'session/prepare': return { sessionId: (params as { sessionId: string }).sessionId, ready: true };
      case 'session/subscribe': return { subscribed: true };
      case 'session/taskList': return { tasks: [] };
      case 'session/queueSnapshot': return { queueSnapshot: { revision: 0, items: [], status: 'authoritative' } };
      case 'session/resumePending': return { pendingResume: { started: false, reason: 'empty' } };
      case 'session/setupLifecycle': return { setupLifecycle: { idempotencyResults: {} } };
      case 'session/subagentLifecycle': return { subagentLifecycle: { agents: [] } };
      case 'session/backgroundProcesses': return { backgroundProcesses: { processes: [] } };
      case 'config/read': return { resolved: {}, sources: {} };
      case 'model/selection/resolve': return { source: 'custom', selection: 'custom:fixture-default' };
      case 'engine/listSessions':
        return { sessions: { items: [{ id: 'source', createdAt: 1, updatedAt: 2, title: 'Source' }], nextCursor: null } };
      case 'engine/readSessionSummary':
        return { session: (params as Record<string, Json>).sessionId === 'source'
          ? { id: 'source', createdAt: 1, updatedAt: 2, title: 'Source' } : null };
      default: throw new Error(`fake client: no reply scripted for ${method}`);
    }
  }
}

function serviceWith(client: CleanupFakeClient, configRoot: string, logs: Array<{ kind: string; detail: string }>): SessionService {
  const manager: EngineAttacherLike = {
    attach: async () => ({ client, generation: 1 }),
    shutdownAll: async () => { client.closed = true; },
  };
  return new SessionService({
    manager,
    state: new HostState(),
    spawnOptions: () => ({ command: '/bin/true', args: [], env: [] }),
    pushChatEvents: () => {},
    configRoot,
    log: (kind, detail) => { logs.push({ kind, detail }); },
  });
}

async function forkFailureMessage(service: SessionService): Promise<string> {
  try {
    await service.forkSession('source', 'submission:cut');
    return '';
  } catch (error) {
    return String((error as Error).message);
  }
}

h.test('a cleanup that never succeeds still surfaces the startup failure', async () => {
  const logs: Array<{ kind: string; detail: string }> = [];
  const client = new CleanupFakeClient('always');
  const service = serviceWith(client, byoRoot(), logs);
  assertEqual(await forkFailureMessage(service), CUT_ERROR, 'the user sees why the fork aborted, not a cleanup aggregate');
  assertEqual(client.sent('session/deleteSession').length >= 1, true, 'the half-built endpoint got delete attempts');
  assertEqual(logs.some(entry => entry.kind === 'session-fork-cleanup-deferred'), true, 'the deferred cleanup is logged');
});

h.test('cleanup that settles on retry removes the endpoint and still surfaces the startup failure', async () => {
  const logs: Array<{ kind: string; detail: string }> = [];
  const client = new CleanupFakeClient(1);
  const service = serviceWith(client, byoRoot(), logs);
  assertEqual(await forkFailureMessage(service), CUT_ERROR, 'the original failure wins over the transient cleanup error');
  assertEqual(client.sent('session/deleteSession').length, 2, 'the bounded retry removed the endpoint');
  assertEqual(logs.some(entry => entry.kind === 'session-fork-cleanup-deferred'), false, 'nothing is deferred once the retry succeeded');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'session-fork-cleanup-result.json'), 'session-fork-cleanup');
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A temp dir that will not delete is not a test failure.
    }
  }
  process.exit(failed);
})();
