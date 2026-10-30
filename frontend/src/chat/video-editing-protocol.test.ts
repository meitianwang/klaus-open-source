import { expect, test } from 'bun:test'
import { createVideoEditingHostSurface } from '../../bridge/video-editing-api'
import { normalizeToolResultForReplay, normalizeVisualArtifact } from './transcript/factories'
import { semanticActivity, semanticActivityLabel } from './transcript/activity-semantic'

test('the video runtime exposes its lifecycle through one owned channel', async () => {
  const calls: unknown[] = []
  const host = createVideoEditingHostSurface(async (channel, args) => { calls.push([channel, args]); return { ok: true } })
  expect(Object.keys(host)).toEqual(['action'])
  for (const type of ['runtime', 'changed', 'open-url', 'ready', 'error'] as const) {
    expect(await host.action({ type })).toEqual({ ok: true })
  }
  expect(calls).toEqual(['runtime', 'changed', 'open-url', 'ready', 'error'].map(type => [
    'video-editing:runtime-action', { action: { type } },
  ]))
})

test('video artifacts survive replay with identity and reject failed or invalid results', () => {
  const artifact = { kind: 'video-editing', id: 'film-workspace', title: 'Launch film' }
  expect(normalizeToolResultForReplay({ content: [], artifact })?.artifact).toEqual(artifact)
  expect(normalizeToolResultForReplay({ content: [], artifact, is_error: true })?.artifact).toBeUndefined()
  expect(normalizeVisualArtifact({ kind: 'video-editing', id: '' })).toBeUndefined()
  expect(normalizeVisualArtifact({ kind: 'video-editing', id: 'film-workspace' })?.title).toBe('Video Editing')
  expect(normalizeVisualArtifact({ kind: 'unknown-video', id: 'film-workspace' })).toBeUndefined()
})

test('video activity keeps the owned namespace, action and localized result', () => {
  const activity = semanticActivity('mcp__klaus-video-editing__video_editing_execute', { title: 'Launch film' })!
  expect(activity).toEqual({ action: 'video_editing_execute', icon: 'tool-generate-video', target: 'Launch film', category: 'video' })
  expect(semanticActivityLabel(activity, 'done', 'en')).toBe('Edited video · Launch film')
  expect(semanticActivityLabel(activity, 'error', 'zh')).toBe('编辑视频失败 · Launch film')
  expect(semanticActivity('mcp__other__video_editing_execute')).toBeNull()
  expect(semanticActivity('mcp__klaus-video-editing__prototype_open')).toBeNull()
})
