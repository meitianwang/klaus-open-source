import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { ComposerService } from '../main/services/composer';
import { ModelFeatureSettings } from '../main/services/model-features';
import {
  readSessionOrchestrationMode,
  readSessionUltraMode,
  readSessionThinkingLevel,
  setSessionThinkingLevel,
} from '../main/services/session-store';
import { buildSessionInit } from '../main/services/session-init';
import { inferenceInit, replaceInferenceInit } from '../main/sessions/inference';
import { projectEngineEvent } from '../main/ipc/project';
import { ChatEventForwarder, SessionEventPump } from '../main/sessions/events';
import { HostState } from '../main/services/host-state';
import { presetRuntimePolicy, runtimePolicyConfig } from '../contracts/runtime-settings';
import type { Json } from '../main/ipc/contract';
import { object, type JsonObject } from '../main/services/service-types';

const h = new Harness();
const roots: string[] = [];
function fresh(): string {
  const root = mkdtempSync(join(tmpdir(), 'klaus-orch-'));
  roots.push(root);
  return root;
}

function makeComposer(root: string, onChange: (change: unknown) => void | Promise<void> = () => {}): ComposerService {
  const values = runtimePolicyConfig(presetRuntimePolicy('default')) as JsonObject;
  return new ComposerService({
    configRoot: root,
    push: () => {},
    onSessionConfigChanged: onChange,
    request: async (method: string, raw: Json) => {
      if (method === 'config/read') return { values: structuredClone(values), resolved: structuredClone(values), version: '1' };
      if (method === 'config/batchWrite') {
        const params = object(raw);
        for (const item of params.edits as Json[]) {
          const edit = object(item);
          if (edit.value === null) delete values[String(edit.keyPath)];
          else values[String(edit.keyPath)] = edit.value!;
        }
        return { version: '1' };
      }
      return {};
    },
  });
}

h.test('orchestrator settings default to reusing medium tier and validate explicit source:model picks', () => {
  const root = fresh();
  const features = new ModelFeatureSettings(root);

  const initial = object(features.getOrchestrator());
  assert.equal(initial.mode, 'use_medium');
  assert.equal(initial.model, '');
  assert.equal(initial.fallbackToMain, false);
  assert.equal(features.getOrchestratorTarget(), null);
  assert.equal(features.getOrchestratorFallbackToMain(), false);

  const invalid = object(features.setOrchestrator({ model: 'bare-model-without-source' }));
  assert.equal(invalid.ok, false);
  const invalidFallback = object(features.setOrchestrator({ fallbackToMain: 'yes' as unknown as boolean }));
  assert.equal(invalidFallback.ok, false);

  const valid = object(features.setOrchestrator({ model: 'bailian:qwen3-coder-plus' }));
  assert.equal(valid.ok, true);
  assert.equal(object(valid.settings).fallbackToMain, false);
  assert.deepEqual(features.getOrchestratorTarget(), {
    type: 'source',
    source: 'bailian',
    modelId: 'qwen3-coder-plus',
  });

  // Toggling fallbackToMain preserves the selected model, and resetting model preserves fallbackToMain.
  const toggled = object(features.setOrchestrator({ fallbackToMain: true }));
  assert.equal(toggled.ok, true);
  assert.equal(object(toggled.settings).model, 'bailian:qwen3-coder-plus');
  assert.equal(object(toggled.settings).fallbackToMain, true);
  assert.equal(features.getOrchestratorFallbackToMain(), true);

  const reset = object(features.setOrchestrator({ model: '' }));
  assert.equal(reset.ok, true);
  assert.equal(object(reset.settings).mode, 'use_medium');
  assert.equal(object(reset.settings).fallbackToMain, true);
  assert.equal(features.getOrchestratorTarget(), null);
});

h.test('session orchestration mode is mutually exclusive with Ultra and preserves native thinking level', async () => {
  const root = fresh();
  const service = makeComposer(root);

  setSessionThinkingLevel('s1', 'high', root);
  await service.setUltraMode({ sessionId: 's1', enabled: true });
  assert.equal(readSessionUltraMode('s1', root), true);
  assert.equal(readSessionOrchestrationMode('s1', root), false);

  await service.setOrchestrationMode({ sessionId: 's1', enabled: true });
  assert.equal(readSessionOrchestrationMode('s1', root), true);
  assert.equal(readSessionUltraMode('s1', root), false);
  assert.equal(readSessionThinkingLevel('s1', root), 'high');

  // Native thinking changes without explicit ultraMode:false preserve work modes
  await service.setThinking({ sessionId: 's1', level: 'max' });
  assert.equal(readSessionThinkingLevel('s1', root), 'max');
  assert.equal(readSessionOrchestrationMode('s1', root), true);

  // Re-enabling Ultra clears orchestration mode on that session
  await service.setUltraMode({ sessionId: 's1', enabled: true });
  assert.equal(readSessionUltraMode('s1', root), true);
  assert.equal(readSessionOrchestrationMode('s1', root), false);
});

