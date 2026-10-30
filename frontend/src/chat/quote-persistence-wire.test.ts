import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')

describe('quote persistence wire', () => {
  test('selection entries are encoded into the sent text and never treated as files', () => {
    const start = CHAT_TS.indexOf('function buildOutgoingPayload(')
    const end = CHAT_TS.indexOf('\nfunction clearComposerAfterSubmit(', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = CHAT_TS.slice(start, end)

    expect(body).toContain("entry.kind === 'selected-text'")
    expect(body).toContain('encodeSelectedTextEnvelope(requestText, encodedSelectedTextAttachments)')
    expect(body).toContain("entry.kind !== 'pasted-text' && entry.kind !== 'selected-text'")
    expect(body).toContain('composePastedTextRequest(text, pastedCards)')
    expect(body).toContain('pastedRequest.requestOffsetFor(Number(entry.requestOffset), entry.displayOrder)')
    expect(body).toContain("text.trimStart().startsWith('/')")
    expect(body).toContain('composeSlashTextCards(text, files.filter')
  })
})
