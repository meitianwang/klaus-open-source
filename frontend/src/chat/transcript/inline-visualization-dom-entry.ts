import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { FinalAssistantBubble } from './TranscriptView'

const root = createRoot(document.getElementById('root')!)
let openedExternal = ''
;(window as any).klaus = { app: { openExternal: async (url: string) => { openedExternal = url } } }
;(window as any).tt = (key: string) => key
;(window as any).currentLang = 'en'
const render = (text: string, fragments: any[] = [], key = text) => flushSync(() => root.render(createElement(FinalAssistantBubble, { key, text, sessionId: 'session-12345678', inlineVis: fragments })))
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 80 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 15))
  if (!predicate()) throw new Error('Inline visualization DOM timed out')
}
const checks: Record<string, boolean> = {}
let step = 'init'
const directive = '::klaus-inline-vis{path="/tmp/chart.html"}'
const page = '<html><body><div id="page">hello</div></body></html>'
async function main() {
  step = 'valid'
  render(`Before\n\n${directive}\n\nAfter`, [{ path: '/tmp/chart.html', contents: page }], 'valid')
  await waitFor(() => document.querySelector('iframe') !== null)
  const frame = document.querySelector('iframe')!
  const body = document.querySelector('.msg.assistant')!
  checks.mountsFromProjectedContent = frame.getAttribute('srcdoc')?.includes('hello') === true
    && frame.getAttribute('srcdoc')?.includes('__klaus_inline_visualization_ready__') === true
  checks.positionPreserved = body.querySelector('p')?.textContent === 'Before'
    && body.querySelectorAll('p').item(body.querySelectorAll('p').length - 1)?.textContent === 'After'
  checks.sandboxOpaque = frame.getAttribute('sandbox') === 'allow-scripts' && !frame.getAttribute('sandbox')?.includes('allow-same-origin')
  checks.noSecondReadSurface = (window as any).klaus.artifacts === undefined
  step = 'fenced'
  render('```text\n' + directive + '\n```', [{ path: '/tmp/chart.html', contents: page }], 'fenced')
  checks.fenceDoesNotMount = document.querySelector('iframe') === null && document.querySelector('pre code')?.textContent?.includes(directive) === true
  step = 'prose'
  render('Mention ' + directive + ' in prose.', [{ path: '/tmp/chart.html', contents: page }], 'prose')
  checks.proseDoesNotMount = document.querySelector('iframe') === null && document.querySelector('.msg.assistant')?.textContent?.includes(directive) === true
  step = 'invalid'
  render('::klaus-inline-vis{path="/tmp/bad_name.html"}', [{ path: '/tmp/bad_name.html', contents: page }], 'invalid')
  checks.badNameStaysText = document.querySelector('iframe') === null && document.querySelector('.msg.assistant')?.textContent?.includes('::klaus-inline-vis') === true
  step = 'autoheight'
  render(directive, [{ path: '/tmp/chart.html', contents: '<html><body><div style="height:600px">tall</div></body></html>' }], 'autoheight')
  await waitFor(() => {
    const shell = document.querySelector('.klaus-inline-vis-shell') as HTMLElement | null
    return shell !== null && Math.abs(parseInt(shell.style.height, 10) - 616) <= 48
  })
  checks.autoHeightWithoutPageOptIn = true
  step = 'expand'
  const expandButton = document.querySelector('[data-klaus-inline-vis-expand]') as HTMLButtonElement | null
  expandButton?.click()
  await waitFor(() => document.querySelector('.klaus-inline-vis-backdrop') !== null)
  const openedExpanded = document.querySelector('.klaus-inline-vis')?.classList.contains('klaus-inline-vis-expanded') === true
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await waitFor(() => document.querySelector('.klaus-inline-vis-backdrop') === null)
  checks.expandOverlayRoundTrip = openedExpanded
    && document.querySelector('.klaus-inline-vis')?.classList.contains('klaus-inline-vis-expanded') === false
  step = 'refused'
  render(directive, [{ path: '/tmp/chart.html', contents: null, readError: 'file not found' }], 'refused')
  await waitFor(() => document.querySelector('[data-klaus-inline-vis-banner]') !== null)
  const banner = document.querySelector('[data-klaus-inline-vis-banner]')!
  checks.refusalShowsFailureBanner = document.querySelector('iframe') === null
    && document.querySelector('[data-klaus-inline-vis-failure]')?.getAttribute('data-klaus-inline-vis-failure') === '/tmp/chart.html'
    && (banner.textContent ?? '').includes('An error occurred inside the visualization')
    && banner.querySelector('[data-klaus-inline-vis-reload]') === null
  checks.refusalDoesNotEchoDirective = !(banner.textContent ?? '').includes('::klaus-inline-vis')
  step = 'unprojected'
  render(directive, [], 'unprojected')
  checks.unprojectedStaysText = document.querySelector('iframe') === null
    && document.querySelector('[data-klaus-inline-vis-failure]') === null
    && document.querySelector('.msg.assistant')?.textContent?.includes(directive) === true
  document.getElementById('result')!.textContent = JSON.stringify({ checks, openedExternal })
}
main().catch(error => { document.getElementById('result')!.textContent = JSON.stringify({ error: String(error), step }) })
