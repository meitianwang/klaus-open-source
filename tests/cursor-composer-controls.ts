import { ComposerService, type ComposerChange } from '../main/services/composer';
import { IpcHandlerError } from '../main/ipc/registry';
import { buildSessionInit } from '../main/services/session-init';
import { readSessionModel, readSessionThinkingLevel, setSessionModel, setSessionThinkingLevel, applySessionThinkingSelection, sessionPermissionPreset, setSessionPermissionPreset } from '../main/services/session-store';
import { kvGet, kvSet } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import { cursorFastMode, cursorThinkingLevels, cursorVariantForFast, cursorVariantForThinking, modelOptionForValue, pickCursorModelMetadata } from '../shared/cursor-model-catalog';
import { assert, assertDeepEqual, assertEqual, assertRejects, type Harness } from './harness';

const picks = [
  ['300k', 'medium', 'false', false], ['300k', 'high', 'false', false],
  ['300k', 'medium', 'true', true], ['300k', 'high', 'true', true],
  ['1m', 'high', 'true', true],
] as const;
const key = (context: string, effort: string, fast: string) => `cursor:fixture[context=${context},fast=${fast},reasoning_effort=${effort}]${fast === 'true' ? '@max' : ''}`;
const initial = key('300k', 'medium', 'false');
const models: JsonObject[] = picks.map(([context, effort, fast, maxMode], index) => ({
  key: key(context, effort, fast).slice(7), modelId: 'fixture', modelName: 'Fixture', isDefault: index === 0,
  display_name: `Fixture ${effort}`, efforts: [effort], defaultEffort: effort,
  requestedModel: { modelId: 'fixture', maxMode, parameters: [{ id: 'context', value: context },
    { id: 'reasoning_effort', value: effort }, { id: 'fast', value: fast }] },
}));

function fixture(root: string, onChange: (change: ComposerChange) => void | Promise<void> = () => {}, beforeCatalog?: () => Promise<void>) {
  const configuration: JsonObject = {};
  return new ComposerService({ configRoot: root, push: () => {}, onSessionConfigChanged: onChange,
    request: async (method, params) => {
      if (method === 'config/read') return { values: structuredClone(configuration), resolved: structuredClone(configuration), version: '1' };
      if (method === 'config/batchWrite') { for (const row of object(params).edits as JsonObject[]) { if (row.value === null) delete configuration[String(row.keyPath)]; else configuration[String(row.keyPath)] = row.value!; } return {}; }
      if (method === 'cursor/models') { await beforeCatalog?.(); return { models }; }
      throw new Error(`Unexpected request: ${method}`);
    } });
}

