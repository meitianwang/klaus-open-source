import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import { ComposerService } from '../main/services/composer';
import {
  applySessionUltraSelection,
  readSessionModel,
  readSessionThinkingLevel,
  readSessionUltraMode,
  setSessionModel,
  setSessionThinkingLevel,
} from '../main/services/session-store';
import { Harness, assertEqual } from './harness';

const h = new Harness();
const roots: string[] = [];
const freshRoot = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'klaus-source-memory-'));
  roots.push(path);
  return path;
};

h.test('switching back to a source restores its last concrete model and conversation default', () => {
  const root = freshRoot();
  setSessionModel('', 'custom:preferred', 'custom', root);
  setSessionModel('', 'codex:preferred', 'codex', root);

  setSessionModel('', 'auto', 'custom', root);
  assertEqual(readSessionModel('', root).mode, 'custom:preferred', 'new conversations use the source last pick');
  assertEqual(readSessionModel('', root).source, 'custom', 'the remembered source remains active');
});

h.test('a conversation restores the model it last used on that source', () => {
  const root = freshRoot();
  setSessionModel('thread', 'custom:one', 'custom', root);
  setSessionModel('thread', 'codex:one', 'codex', root);

  setSessionModel('thread', 'auto', 'custom', root);
  assertEqual(readSessionModel('thread', root).mode, 'custom:one', 'the previous custom pick returns');
  assertEqual(readSessionModel('thread', root).source, 'custom', 'the conversation stays on the requested source');
});

h.test('source memory restores reasoning settings while preserving session work modes across source switches', () => {
  const root = freshRoot();
  setSessionModel('thread', 'codex:one', 'codex', root, { thinkingLevel: 'high', ultraMode: true });
  setSessionModel('thread', 'custom:one', 'custom', root, { thinkingLevel: 'low' });

  assertEqual(readSessionThinkingLevel('thread', root), 'low', 'the custom reasoning level applies');
  assertEqual(readSessionUltraMode('thread', root), true, 'switching model source preserves the active Parallel work mode');

  setSessionModel('thread', 'auto', 'codex', root);
  assertEqual(readSessionThinkingLevel('thread', root), 'high', 'the Codex reasoning level returns');
  assertEqual(readSessionUltraMode('thread', root), true, 'Parallel work mode remains active across source switches');
});

h.test('standalone reasoning picks update the source memory without tying work modes to a source', () => {
  const root = freshRoot();
  setSessionModel('thread', 'codex:one', 'codex', root);
  setSessionThinkingLevel('thread', 'xhigh', root);
  applySessionUltraSelection('thread', true, root);

  setSessionModel('thread', 'custom:one', 'custom', root);
  setSessionModel('thread', 'auto', 'codex', root);
  assertEqual(readSessionThinkingLevel('thread', root), 'xhigh', 'a reasoning-only pick is remembered');
  assertEqual(readSessionUltraMode('thread', root), true, 'the session work mode remains intact');
});

h.test('a source with no memory still resolves its own default', () => {
  const root = freshRoot();
  setSessionModel('thread', 'custom:one', 'custom', root);

  setSessionModel('thread', 'auto', 'codex', root);
  assertEqual(readSessionModel('thread', root).mode, 'auto', 'an unseen source falls back to its routing default');
  assertEqual(readSessionModel('thread', root).source, 'codex', 'the source switch itself still lands');
});

h.test('the composer restores a remembered cursor pick without resolving the routing default', async () => {
  const root = freshRoot();
  setSessionModel('', 'cursor:concrete[effort=high,fast=true]', 'cursor', root);
  setSessionModel('thread', 'custom:one', 'custom', root);
  let requests = 0;
  const composer = new ComposerService({
    configRoot: root,
    push: () => {},
    onSessionConfigChanged: () => {},
    request: async (): Promise<Json> => {
      requests += 1;
      throw new Error('The remembered selection must not be resolved as auto');
    },
  });

  await composer.setModel({ sessionId: 'thread', mode: 'auto', source: 'cursor' });
  assertEqual(readSessionModel('thread', root).mode, 'cursor:concrete[effort=high,fast=true]', 'the exact remembered member is restored');
  assertEqual(requests, 0, 'the routing alias is not resolved when a concrete memory exists');
});

h.test('changing reasoning in an active conversation promotes both its model and reasoning level for new conversations', async () => {
  const root = freshRoot();
  const pushed: string[] = [];
  const composer = new ComposerService({
    configRoot: root,
    push: (_channel, payload) => {
      if (payload && typeof payload === 'object' && 'key' in payload && typeof payload.key === 'string') pushed.push(payload.key);
    },
    onSessionConfigChanged: () => {},
    request: async (): Promise<Json> => ({}),
  });
  setSessionModel('chat-a', 'custom:alpha', 'custom', root, { thinkingLevel: 'medium' });
  setSessionModel('chat-b', 'custom:beta', 'custom', root, { thinkingLevel: 'low' });
  assertEqual(readSessionModel('', root).mode, 'custom:beta', 'latest model pick owns the new-chat default initially');

  pushed.length = 0;
  await composer.setThinking({ sessionId: 'chat-a', level: 'high' });
  assertEqual(readSessionModel('new-chat', root).mode, 'custom:alpha', 'new conversation inherits the active conversation model');
  assertEqual(readSessionModel('new-chat', root).source, 'custom', 'new conversation inherits the active conversation source');
  assertEqual(readSessionThinkingLevel('new-chat', root), 'high', 'new conversation inherits the active conversation reasoning level');
  assertEqual(readSessionModel('chat-b', root).mode, 'custom:beta', 'other open conversations keep their own model');
  assertEqual(readSessionThinkingLevel('chat-b', root), 'low', 'other open conversations keep their own reasoning level');
  assertEqual(pushed.includes('composer.main_model'), true, 'renderer new-draft cache is invalidated when default model shifts');
});

h.test('re-activating an already-active source after login or import preserves concrete model and reasoning defaults', async () => {
  const root = freshRoot();
  const composer = new ComposerService({
    configRoot: root,
    push: () => {},
    onSessionConfigChanged: () => {},
    request: async (): Promise<Json> => {
      throw new Error('Same-source re-activation must keep the concrete model without resolving auto');
    },
  });
  setSessionModel('active-chat', 'subscription:claude-opus-4-7', 'subscription', root, { thinkingLevel: 'high' });

  await composer.setModel({ sessionId: 'active-chat', mode: 'auto', source: 'subscription' });
  assertEqual(readSessionModel('active-chat', root).mode, 'subscription:claude-opus-4-7', 'active chat keeps its concrete model after account re-login');
  assertEqual(readSessionThinkingLevel('active-chat', root), 'high', 'active chat keeps its reasoning level after account re-login');
  assertEqual(readSessionModel('next-chat', root).mode, 'subscription:claude-opus-4-7', 'future chats keep the concrete model after account re-login');
  assertEqual(readSessionThinkingLevel('next-chat', root), 'high', 'future chats keep the reasoning level after account re-login');

  await composer.setModel({ mode: 'auto', source: 'subscription' });
  assertEqual(readSessionModel('', root).mode, 'subscription:claude-opus-4-7', 'draft re-login preserves concrete default model');
  assertEqual(readSessionThinkingLevel('', root), 'high', 'draft re-login preserves default reasoning level');
});

void (async () => {
  const failed = await h.finish(join(__dirname, 'source-selection-memory-result.json'), 'source-selection-memory');
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exit(failed);
})();
