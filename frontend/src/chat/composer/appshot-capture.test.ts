import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { createAppshotMainConsumer, type AppshotMainDependencies } from './appshot-capture';
import type { PetMainCapture } from '../../../../contracts/desktop-pet-appshot';

function fixture() {
  let session: string | null = 'current';
  const calls: unknown[] = [];
  const deps: AppshotMainDependencies = {
    currentSession: () => session, lastSession: () => 'last',
    newChat: () => { session = null; calls.push('new'); },
    switchSession: async id => { session = id; calls.push(['switch', id]); },
    attach: value => calls.push(['attach', value]), focus: () => calls.push('focus'),
    accepted: async (...value) => { calls.push(['ack', ...value]); },
  };
  const value: PetMainCapture = { captureId: 'capture', threadTarget: 'automatic', attachment: { path: '/uploads/shot.png', name: 'Editor.png', mimeType: 'image/png', size: 200, context: { capturedAt: 123, appName: 'Editor', windowId: 123, selectedText: 'Selected source' } } };
  return { deps, value, calls, setSession: (id: string | null) => { session = id; } };
}
test('a completed application capture preserves actual context and is attached once', async () => {
  const f = fixture(), consume = createAppshotMainConsumer(f.deps);
  await Promise.all([consume(f.value), consume(f.value)]);
  expect(f.calls.length).toBe(3);
  const attach = f.calls[0] as [string, { appshotContext: unknown; uploadPath: string; uploading: boolean }];
  expect(attach[0]).toBe('attach'); expect(attach[1].appshotContext).toEqual(f.value.attachment.context);
  expect(attach[1].uploadPath).toBe('/uploads/shot.png'); expect(attach[1].uploading).toBe(false);
  expect(f.calls.slice(1)).toEqual(['focus', ['ack', 'capture', true]]);
});
test('a new-chat capture uses the existing new chat action before attaching', async () => {
  const f = fixture(); await createAppshotMainConsumer(f.deps)({ ...f.value, threadTarget: 'new-chat' });
  expect(f.calls[0]).toBe('new'); expect((f.calls[1] as unknown[])[0]).toBe('attach'); expect(f.deps.currentSession()).toBe(null);
});
test('a last-chat capture opens an actual known conversation from the welcome state', async () => {
  const f = fixture(); f.setSession(null); await createAppshotMainConsumer(f.deps)({ ...f.value, threadTarget: 'last-chat' });
  expect(f.calls[0]).toEqual(['switch', 'last']); expect(f.deps.currentSession()).toBe('last');
});
test('a conversation navigation race rejects the capture instead of attaching to another draft', async () => {
  const f = fixture(); f.setSession(null); f.deps.switchSession = async () => { f.setSession('other'); };
  await assert.rejects(createAppshotMainConsumer(f.deps)({ ...f.value, threadTarget: 'last-chat' }), /target changed/);
  expect((f.calls[0] as unknown[]).slice(0, 3)).toEqual(['ack', 'capture', false]); expect(f.calls.length).toBe(1);
});
test('invalid capture payloads are rejected before changing a conversation or draft', async () => {
  const f = fixture(); f.value.attachment.mimeType = 'text/plain';
  await assert.rejects(createAppshotMainConsumer(f.deps)(f.value), /unavailable/);
  expect((f.calls[0] as unknown[]).slice(0, 3)).toEqual(['ack', 'capture', false]); expect(f.calls.length).toBe(1);
});
