import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { StaticTranscriptView, TranscriptView } from './transcript/TranscriptView'
import { ingestChatEvent } from './stream-store'
import { configureImagePreview, openImagePreview, performImageAction, type PreviewImage } from './image-preview'
import { initWorkspacePanel, openWorkspaceImageTab, hideWorkspaceMainView } from './workspace-panel'

const host = window as any
const container = document.getElementById('messages')!
const root = createRoot(container)
const owner = 'screenshot-owner'
host.currentSessionId = 'foreign-current-chat'
host.currentLang = 'zh'
host.openImagePreview = openImagePreview
host.tt = (key: string) => key
const image = (second = false): PreviewImage => ({
  path: second ? host.screenshotFixture.second : host.screenshotFixture.first,
  sessionId: owner, name: second ? 'Second screenshot.png' : 'Verified UI.png',
  src: host.klaus.media.url(second ? host.screenshotFixture.second : host.screenshotFixture.first, owner),
})
const finalText = () => 'UI verification completed.\n\n![Verified UI](<' + host.screenshotFixture.first + '>)'
configureImagePreview({
  openTab: openWorkspaceImageTab,
  currentChat: () => host.currentSessionId || '',
  addToChat: async (file, target) => {
    if (target !== host.currentSessionId) throw new Error('Conversation changed during attachment loading')
    await host.screenshotFixture.attach({ name: file.name, type: file.type, target, bytes: [...new Uint8Array(await file.arrayBuffer())] })
  },
})
const panel = document.getElementById('artifacts-panel')!
initWorkspacePanel({
  ensureSession: async () => {
    if (!host.currentSessionId && host.promoteImageDraft) {
      if (host.deferImageDraft) await new Promise<void>(resolve => { host.resolveImageDraft = resolve })
      host.currentSessionId = 'promoted-image-draft'
    }
    return host.currentSessionId
  }, draftProjectWorkdir: () => null,
  inputEl: () => document.getElementById('composer') as HTMLTextAreaElement,
  addWorkspaceComposerMention: () => {}, rememberWorkspaceRoot: () => {}, closeSessionContextMenu: () => {},
  hideBtwPanel: () => {}, setCurrentNonChatView: () => {},
  openArtifactsPanel: mode => { panel.dataset.mode = mode; panel.hidden = false },
  setArtifactsPanelMode: mode => { panel.dataset.mode = mode },
  syncArtifactsToggleVisibility: () => {}, syncTopModeButtons: () => {}, renderSessionList: () => {},
  artifactsPanel: () => panel, artifactsList: () => document.getElementById('artifact-list'),
})
const renderStatic = (includeTool: boolean, scope = owner) => {
  const msgs: any[] = [{ uuid: 'user', role: 'user', text: 'Verify the visible change', turnId: 'verification-turn' }]
  if (includeTool) msgs.push({ uuid: 'tool', role: 'assistant', turnId: 'verification-turn', contentBlocks: [{ type: 'tool_use', id: 'capture', name: 'browser_screenshot', input: {}, __result: { content: [
    { type: 'text', text: 'Saved: ' + JSON.stringify(host.screenshotFixture.first) }, { type: 'image', path: host.screenshotFixture.first, mimeType: 'image/png' },
  ] } }] })
  msgs.push({ uuid: 'final', role: 'assistant', text: finalText(), isFinalReply: true, turnId: 'verification-turn' })
  flushSync(() => root.render(createElement(StaticTranscriptView, { msgs, container, running: false, sessionId: scope })))
}
host.uiScreenshotFixture = {
  owner, image,
  history: (msgs: any[], sessionId: string) => {
    flushSync(() => root.render(createElement(StaticTranscriptView, { msgs, container, running: false, sessionId })))
  },
  final: (includeTool = true) => renderStatic(includeTool),
  sentAttachment: async (replay = false) => {
    const source = image()
    const attachments = []
    if (!replay) {
      const result = await host.klaus.media.readImage({ sessionId: owner, filePath: source.path })
      if (!result.ok) throw new Error(result.error)
      const bytes = Uint8Array.from(atob(result.data), char => char.charCodeAt(0))
      attachments.push({ type: 'image', path: source.path, name: source.name,
        src: URL.createObjectURL(new Blob([bytes], { type: result.mimeType })) })
    }
    const msg = { uuid: 'attachment-user', role: 'user', text: 'Inspect this image',
      ...(replay ? { contentBlocks: [{ type: 'image', path: source.path }] }
        : { localRender: { attachments } }) }
    flushSync(() => root.render(createElement(StaticTranscriptView, { msgs: [msg], container, running: false, sessionId: owner })))
  },
  live: () => {
    flushSync(() => root.render(createElement(TranscriptView, { sessionId: owner, container, scroll: 'none' })))
    ingestChatEvent({ type: 'requesting', sessionId: owner })
    ingestChatEvent({ type: 'tool_start', sessionId: owner, toolCallId: 'live-capture', toolName: 'browser_screenshot', args: {} })
    ingestChatEvent({ type: 'tool_end', sessionId: owner, toolCallId: 'live-capture', content: 'Saved: ' + JSON.stringify(host.screenshotFixture.first), media: [{ path: host.screenshotFixture.first, mimeType: 'image/png' }] })
  },
  deliver: () => ingestChatEvent({ type: 'text_delta', sessionId: owner, messageId: 'live-final', phase: 'final_answer', text: finalText() }),
  broken: () => openImagePreview(host.screenshotFixture.remote.replace('screenshot.png', 'missing.png'), { gallery: [{ src: host.screenshotFixture.remote.replace('screenshot.png', 'missing.png'), name: 'Unavailable screenshot.png' }, image()] }),
  gallery: (second = false) => openImagePreview(image(second).src, { source: image(second), gallery: [image(), image(true)], index: second ? 1 : 0, opener: document.getElementById('composer')! }),
  action: (action: string, remote = false) => performImageAction(action, remote ? { src: host.screenshotFixture.remote, name: 'remote.png' } : image()),
  tab: (second = false) => openWorkspaceImageTab(image(second)),
  hideTab: hideWorkspaceMainView,
  unmount: () => flushSync(() => root.render(null)),
  inspect: () => ({
    figures: container.querySelectorAll('[data-media-figure]').length,
    finalImages: container.querySelectorAll('.msg.assistant img').length,
    sourceOwners: [...container.querySelectorAll<HTMLElement>('[data-media-figure]')].map(node => node.dataset.mediaSession),
    loaded: [...container.querySelectorAll<HTMLImageElement>('img')].every(node => node.complete && node.naturalWidth > 0),
    viewer: document.querySelector('.image-preview-viewer') !== null,
    menu: document.querySelector('.image-preview-menu') !== null,
  }),
}
renderStatic(false)
