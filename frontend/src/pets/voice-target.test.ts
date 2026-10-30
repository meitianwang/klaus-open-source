import { expect, test } from 'bun:test';
import { returnOwnedVoiceConversation, voiceConversationMismatch } from './voice-target';
for (const phase of ['active', 'stopping'] as const) test(`${phase} voice retains its original conversation when the text target changes`, async () => {
  const state = { phase, sessionId: 'voice-conversation' }, selected: string[] = [];
  expect(voiceConversationMismatch(state, 'different-text-conversation')).toBe('voice-conversation');
  expect(await returnOwnedVoiceConversation(state, 'different-text-conversation', async id => { selected.push(id); })).toBe(true);
  expect(selected).toEqual(['voice-conversation']); expect(state.sessionId).toBe('voice-conversation');
});
test('a new empty text conversation does not silently retarget an owned voice call', async () => {
  const selected: string[] = [], state = { phase: 'active' as const, sessionId: 'voice-conversation' };
  expect(voiceConversationMismatch(state)).toBe('voice-conversation');
  await returnOwnedVoiceConversation(state, undefined, async id => { selected.push(id); }); expect(selected).toEqual(['voice-conversation']);
});
test('same-target and completed calls do not expose a stale return action', async () => {
  const selected: string[] = [], select = async (id: string) => { selected.push(id); };
  expect(voiceConversationMismatch({ phase: 'active', sessionId: 'same' }, 'same')).toBe(undefined);
  expect(await returnOwnedVoiceConversation({ phase: 'active', sessionId: 'same' }, 'same', select)).toBe(false);
  expect(await returnOwnedVoiceConversation({ phase: 'inactive', sessionId: 'old-voice' }, 'new-text', select)).toBe(false);
  expect(voiceConversationMismatch(null, 'new-text')).toBe(undefined); expect(selected).toEqual([]);
});
