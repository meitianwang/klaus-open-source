import assert from 'node:assert/strict';
import { COMPOSER_PREDICTIONS_ACCEPTED_KEY, COMPOSER_PREDICTIONS_ENABLED_KEY } from '../main/services/composer-predictions';
import { stopSocket } from '../main/services/mobile/transport';
import { object } from '../main/services/service-types';
import { Harness, sleep, waitFor } from './harness';
import { mobileFixture } from './mobile-fixture';

export async function registerMobilePredictionTests(h: Harness): Promise<void> {
  await h.test('composer prediction preferences round-trip in runtimeConfig and broadcast on desktop settings updates', async () => {
    const f = await mobileFixture();
    try {
      await f.enable();
      const boot = await f.request('GET', '/api/mobile/bootstrap');
      assert.equal(object(boot.body.features).composerPredictions, 1);
      assert.equal(object(boot.body.runtimeConfig).composerPredictionsEnabled, true);
      assert.equal(object(boot.body.runtimeConfig).composerPredictionsAccepted, false);

      const client = await f.connect();
      await client.next('hello');
      const rejected = await f.request('POST', '/api/mobile/runtime-config', { composerPredictionsEnabled: 'yes' });
      assert.equal(rejected.status, 400);

      const updated = await f.request('POST', '/api/mobile/runtime-config', {
        composerPredictionsEnabled: false,
        composerPredictionsAccepted: true,
      });
      assert.equal(updated.status, 202);
      assert.equal(object(updated.body.runtimeConfig).composerPredictionsEnabled, false);
      assert.equal(object(updated.body.runtimeConfig).composerPredictionsAccepted, true);
      await waitFor(() => client.messages.some(
        row => row.type === 'runtime_config_changed'
          && object(row.runtimeConfig).composerPredictionsEnabled === false
          && object(row.runtimeConfig).composerPredictionsAccepted === true,
      ), 3000, 'runtime_config_changed broadcast after HTTP update');

      client.messages.length = 0;
      client.socket.send(JSON.stringify({ type: 'set_runtime_config', composerPredictionsEnabled: true }));
      await client.next('action_result');
      client.messages.length = 0;
      f.bridge.notePreferencesChanged(COMPOSER_PREDICTIONS_ENABLED_KEY);
      f.bridge.notePreferencesChanged(COMPOSER_PREDICTIONS_ACCEPTED_KEY);
      await waitFor(() => client.messages.some(
        row => row.type === 'runtime_config_changed' && object(row.runtimeConfig).composerPredictionsEnabled === true,
      ), 3000, 'desktop preference broadcast');
      await stopSocket(client.socket);
    } finally {
      await f.close();
    }
  });

  await h.test('live turn completion pushes composer_prediction only to peers following the session and detaches owners cleanly', async () => {
    let nextOwner = 2_000_000_000;
    const predictCalls: { sessionId: string; turnId: string; trigger: string; ownerId: number }[] = [];
    const detachedOwners: number[] = [];
    const f = await mobileFixture({
      composerPredictions: {
        allocateOwnerId: () => nextOwner++,
        availability: async () => ({ available: true }),
        source: async sessionId => ({ turnId: sessionId === 's1' ? 'turn-catchup' : null }),
        predict: async (sessionId, turnId, trigger, ownerId) => {
          predictCalls.push({ sessionId, turnId, trigger, ownerId });
          return { suggestion: `Follow up on ${turnId}` };
        },
        cancel: async () => {},
        detachOwner: async ownerId => { detachedOwners.push(ownerId); },
      },
    });
    try {
      await f.enable();
      const phoneS1 = await f.connect();
      await phoneS1.next('hello');
      phoneS1.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's1' }));
      await phoneS1.next('task_snapshot');

      const phoneS2 = await f.connect();
      await phoneS2.next('hello');
      phoneS2.socket.send(JSON.stringify({ type: 'follow_task', sessionId: 's2' }));
      await phoneS2.next('task_snapshot');

      f.bridge.publishEngineEvent({ sessionId: 's1', type: 'stream_mode', mode: 'requesting' }, f.owner());
      f.bridge.publishEngineEvent({ sessionId: 's1', type: 'done', turnId: 'turn-live-1' }, f.owner());

      const pushed = await phoneS1.next('composer_prediction');
      assert.equal(pushed.sessionId, 's1');
      assert.equal(pushed.turnId, 'turn-live-1');
      assert.equal(pushed.suggestion, 'Follow up on turn-live-1');
      assert.equal(predictCalls.length, 1);
      assert.equal(predictCalls[0]?.trigger, 'live');
      await sleep(40);
      assert.equal(phoneS2.messages.some(row => row.type === 'composer_prediction'), false, 'peer following s2 must not receive s1 prediction');

      const ownerBeforeClose = detachedOwners.length;
      await stopSocket(phoneS2.socket);
      await waitFor(() => detachedOwners.length > ownerBeforeClose, 2000, 'socket close detaches peer owner');

      f.replaceOwner();
      assert.equal((await f.request('GET', '/api/mobile/desktop-state')).status, 200);
      await waitFor(() => detachedOwners.includes(predictCalls[0]!.ownerId), 2000, 'engine replacement detaches live prediction owner');
      await stopSocket(phoneS1.socket);
    } finally {
      await f.close();
    }
  });

  await h.test('WebSocket and HTTP prediction queries run off the serial peer queue so cancel and user sends stay immediate', async () => {
    let nextOwner = 3_000_000_000;
    let releasePredict!: () => void;
    let enteredPredict = false;
    let cancelledForOwner: { sessionId: string; ownerId: number } | undefined;
    const f = await mobileFixture({
      composerPredictions: {
        allocateOwnerId: () => nextOwner++,
        availability: async () => ({ available: true }),
        source: async sessionId => ({ turnId: `turn-for-${sessionId}` }),
        predict: async (sessionId, turnId, trigger, ownerId) => {
          if (turnId === 'turn-slow') {
            enteredPredict = true;
            await new Promise<void>(resolve => { releasePredict = resolve; });
            if (cancelledForOwner?.sessionId === sessionId && cancelledForOwner.ownerId === ownerId) {
              return { suggestion: null, reason: 'cancelled' };
            }
          }
          return { suggestion: `${trigger}:${sessionId}:${turnId}` };
        },
        cancel: async (sessionId, ownerId) => {
          cancelledForOwner = { sessionId, ownerId };
          releasePredict?.();
        },
        detachOwner: async () => { releasePredict?.(); },
      },
    });
    try {
      await f.enable();
      const httpSource = await f.request('POST', '/api/mobile/sessions/s1/prediction-source', {});
      assert.equal(httpSource.status, 200);
      assert.equal(httpSource.body.turnId, 'turn-for-s1');

      const httpBadTrigger = await f.request('POST', '/api/mobile/sessions/s1/prediction', { turnId: 't1', trigger: 'invalid' });
      assert.equal(httpBadTrigger.status, 400);

      const httpPredict = await f.request('POST', '/api/mobile/sessions/s1/prediction', { turnId: 't1', trigger: 'catch_up' });
      assert.equal(httpPredict.status, 200);
      assert.equal(httpPredict.body.suggestion, 'catch_up:s1:t1');

      const httpCancel = await f.request('POST', '/api/mobile/sessions/s1/prediction-cancel', {});
      assert.equal(httpCancel.status, 200);

      const client = await f.connect();
      await client.next('hello');
      client.socket.send(JSON.stringify({ type: 'composer_prediction_source', sessionId: 's1', requestId: 'req-src' }));
      const srcReply = await client.next('action_result');
      assert.equal(srcReply.action, 'composer_prediction_source');
      assert.equal(srcReply.requestId, 'req-src');
      assert.equal(object(srcReply.predictionSource).turnId, 'turn-for-s1');

      client.socket.send(JSON.stringify({ type: 'composer_prediction', sessionId: 's1', turnId: 'turn-slow', trigger: 'catch_up', requestId: 'req-pred' }));
      await waitFor(() => enteredPredict, 2000, 'entered slow prediction');

      client.socket.send(JSON.stringify({ type: 'send_message', sessionId: 's1', clientMessageId: 'msg-while-predicting', text: 'immediate send' }));
      await waitFor(() => f.sent.length === 1, 1000, 'user message must not wait behind slow prediction');

      client.socket.send(JSON.stringify({ type: 'composer_prediction_cancel', sessionId: 's1', requestId: 'req-cancel' }));
      await waitFor(() => client.messages.some(row => row.type === 'action_result' && row.requestId === 'req-cancel'), 1000, 'cancel acknowledged');
      await waitFor(() => client.messages.some(row => row.type === 'action_result' && row.requestId === 'req-pred'), 1000, 'cancelled prediction resolves');
      const predReply = client.messages.find(row => row.type === 'action_result' && row.requestId === 'req-pred')!;
      assert.equal(object(predReply.prediction).suggestion, null);
      assert.equal(object(predReply.prediction).reason, 'cancelled');

      await stopSocket(client.socket);
    } finally {
      releasePredict?.();
      await f.close();
    }
  });
}
