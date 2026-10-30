import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readFrontendFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

const CHAT_TS = readFrontendFile('./chat.ts')
const BRIDGE_TS = readFrontendFile('../../bridge/klaus-api.ts')

describe('sent skill display persistence wire', () => {
  test('selected skills send a display snapshot through chat:send', () => {
    expect(CHAT_TS).toContain("command.kind === 'skill' || source.includes('skill')")
    expect(CHAT_TS).toContain('displayText: payload.displayText')
    expect(CHAT_TS).toContain(".filter((attachment) => attachment.type !== 'image')")
    expect(CHAT_TS).toContain('pastedCards: payload.pastedCards || []')
    expect(CHAT_TS).toContain('selectedTextAttachments: payload.selectedTextAttachments || []')
    expect(CHAT_TS).toContain('sentUserDisplayMetadata(payload)')
    expect(BRIDGE_TS).toContain("call('chat:send', { sessionId, text, media, displayMetadata })")
  })

  test('sent skill pills do not author tooltip attributes', () => {
    const start = CHAT_TS.indexOf('function renderSlashPillHtml(')
    const end = CHAT_TS.indexOf('\nfunction sentUserDisplayMetadata(', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = CHAT_TS.slice(start, end)

    expect(body).not.toContain('title=')
    expect(body).not.toContain('data-klaus-tip')
  })
})
