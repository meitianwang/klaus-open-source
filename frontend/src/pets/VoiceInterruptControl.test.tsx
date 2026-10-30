import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PetLiveVoiceState } from '../../../contracts/desktop-pet-voice';
import { VoiceInterruptControl } from './VoiceInterruptControl';
const state = (patch: Partial<PetLiveVoiceState> = {}): PetLiveVoiceState => ({ available: true, phase: 'active', protocol: 'public', generation: 1, microphoneMuted: false, speakerMuted: false, activity: 'thinking', transcript: [], ...patch });
const render = (value: PetLiveVoiceState, language: 'en' | 'zh' = 'en') => renderToStaticMarkup(<VoiceInterruptControl state={value} language={language} onInterrupt={() => {}} />);
for (const protocol of ['v1', 'frameless'] as const) test(`${protocol} only offers stopping an engine-owned task and never advertises audio cancellation`, () => {
  expect(render(state({ protocol, canInterrupt: true, activity: 'muted' }))).toContain('Stop task');
  expect(render(state({ protocol, canInterrupt: true }), 'zh')).toContain('停止任务');
  expect(render(state({ protocol, canInterrupt: false, activity: 'thinking' }))).toBe('');
  expect(render(state({ protocol, activity: 'speaking' }))).toBe('');
});
test('public voice retains its existing interrupt affordance only while processing or speaking', () => {
  for (const activity of ['thinking', 'speaking'] as const) expect(render(state({ activity, canInterrupt: false }))).toContain('data-voice-interrupt="audio"');
  expect(render(state({ activity: 'listening', canInterrupt: true }))).toBe('');
});
test('closing and completed calls never expose a task cancellation action', () => {
  for (const phase of ['connecting', 'stopping', 'inactive'] as const) expect(render(state({ protocol: 'frameless', phase, canInterrupt: true }))).toBe('');
});
