import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PetConversationState } from '../../../contracts/desktop-pet-composer';
if (typeof window === 'undefined') (globalThis as any).window = {};
const { Conversation } = await import('./Conversation');
const state = (patch: Partial<PetConversationState> = {}): PetConversationState => ({ sessionId: 'conversation-1', title: 'Selected conversation', revision: 1, loading: false, running: false, messages: [], ...patch });
const render = (value: PetConversationState) => renderToStaticMarkup(<Conversation state={value} language="en" onReply={() => {}} onClose={() => {}} onError={() => {}} />);
test('a running conversation renders live text and its stop action without losing the companion surface', () => {
  const html = render(state({ running: true, messages: [{ id: 'user-1', role: 'user', text: 'Inspect this task' }, { id: 'assistant-1', role: 'assistant', text: 'fragment-0 fragment-767', pending: true }] }));
  expect(html).toContain('aria-label="Stop task"');
  expect(html).toContain('fragment-0 fragment-767');
  expect(html).toContain('Inspect this task');
  expect(html).toContain('role="log"');
});
test('a completed conversation retains its history and navigation controls', () => {
  const html = render(state({ messages: [{ id: 'assistant-1', role: 'assistant', text: 'The task completed.' }] }));
  expect(html).toContain('The task completed.');
  expect(html).toContain('aria-label="New conversation"');
  expect(html).not.toContain('aria-label="Stop task"');
});
test('an unselected draft does not render a stale conversation', () => {
  expect(render(state({ sessionId: null }))).toBe('');
});
