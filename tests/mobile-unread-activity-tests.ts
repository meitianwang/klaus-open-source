import assert from 'node:assert/strict';
import { kvGet, kvSet } from '../main/services/settings';
import { stopSocket } from '../main/services/mobile/transport';
import { object } from '../main/services/service-types';
import { parseSidebarUnreadSessions, serializeSidebarUnreadSessions, SIDEBAR_UNREAD_SESSIONS_KEY } from '../shared/sidebar-preferences';
import { Harness, waitFor } from './harness';
import { mobileFixture } from './mobile-fixture';

export async function registerMobileUnreadActivityTests(h: Harness): Promise<void> {
  await h.test('background turn completion records unread sessions unless desktop is actively viewing', async () => {
    let viewingS1 = false;
    let unreadNotifications = 0;
    const f = await mobileFixture({
      isDesktopViewingSession: id => id === 's1' && viewingS1,
      unreadChanged: () => { unreadNotifications += 1; },
    });
    const desktopState = async () => object((await f.request('GET', '/api/mobile/desktop-state')).body.desktopState);
    const unread = () => parseSidebarUnreadSessions(kvGet(SIDEBAR_UNREAD_SESSIONS_KEY, f.root));
    const start = (sessionId: string) => f.bridge.publishEngineEvent({ sessionId, type: 'stream_mode', mode: 'requesting' }, f.owner());
    try {
      await f.enable();
      const boot = await f.request('GET', '/api/mobile/bootstrap');
      assert.equal(object(boot.body.features).unreadSync, true);
      assert.deepEqual(object(boot.body.desktopState).unreadSessionIds, []);
      viewingS1 = true;
      start('s1');
      f.bridge.publishEngineEvent({ sessionId: 's1', type: 'done' }, f.owner());
      assert.deepEqual(unread(), []);
      viewingS1 = false;
      start('s1');
      f.bridge.publishEngineEvent({ sessionId: 's1', type: 'done' }, f.owner());
      assert.deepEqual(unread(), ['s1']);
      assert.equal(unreadNotifications, 1);
      start('s2');
      f.bridge.publishEngineEvent({ sessionId: 's2', type: 'api_error', terminal: false }, f.owner());
      f.bridge.publishEngineEvent({ sessionId: 's2', type: 'interrupted' }, f.owner());
      assert.deepEqual(unread(), ['s1']);
      start('s2');
      f.bridge.publishEngineEvent({ sessionId: 's2', type: 'api_error', terminal: true }, f.owner());
      assert.deepEqual((await desktopState()).unreadSessionIds, ['s1', 's2']);
      start('s1');
      assert.deepEqual((await desktopState()).unreadSessionIds, ['s2']);
      assert.deepEqual(unread(), ['s2']);
      f.bridge.noteRendererSession([{ sessionId: 's2' }], 'session:archive');
      assert.deepEqual(unread(), []);
    } finally {
      await f.close();
    }
  });

  await h.test('bidirectional read sync reconciles HTTP, WebSocket, and desktop preference updates', async () => {
    let unreadNotifications = 0;
    const f = await mobileFixture({ unreadChanged: () => { unreadNotifications += 1; } });
    try {
      await f.enable();
      const client = await f.connect();
      await client.next('hello');
      const waitForUnread = (ids: string[], label: string) => waitFor(() => client.messages.some(
        row => row.type === 'desktop_state_changed' && JSON.stringify(object(row.desktopState).unreadSessionIds) === JSON.stringify(ids),
      ), 3000, label);
      const unread = () => parseSidebarUnreadSessions(kvGet(SIDEBAR_UNREAD_SESSIONS_KEY, f.root));
      kvSet(SIDEBAR_UNREAD_SESSIONS_KEY, serializeSidebarUnreadSessions(['s1', 's2']), f.root);
      f.bridge.notePreferencesChanged(SIDEBAR_UNREAD_SESSIONS_KEY);
      await waitForUnread(['s1', 's2'], 'desktop unread push');
      client.messages.length = 0;
      const invalid = await f.request('POST', '/api/mobile/sessions/read', {});
      assert.equal(invalid.status, 400);
      const readOne = await f.request('POST', '/api/mobile/sessions/read', { sessionIds: ['s1'] });
      assert.equal(readOne.status, 200);
      assert.deepEqual(readOne.body.unreadSessionIds, ['s2']);
      assert.deepEqual(unread(), ['s2']);
      assert.equal(unreadNotifications, 1);
      await waitForUnread(['s2'], 'mobile single read broadcast');
      client.messages.length = 0;
      client.socket.send(JSON.stringify({ type: 'mark_sessions_read', requestId: 'req-read-all', all: true }));
      const actionResult = await client.next('action_result');
      assert.equal(actionResult.ok, true);
      assert.equal(actionResult.action, 'mark_sessions_read');
      assert.equal(actionResult.requestId, 'req-read-all');
      assert.deepEqual(actionResult.unreadSessionIds, []);
      assert.deepEqual(unread(), []);
      assert.equal(unreadNotifications, 2);
      await stopSocket(client.socket);
    } finally {
      await f.close();
    }
  });

  await h.test('awaitingInputSessionIds separates input questions from tool approvals and tracks multi-question batches', async () => {
    const f = await mobileFixture();
    const desktopState = async () => object((await f.request('GET', '/api/mobile/desktop-state')).body.desktopState);
    let answerState = 'pending';
    f.intercept(async channel => {
      if (channel === 'question:answer') return { ok: true, state: answerState };
      return undefined;
    });
    try {
      await f.enable();
      const client = await f.connect();
      await client.next('hello');
      f.bridge.publishPermissionRequest({ sessionId: 's1', requestId: 'perm-bash', toolName: 'bash' }, f.owner());
      const statePerm = await desktopState();
      assert.deepEqual(statePerm.awaitingInteractionSessionIds, ['s1']);
      assert.deepEqual(statePerm.awaitingInputSessionIds, []);
      f.bridge.publishPermissionRequest({ sessionId: 's2', requestId: 'perm-ask', toolName: 'AskUserQuestion' }, f.owner());
      const stateInput = await desktopState();
      assert.deepEqual(stateInput.awaitingInteractionSessionIds, ['s1', 's2']);
      assert.deepEqual(stateInput.awaitingInputSessionIds, ['s2']);
      await f.request('POST', '/api/mobile/permissions/respond', { requestId: 'perm-ask', decision: 'allow' });
      f.bridge.publishDesktopStateEvent('question_requested', { sessionId: 's2', turnId: 't1', requestId: 'q1' }, f.owner());
      assert.deepEqual((await desktopState()).awaitingInputSessionIds, ['s2']);
      const partial = await f.request('POST', '/api/mobile/questions/answer', {
        sessionId: 's2', turnId: 't1', requestId: 'q1', clientResponseId: 'resp-1', answers: { first: 'a' },
      });
      assert.equal(partial.status, 202);
      assert.deepEqual((await desktopState()).awaitingInputSessionIds, ['s2']);
      answerState = 'answered';
      await f.request('POST', '/api/mobile/questions/answer', {
        sessionId: 's2', turnId: 't1', requestId: 'q1', clientResponseId: 'resp-2', answers: { second: 'b' },
      });
      const stateAfter = await desktopState();
      assert.deepEqual(stateAfter.awaitingInputSessionIds, []);
      assert.deepEqual(stateAfter.awaitingInteractionSessionIds, ['s1']);
      await stopSocket(client.socket);
    } finally {
      await f.close();
    }
  });
}
