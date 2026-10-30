import { expect, test } from 'bun:test';
import vectors from '../../../contracts/vectors/desktop-pet-voice-vectors.json';
import { petRealtimeSourceOptions, petVoiceTarget } from '../../../main/pets/realtime-source';
import { petVoiceError } from './voice-errors';

for (const [index, row] of vectors.targets.entries()) test(`voice target vector ${index + 1}`, () => {
  expect(petVoiceTarget('explicit' in row ? row.explicit : undefined, 'companion' in row ? row.companion : undefined, row.main) ?? null).toBe(row.expected);
});
for (const [index, row] of vectors.sources.entries()) test(`realtime source vector ${index + 1} remains independent of the conversation model`, async () => {
  for (const target of [undefined, 'visible-conversation']) {
    const capabilities: string[] = [];
    const value = await petRealtimeSourceOptions({
      capabilities: async id => { capabilities.push(id); return { available: true }; }, log: () => {},
    }, 'configuredSource' in row ? row.configuredSource : undefined, target);
    expect(value.sourceId).toBe(row.expectedSource); expect(value.available).toBe(row.available);
    expect(value.targetSessionId).toBe(target);
    expect(capabilities).toEqual(row.available ? [row.expectedSource] : []);
    if ('reason' in row) expect(value.reason).toBe(row.reason);
  }
});
test('source lookup failure is explicit and never switches providers', async () => {
  let requests = 0;
  const value = await petRealtimeSourceOptions({ capabilities: async () => { requests++; throw Error('offline'); }, log: () => {} }, 'selected-audio', 'visible');
  expect(value.available).toBe(false); expect(value.reason).toBe('realtime-source-unavailable'); expect(requests).toBe(1);
  expect(value.sourceId).toBe('selected-audio');
});
test('Chinese voice errors identify unsupported capability and hide raw transport text', () => {
  expect(petVoiceError('realtime-source-not-configured', 'zh')).toBe(vectors.presentation.notConfiguredZh);
  expect(petVoiceError('realtime-source-unsupported', 'zh')).toBe(vectors.presentation.unsupportedZh);
  expect(petVoiceError('The selected source has no explicit realtime capability', 'zh')).toContain('实时');
  expect(petVoiceError('private backend error in English', 'zh')).not.toMatch(/[a-zA-Z]/);
  expect(petVoiceError('qwenwork_transcription_authentication_required', 'zh')).toContain('登录');
  expect(petVoiceError('voice-source-unavailable', 'zh')).toContain('语音输入');
});
