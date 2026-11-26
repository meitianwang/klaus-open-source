import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { appendLocalMediaCacheKey, normalizeMediaCacheToken, stampLocalMediaHtml } from '../../../bridge/media-url'

const src = 'klaus-media://localhost/a?s=chat'

test('normalizes long and unsafe keys deterministically', () => {
  expect(normalizeMediaCacheToken()).toBe('')
  expect(normalizeMediaCacheToken('turn.1_a-b')).toBe('turn.1_a-b')
  const key = 'long unsafe key /'.repeat(8)
  const token = normalizeMediaCacheToken(key)
  expect(token).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
  expect(normalizeMediaCacheToken(key)).toBe(token)
  expect(normalizeMediaCacheToken(key + 'b')).not.toBe(token)
})

test('stamps only local URLs and round-trips HTML ampersands', () => {
  expect(appendLocalMediaCacheKey(src + '&v=old', 'new')).toBe(src + '&v=new')
  expect(appendLocalMediaCacheKey('http://klaus-media.localhost/a', 'new')).toBe('http://klaus-media.localhost/a?v=new')
  for (const other of ['https://example.com/a', 'data:image/png;base64,a', 'blob:https://example.com/a', 'klaus-media://file/a', 'klaus-media://fixture/a']) {
    expect(appendLocalMediaCacheKey(other, 'new')).toBe(other)
    const html = `<img src="${other}">`
    expect(stampLocalMediaHtml(html, 'new')).toBe(html)
  }
  expect(stampLocalMediaHtml(`<img src="${src}&amp;v=old" data-media-src="${src}">`, 'new'))
    .toBe(`<img src="${src}&amp;v=new" data-media-src="${src}&amp;v=new">`)
})

test('isolates turns and retains the final live image URL when settled', async () => {
  const path = '/ws/a.png'
  const text = `![image](${path})`
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  globalThis.window = { ...globalThis.window, addEventListener: () => {}, klaus: { media: { url: () => src } } } as unknown as Window & typeof globalThis
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  try {
    const { FinalAssistantBubble, LiveTextView, MediaCacheEpochContext, TurnMediaBlock } = await import('./TranscriptView')
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      createElement: () => ({ innerHTML: '', querySelectorAll: () => [] }),
    } })
    const version = (element: React.ReactNode) => {
      const html = renderToStaticMarkup(<MediaCacheEpochContext.Provider value="m1">{element}</MediaCacheEpochContext.Provider>)
      const token = html.match(/klaus-media:\/\/localhost\/[^"\s]+&amp;v=([A-Za-z0-9._-]+)/)?.[1]
      expect(token).toBeTruthy()
      return token
    }
    const first = version(<FinalAssistantBubble text={text} sessionId="chat" turnId="one" />)
    expect(version(<FinalAssistantBubble text={text} sessionId="chat" turnId="two" />)).not.toBe(first)
    expect(version(<TurnMediaBlock paths={[path]} sessionId="chat" cacheKey="one" />))
      .not.toBe(version(<TurnMediaBlock paths={[path]} sessionId="chat" cacheKey="two" />))
    expect(version(<LiveTextView unit={{ type: 'live-text', key: 'live', turnId: 'one', text, streaming: false }}
      sessionId="chat" unitProps={{ isThinkingExpanded: () => false, onToggleThinking: () => {}, archived: false, running: true, composerAuthored: false, editTarget: null }}
      mediaPaths={new Set()} isLastText />)).toBe(first)
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
    else Reflect.deleteProperty(globalThis, 'document')
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})