h.test('buildSessionInit and inferenceInit carry orchestrationMode and orchestratorTarget only when configured', async () => {
  const root = fresh();
  const service = makeComposer(root);
  const features = new ModelFeatureSettings(root);

  const baseline = buildSessionInit({
    rendererId: 's-default',
    cwd: root,
    resolvedAuth: { kind: 'engineModel', selection: 'subscription:opus', source: 'subscription' },
    configRoot: root,
  });
  assert.equal(baseline.ok, true);
  if (!baseline.ok) return;
  assert.equal(Object.hasOwn(baseline.init, 'orchestrationMode'), false);
  assert.equal(Object.hasOwn(baseline.init, 'orchestratorTarget'), false);
  assert.equal(Object.hasOwn(baseline.init, 'orchestratorFallbackToMain'), false);

  features.setOrchestrator({ model: 'antigravity:gemini-4-hydrogen', fallbackToMain: true });
  await service.setOrchestrationMode({ sessionId: 's-orch', enabled: true });
  const active = buildSessionInit({
    rendererId: 's-orch',
    cwd: root,
    resolvedAuth: { kind: 'engineModel', selection: 'subscription:opus', source: 'subscription' },
    configRoot: root,
  });
  assert.equal(active.ok, true);
  if (!active.ok) return;
  assert.equal(active.init.orchestrationMode, true);
  assert.equal(active.init.orchestratorFallbackToMain, true);
  assert.deepEqual(active.init.orchestratorTarget, {
    type: 'source',
    source: 'antigravity',
    modelId: 'gemini-4-hydrogen',
  });

  const selection = inferenceInit(active.init);
  assert.equal(selection.orchestrationMode, true);
  assert.equal(selection.orchestratorFallbackToMain, true);
  assert.deepEqual(selection.orchestratorTarget, active.init.orchestratorTarget);

  const cleared = replaceInferenceInit(active.init, inferenceInit(baseline.init));
  assert.equal(Object.hasOwn(cleared, 'orchestrationMode'), false);
  assert.equal(Object.hasOwn(cleared, 'orchestratorTarget'), false);
  assert.equal(Object.hasOwn(cleared, 'orchestratorFallbackToMain'), false);
});

h.test('orchestrator fallback events project toast frames and unattended scheduled runs auto-decline fallback prompts', () => {
  const frames = projectEngineEvent({
    type: 'sessionEvent',
    method: 'session/event',
    params: {
      sessionId: 'sess-1',
      turnId: 'turn-1',
      event: {
        submissionId: 'sub-1',
        event: {
          type: 'tool.event',
          turnId: 'turn-1',
          toolUseId: 'call-1',
          event: {
            type: 'orchestrator_fallback',
            failedModel: 'qwen3-coder-plus',
            mainModel: 'opus',
            reason: 'quota',
          },
        },
      },
    },
  });
  assert.deepEqual(frames, [{
    type: 'orchestrator_fallback',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    failedModel: 'qwen3-coder-plus',
    mainModel: 'opus',
    reason: 'quota',
  }]);

  const emitted: Array<{ channel: string; payload: Json }> = [];
  const state = new HostState();
  state.rememberSession('attended-chat', 'eng-attended', {});
  state.rememberSession('cron-chat', 'eng-cron', {});
  const forwarder = new ChatEventForwarder((channel, payload) => emitted.push({ channel, payload }));
  const pump = new SessionEventPump({
    state,
    forwarder,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    currentGeneration: () => 1,
    log: () => {},
    isUnattended: id => id === 'cron-chat',
  });

  let cronResponse: Json = null;
  pump.receive({
    type: 'reverseRequest',
    request: {
      id: 1,
      method: 'elicitation/request',
      params: {
        sessionId: 'eng-cron',
        elicitation: {
          requestId: 'req-cron',
          request: {
            prompt: 'Continue with chat model?',
            options: ['continue_with_main', 'pause'],
            multiSelect: false,
            metadata: { kind: 'orchestrator_fallback', failedModel: 'mini', mainModel: 'opus', reasonCode: 'quota' },
          },
        },
      },
      outstanding: true,
      respond: async value => { cronResponse = value; },
      respondError: async () => {},
    },
  }, 1);
  assert.deepEqual(cronResponse, { kind: 'decline', reason: 'unattended_scheduled_run' });
  assert.equal(emitted.filter(e => e.channel === 'elicit:request').length, 0);

  pump.receive({
    type: 'reverseRequest',
    request: {
      id: 2,
      method: 'elicitation/request',
      params: {
        sessionId: 'eng-attended',
        elicitation: {
          requestId: 'req-ui',
          request: {
            prompt: 'Continue with chat model?',
            options: ['continue_with_main', 'pause'],
            multiSelect: false,
            metadata: { kind: 'orchestrator_fallback', failedModel: 'mini', mainModel: 'opus', reasonCode: 'quota' },
          },
        },
      },
      outstanding: true,
      respond: async () => {},
      respondError: async () => {},
    },
  }, 1);
  const elicitPushes = emitted.filter(e => e.channel === 'elicit:request');
  assert.equal(elicitPushes.length, 1);
  assert.deepEqual(object(elicitPushes[0]!.payload).metadata, {
    kind: 'orchestrator_fallback',
    failedModel: 'mini',
    mainModel: 'opus',
    reasonCode: 'quota',
  });
  forwarder.close();
});

void h.finish(process.argv[2] ?? join(tmpdir(), 'orchestration-mode-result.json'), 'orchestration-mode').then(code => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