export function registerCursorComposerControlTests(h: Harness, freshRoot: () => string): void {
  h.test('Cursor existing reasoning and Fast setters persist real members in only the current conversation', async () => {
    const root = freshRoot(), changes: ComposerChange[] = [], service = fixture(root, change => { changes.push(change); });
    setSessionModel('a', initial, 'cursor', root);
    setSessionModel('b', initial, 'cursor', root);
    kvSet('composer.codex_fast_mode', 'false', root);
    assertDeepEqual(await service.getThinking('a'), { level: 'medium' }, 'exact native level paints');
    await service.setThinking({ sessionId: 'a', level: 'high' });
    assertEqual(readSessionModel('a', root).mode, key('300k', 'high', 'false'), 'native reasoning selection');
    await service.setFastMode({ sessionId: 'a', enabled: true });
    assertEqual(readSessionModel('a', root).mode, key('300k', 'high', 'true'), 'real Fast carries target Max mode');
    assertDeepEqual(await service.getFastMode('a'), { enabled: true, supported: true }, 'shared Fast getter');
    assertEqual(readSessionThinkingLevel('a', root), 'high', 'Fast preserves reasoning');
    assertEqual(readSessionModel('b', root).mode, initial, 'other conversation unchanged');
    assertEqual(kvGet('composer.codex_fast_mode', root), 'false', 'Codex preference unchanged');
    assertDeepEqual(changes, [{ kind: 'model', sessionId: 'a' }, { kind: 'model', sessionId: 'a' }], 'one scoped publication per change');
    const init = buildSessionInit({ rendererId: 'a', cwd: root, configRoot: root });
    assert(init.ok, 'session init');
    assertEqual(object(init.init.config).fastMode, undefined, 'no Codex transport flag on Cursor');
  });
  h.test('Cursor hidden context restricts reasoning and Fast to actual compatible members', async () => {
    const root = freshRoot(), service = fixture(root), saved = key('1m', 'high', 'true');
    setSessionModel('a', saved, 'cursor', root);
    const options = await service.options('cursor');
    const selected = modelOptionForValue(options, saved)!;
    assertDeepEqual(object(selected).supportedThinkingLevels, ['high'], 'no invented compatible rung');
    assertDeepEqual(await service.getFastMode('a'), { enabled: true, supported: false }, 'no opposite Fast variant');
    await assertRejects(() => service.setThinking({ sessionId: 'a', level: 'medium' }), 'missing reasoning combination');
    await assertRejects(() => service.setFastMode({ sessionId: 'a', enabled: false }), 'missing Fast combination');
    assertEqual(readSessionModel('a', root).mode, saved, 'hidden context retained on rejection');
  });
  h.test('Cursor Ultra uses existing local policy and can return to a real native reasoning rung', async () => {
    const root = freshRoot(), service = fixture(root);
    setSessionModel('a', initial, 'cursor', root);
    setSessionPermissionPreset('a', 'bypassPermissions', root);
    await service.setThinking({ sessionId: 'a', level: 'ultra', permissionMode: 'default' });
    assertEqual(readSessionModel('a', root).mode, initial, 'Ultra preserves native variant');
    assertDeepEqual(await service.getUltraMode('a'), { enabled: true }, 'independent local Ultra');
    assertEqual(sessionPermissionPreset('a', root), 'default', 'the selected policy is stored canonically');
    assertEqual(kvGet('composer.permission_mode', root), null, 'no legacy default is written');
    await service.setThinking({ sessionId: 'a', level: 'medium' });
    assertEqual(readSessionModel('a', root).mode, initial, 'return keeps native selection');
    assertDeepEqual(await service.getThinking('a'), { level: 'medium' }, 'native reasoning retained');
    assertDeepEqual(await service.getUltraMode('a'), { enabled: true }, 'native reasoning does not disable Ultra');
    await service.setUltraMode({ sessionId: 'a', enabled: false });
    assertDeepEqual(await service.getUltraMode('a'), { enabled: false }, 'explicit toggle disables Ultra');
  });
  h.test('Cursor failed publication rolls back native model, reasoning and optional permission together', async () => {
    const root = freshRoot(), service = fixture(root, () => { throw new Error('publication refused'); });
    setSessionModel('a', initial, 'cursor', root, { thinkingLevel: 'medium' });
    await assertRejects(() => service.setThinking({ sessionId: 'a', level: 'high' }), 'publication failure');
    assertEqual(readSessionModel('a', root).mode, initial, 'session model restored');
    assertEqual(kvGet('composer.main_model', root), initial, 'future default restored');
    assertEqual(readSessionThinkingLevel('a', root), 'medium', 'reasoning restored');
    await assertRejects(() => service.setFastMode({ sessionId: 'a', enabled: true }), 'Fast publication failure');
    assertEqual(readSessionModel('a', root).mode, initial, 'Fast model restored');
    setSessionPermissionPreset('a', 'bypassPermissions', root);
    await assertRejects(() => service.setThinking({ sessionId: 'a', level: 'ultra', permissionMode: 'default' }), 'permission publication failure');
    assertEqual(sessionPermissionPreset('a', root), 'bypassPermissions', 'permission restored');
    assertEqual(readSessionThinkingLevel('a', root), 'medium', 'Ultra rolled back');
  });
  h.test('Cursor Fast does not overwrite another conversation reasoning default', async () => {
    const root = freshRoot(), service = fixture(root);
    setSessionModel('a', initial, 'cursor', root, { thinkingLevel: 'medium' });
    setSessionThinkingLevel('b', 'max', root);
    await service.setFastMode({ sessionId: 'a', enabled: true });
    assertEqual(readSessionThinkingLevel('a', root), 'medium', 'current reasoning retained');
    assertEqual(readSessionThinkingLevel('', root), 'max', 'future reasoning retained');
  });
  h.test('Cursor catalog wait cannot apply an old preference to a newly selected source', async () => {
    const root = freshRoot(); let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = fixture(root, () => {}, async () => { entered(); await gate; });
    setSessionModel('a', initial, 'cursor', root);
    const pending = service.setFastMode({ sessionId: 'a', enabled: true });
    await started;
    setSessionModel('a', 'codex:fixture', 'codex', root);
    release();
    const error = await assertRejects(() => pending, 'stale source rejected');
    assert(error instanceof IpcHandlerError && error.code === 'MODEL_SELECTION_CHANGED', 'typed stale selection');
    assertEqual(readSessionModel('a', root).mode, 'codex:fixture', 'new source retained');
  });
  h.test('Cursor combined remote preference selects the native member through the existing model setter', async () => {
    const root = freshRoot(), service = fixture(root);
    await service.setModel({ sessionId: 'a', mode: initial, source: 'cursor', thinkingLevel: 'high' });
    assertEqual(readSessionModel('a', root).mode, key('300k', 'high', 'false'), 'native model selected');
    assertEqual(readSessionThinkingLevel('a', root), 'high', 'same transaction reasoning');
  });
  h.test('Cursor boolean thinking, blocked and ambiguous native members remain capability accurate', () => {
    const variants = ['false', 'true'].map(thinking => ({ value: `cursor:boolean[thinking=${thinking}]`, label: 'Boolean', parameters: { thinking }, maxMode: false }));
    const model = { cursorModelId: 'boolean', cursorVariants: variants };
    assertDeepEqual(cursorThinkingLevels(model, variants[0]!.value), ['off', 'high'], 'boolean native choices');
    assertDeepEqual(cursorThinkingLevels({ ...model, cursorVariants: [variants[1]!] }, variants[1]!.value), ['high'], 'fixed true has no Off');
    assertEqual(cursorVariantForThinking(model, variants[0]!.value, 'high')?.value, variants[1]!.value, 'On is actual true member');
    const fast = { cursorModelId: 'x', cursorVariants: [
      { value: 'cursor:x[fast=false]', label: 'X', parameters: { fast: 'false' }, maxMode: false },
      { value: 'cursor:x[fast=true]', label: 'X', parameters: { fast: 'true' }, maxMode: false },
      { value: 'cursor:x[fast=true]@max', label: 'X', parameters: { fast: 'true' }, maxMode: true },
    ] };
    assertEqual(cursorVariantForFast(fast, fast.cursorVariants[0]!.value, true), undefined, 'ambiguous target rejected');
    const blocked = pickCursorModelMetadata({ ...model, cursorParameterDefinitions: [{ id: 'thinking', name: 'Thinking', type: 'boolean', values: [{ value: 'true', blockedByAdminAllowlist: true }] }] });
    assertDeepEqual(cursorThinkingLevels(blocked, variants[0]!.value), ['off', 'high'], 'declared restricted native choices remain selectable');
    assertEqual(cursorVariantForThinking(blocked, variants[0]!.value, 'high')?.value, variants[1]!.value, 'restriction metadata preserves the exact declared target');
    assertDeepEqual(cursorFastMode(model, variants[0]!.value), { enabled: false, supported: false }, 'no invented Fast');
  });
  h.test('Cursor preference rollback leaves a newer model and independent defaults intact', () => {
    const root = freshRoot();
    setSessionModel('a', initial, 'cursor', root, { thinkingLevel: 'medium' });
    const selection = applySessionThinkingSelection('a', 'high', root, undefined, { model: { source: 'cursor', mode: key('300k', 'high', 'false') } });
    setSessionModel('a', 'codex:newer', 'codex', root, { thinkingLevel: 'max' });
    selection.rollback();
    assertDeepEqual(readSessionModel('a', root), { mode: 'codex:newer', source: 'codex' }, 'newer session retained');
    assertEqual(readSessionThinkingLevel('a', root), 'max', 'newer reasoning retained');
    assertEqual(kvGet('composer.main_model', root), 'codex:newer', 'newer default retained');
  });
  h.test('Cursor rollback owns the future model and source as a pair', () => {
    const root = freshRoot();
    setSessionModel('a', initial, 'cursor', root, { thinkingLevel: 'medium' });
    setSessionModel('b', 'codex:default', 'codex', root);
    const selection = applySessionThinkingSelection('a', 'high', root, undefined, { model: { source: 'cursor', mode: key('300k', 'high', 'false') } });
    setSessionModel('b', key('1m', 'high', 'true'), 'cursor', root);
    selection.rollback();
    assertEqual(kvGet('composer.main_model', root), key('1m', 'high', 'true'), 'newer same-source default retained');
    assertEqual(kvGet('auth_mode', root), 'cursor', 'source stays paired with newer model');
    assertEqual(readSessionModel('a', root).mode, initial, 'owned conversation restored independently');
  });
}
