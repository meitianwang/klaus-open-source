import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

;(globalThis as any).window = { addEventListener: () => {} }

const { LiveToolCard } = await import('./TranscriptView')
import type { ToolCardState } from '../stream-store'

const bashCard = (progress: unknown[]): ToolCardState => ({
  toolCallId: 'call-1',
  toolName: 'bash',
  args: { command: 'printf hello' },
  argsDelta: '',
  progress,
  status: 'running',
  agent: false,
  bgTask: false,
})

describe('live tool card rendering', () => {
  test('streamed output only changes the detail payload', () => {
    const first = renderToStaticMarkup(<LiveToolCard card={bashCard(['hel'])} open onToggle={() => {}} />)
    const next = renderToStaticMarkup(<LiveToolCard card={bashCard(['hel', 'lo'])} open onToggle={() => {}} />)
    expect(first).toContain('data-tool-call-id="call-1"')
    expect(next).toContain('data-tool-call-id="call-1"')
    expect(next).toContain('hello')
  })

  test('the expanded state belongs to the stable card shell', () => {
    const html = renderToStaticMarkup(
      <LiveToolCard card={bashCard(['hello'])} open onToggle={() => {}} />,
    )

    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('data-tool-call-id="call-1"')
    expect(html).toContain('aria-controls=')
    expect(html).toContain('hello')
  })

  test('offers the process workspace when a Bash result carries shellId', () => {
    const html = renderToStaticMarkup(
      <LiveToolCard card={{ ...bashCard([]), status: 'ok', content: '{"shellId":"shell-9"}' }} sessionId="session-1" open onToggle={() => {}} />,
    )

    expect(html).toContain('Open process')
  })

  test('drops media whose scoped URL cannot be resolved', () => {
    const html = renderToStaticMarkup(
      <LiveToolCard card={{ ...bashCard([]), media: [{ path: '/missing.png' }] }} open={false} onToggle={() => {}} />,
    )

    expect(html).not.toContain('<img')
  })
})
