import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { createSourceFile, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'
import { mediaInputMime } from '../../../../shared/media-input'
import { isInlineImage } from './attachment-policy'
import { normalizeComposerReferences } from './reference-token'
import { encodeSelectedTextEnvelope, parseSelectedTextEnvelope } from '../selected-text-envelope'
import { pendingEntriesFromPrepare } from './sent-message-edit'
import { userAttachmentsFromContentBlocks } from '../transcript/factories'

const ast = createSourceFile('chat.ts', readFileSync(new URL('../chat.ts', import.meta.url), 'utf8'), ScriptTarget.ESNext, true)
const declarations = ast.statements.filter(node => isFunctionDeclaration(node) && ['buildOutgoingPayload', 'sentUserDisplayMetadata', 'queuedPendingFiles'].includes(node.name?.text || ''))
const api = runInNewContext(transpileModule(declarations.map(node => node.getText(ast)).join('\n') + '\n({ buildOutgoingPayload, sentUserDisplayMetadata, queuedPendingFiles })', {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText, { crypto: { randomUUID }, mediaInputMime, isInlineImage, normalizeComposerReferences, encodeSelectedTextEnvelope, parseSelectedTextEnvelope, pendingEntriesFromPrepare,
  composePastedTextRequest: (text: string) => ({ text }), resourceReferenceContext: () => '', Date,
})
const file = (name: string, type: string) => ({ file: { name, type, size: 10 }, uploadPath: '/uploads/' + name, uploading: false })

describe('media attachment delivery', () => {
  test('audio and video stay file cards and retain path references alongside host candidates', () => {
    const files = [file('voice.wav', 'audio/wav'), file('clip.mp4', 'video/mp4'), file('notes.pdf', 'application/pdf')]
    const payload = api.buildOutgoingPayload('Review', files, null, 'side-session')
    expect(payload.media).toEqual([
      { type: 'media', path: '/uploads/voice.wav', name: 'voice.wav', fileName: 'voice.wav', mimeType: 'audio/wav' },
      { type: 'media', path: '/uploads/clip.mp4', name: 'clip.mp4', fileName: 'clip.mp4', mimeType: 'video/mp4' },
    ])
    expect(payload.liveAttachments.map((row: any) => [row.type, row.src])).toEqual([['file', ''], ['file', ''], ['file', '']])
    expect(payload.finalText).toContain('Attached:\n- /uploads/voice.wav\n- /uploads/clip.mp4\n- /uploads/notes.pdf')
    const display = api.sentUserDisplayMetadata(payload)
    expect(display.attachments).toEqual([
      { type: 'file', name: 'voice.wav', path: '/uploads/voice.wav', mimeType: 'audio/wav' },
      { type: 'file', name: 'clip.mp4', path: '/uploads/clip.mp4', mimeType: 'video/mp4' },
      { type: 'file', name: 'notes.pdf', path: '/uploads/notes.pdf' },
    ])
    expect(display.displayText).toBe('Review')
  })

  test('exact declared codecs and path-imported media types survive queue editing', () => {
    const payload = api.buildOutgoingPayload('', [file('recording.webm', 'audio/webm;codecs=opus'), file('movie.mp4', '')], null, 'main-session')
    expect(payload.media.map((row: any) => row.mimeType)).toEqual(['audio/webm;codecs=opus', 'video/mp4'])
    const entries: ReturnType<typeof pendingEntriesFromPrepare> = api.queuedPendingFiles(JSON.parse(JSON.stringify(payload)), 'side-session')
    expect(entries.map(row => row.objectUrl)).toEqual([null, null])
    const restored = api.buildOutgoingPayload('', entries, null, 'side-session')
    expect(restored.media.map((row: any) => row.mimeType)).toEqual(['audio/webm;codecs=opus', 'video/mp4'])
  })

  test('native media history renders as a file card and never an image', () => {
    expect(userAttachmentsFromContentBlocks([{ type: 'media', mimeType: 'audio/wav', filename: 'voice.wav', path: '/pool/voice.wav' }]))
      .toEqual([{ type: 'file', name: 'voice.wav', path: '/pool/voice.wav' }])
    expect(mediaInputMime('renamed.png', 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus')
    expect(mediaInputMime('report.pdf', 'application/pdf')).toBeUndefined()
    expect(mediaInputMime('voice.wav', 'audio/*')).toBeUndefined()
  })
})
