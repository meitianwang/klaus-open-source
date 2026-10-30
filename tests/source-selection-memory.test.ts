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

h.test('source memory restores reasoning and orchestration settings independently', () => {
  const root = freshRoot();
  setSessionModel('thread', 'codex:one', 'codex', root, { thinkingLevel: 'high', ultraMode: true });
  setSessionModel('thread', 'custom:one', 'custom', root, { thinkingLevel: 'low', ultraMode: false });

  setSessionModel('thread', 'auto', 'codex', root);
  assertEqual(readSessionThinkingLevel('thread', root), 'high', 'the Codex reasoning level returns');
  assertEqual(readSessionUltraMode('thread', root), true, 'the Codex orchestration switch returns');

  setSessionModel('thread', 'auto', 'custom', root);
  assertEqual(readSessionThinkingLevel('thread', root), 'low', 'the custom reasoning level returns');
  assertEqual(readSessionUltraMode('thread', root), false, 'the custom orchestration switch returns');
});

h.test('standalone reasoning and orchestration picks update the source memory', () => {
  const root = freshRoot();
  setSessionModel('thread', 'codex:one', 'codex', root);
  setSessionThinkingLevel('thread', 'xhigh', root);
  applySessionUltraSelection('thread', true, root);

  setSessionModel('thread', 'custom:one', 'custom', root);
  setSessionModel('thread', 'auto', 'codex', root);
  assertEqual(readSessionThinkingLevel('thread', root), 'xhigh', 'a reasoning-only pick is remembered');
  assertEqual(readSessionUltraMode('thread', root), true, 'an orchestration-only pick is remembered');
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

void (async () => {
  const failed = await h.finish(join(__dirname, 'source-selection-memory-result.json'), 'source-selection-memory');
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exit(failed);
})();
