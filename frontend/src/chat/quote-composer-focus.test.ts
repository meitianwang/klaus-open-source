// Regression gate: transcript quotes use a real contenteditable pill and native
// caret, while deferred focus restores the insertion range after the toolbar click.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { focusComposerInput } from './composer/focus'
import { composerDocumentFromText } from './composer/document-model'
import { projectComposerDocument } from './composer/document-projection'

const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')
const QUOTE_SELECTION_TSX = readFileSync(fileURLToPath(new URL('./transcript/quote-selection.tsx', import.meta.url)), 'utf8')
const TRANSCRIPT_CSS = readFileSync(fileURLToPath(new URL('./transcript/transcript.module.css', import.meta.url)), 'utf8')
const STYLES_CSS = readFileSync(fileURLToPath(new URL('../../css/styles.css', import.meta.url)), 'utf8')
const INDEX_HTML = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')

describe('quote composer handoff', () => {
  test('the main composer is a contenteditable textbox instead of a transparent textarea', () => {
    expect(INDEX_HTML).toContain('<div id="input" contenteditable="true" role="textbox" aria-multiline="true"')
    expect(CHAT_TS).toContain('installContenteditableTextControl(inputEl as unknown as HTMLElement')
    expect(CHAT_TS).toContain("const quoteEntries = inputEl.tagName === 'TEXTAREA' ? inlineQuoteEntries() : []")
  })

  test('a quote exposes legal caret positions on both sides without extra text', () => {
    const token = { start: 1, end: 2, value: '\uFFFC', data: { kind: 'selected-text', quoteId: 'quoted', text: 'Full passage' } }
    const document = composerDocumentFromText('a\uFFFCz', [token])
    const projection = projectComposerDocument(document)
    expect(projection.text).toBe('a\uFFFCz')
    expect(projection.tokens).toEqual([token])
    expect(projection.documentPosition(1)).toBe(2)
    expect(projection.documentPosition(2)).toBe(3)
    expect(document.resolve(2).parent.isTextblock).toBe(true)
    expect(document.resolve(3).parent.isTextblock).toBe(true)
  })

  test('the selection toolbar preserves the range on mousedown and commits on click', () => {
    expect(QUOTE_SELECTION_TSX).toContain('onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}')
    expect(QUOTE_SELECTION_TSX).toContain('onClick={commitAddToChat}')
    expect(QUOTE_SELECTION_TSX).toContain('<Icon name="quoted-text" size={16} />')
    expect(QUOTE_SELECTION_TSX).toContain('<Icon name="side-task" size={16} />')
    expect(QUOTE_SELECTION_TSX).not.toContain('if (event.detail === 0) commitAddToChat()')
  })

  test('focus restores the selection after the toolbar handoff settles', () => {
    const frames: Array<(time: number) => void> = []
    const timers: Array<() => void> = []
    let focusCalls = 0
    const doc: any = { activeElement: null, defaultView: null, querySelector: () => null }
    const input: any = {
      ownerDocument: doc,
      value: 'quoted prompt',
      selectionStart: 7,
      selectionEnd: 7,
      focus() {
        focusCalls += 1
        doc.activeElement = input
        input.selectionStart = 0
        input.selectionEnd = 0
      },
      setSelectionRange(start: number, end: number) {
        input.selectionStart = start
        input.selectionEnd = end
      },
    }
    doc.defaultView = {
      setTimeout(callback: () => void) {
        timers.push(callback)
        return timers.length
      },
      requestAnimationFrame(callback: (time: number) => void) {
        frames.push(callback)
        return frames.length
      },
    }

    focusComposerInput(input, 7)
    expect(focusCalls).toBe(0)
    timers.shift()?.()
    expect(doc.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 0])
    frames.shift()?.(0)
    expect(focusCalls).toBe(1)
    expect([input.selectionStart, input.selectionEnd]).toEqual([7, 7])
  })

  test('the pill stays compact without constraining editable caret text', () => {
    expect(STYLES_CSS).toMatch(/\.kls-inline-quote,[\s\S]*?max-width: min\(120px, 100%\);[\s\S]*?height: 18px;/)
    const boundaryRule = STYLES_CSS.match(/\.composer-inline-caret-boundary \{([^}]+)\}/)?.[1] || ''
    expect(boundaryRule).toContain('display: inline;')
    expect(boundaryRule).toContain('white-space: pre-wrap;')
    expect(boundaryRule).not.toMatch(/(?:width|height):/)
    expect(boundaryRule).not.toContain('user-select: none')
    // Adding a quote pill must not resize the composer: the pill is real
    // editor content inside the same box, so no rule may override the input's
    // min-height floor (or its ink) while a pill is present.
    expect(STYLES_CSS).not.toContain('has-inline-quote-token #input')
    expect(STYLES_CSS).not.toContain('has-inline-quote-token #side-input')
    expect(TRANSCRIPT_CSS).toMatch(/\.quote-toolbar \{[\s\S]*?border-radius: var\(--radius-sm\);[\s\S]*?backdrop-filter: blur\(8px\);/)
    expect(TRANSCRIPT_CSS).toMatch(/\.quote-toolbar-btn \{[\s\S]*?gap: 3px;[\s\S]*?padding: 3px 6px;/)
  })
})
