import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { setMarkdownWorkerFactory, useAsyncMarkdownHtml } from './markdown-async'
import { StreamingHtml } from '../components/StreamingHtml'
import { FinalAssistantBubble } from './transcript/TranscriptView'
import { renderMarkdownHtml } from './markdown'

/** Runs inside an isolated renderer fixture; worker replies stay gated deliberately. */
export async function verifyMarkdownAsyncTransitions(container: HTMLElement): Promise<string[]> {
  const gatedWorker = { postMessage() {}, terminate() {}, onmessage: null, onerror: null }
  setMarkdownWorkerFactory(() => gatedWorker as unknown as Worker)
  const root = createRoot(container)
  function Preview({ source, streaming = false }: { source: string; streaming?: boolean }) {
    const html = useAsyncMarkdownHtml(source, 'preview-transition', 'same-message', streaming)
    return <div data-preview-content="" dangerouslySetInnerHTML={{ __html: html }} />
  }
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  const verified: string[] = []
  try {
    flushSync(() => root.render(<Preview source="A short plain reply." />))
    await frame()
    const paragraph = 'A complete paragraph remains visible. '.repeat(180)
    flushSync(() => root.render(<Preview source={paragraph} />))
    await frame()
    if (!container.querySelector('[data-preview-content] p')?.textContent?.includes('remains visible')) throw new Error('Long paragraph vanished while its worker was pending')
    verified.push('short reply to long paragraph remains visible before worker completion')
    flushSync(() => root.render(<Preview source="A short plain reply." />))
    await frame()
    const code = 'Before.\n\n```typescript\nconst visible = true\n```\n'
    flushSync(() => root.render(<Preview source={code} />))
    await frame()
    if (!container.querySelector('pre code')?.textContent?.includes('const visible = true')) throw new Error('Code structure vanished while its worker was pending')
    if (container.textContent?.includes('```')) throw new Error('Raw fences appeared before code highlighting')
    verified.push('short reply to code preserves structure before worker completion')
    flushSync(() => root.render(<Preview source="" streaming />))
    flushSync(() => root.render(<Preview source="A visible first stream chunk." streaming />))
    await frame()
    if (!container.textContent?.includes('A visible first stream chunk.')) throw new Error('First streamed text stayed blank behind a pending worker')
    verified.push('empty streaming placeholder shows its first text before worker completion')
    const initial = '<p>Stable text</p><span class="md-media-player" data-media-path="/voice.mp3" data-media-src="media:voice"><span class="md-media-player-skeleton"></span></span>'
    flushSync(() => root.render(<StreamingHtml className="preview-stream" html={initial} />))
    const text = container.querySelector('p')!.firstChild!
    const player = container.querySelector('.md-media-player')!
    const controls = document.createElement('audio')
    player.replaceChildren(controls)
    flushSync(() => root.render(<StreamingHtml className="preview-stream" html={initial.replace('Stable text', 'Stable text appended')} />))
    await frame()
    if (container.querySelector('p')!.firstChild !== text || text.textContent !== 'Stable text appended') throw new Error('Streaming text replaced its stable text node')
    if (container.querySelector('audio') !== controls) throw new Error('Streaming append reset the mounted media player')
    verified.push('streaming append preserves text nodes and mounted media controls')
    return verified
  } finally {
    flushSync(() => root.unmount())
    setMarkdownWorkerFactory(null)
  }
}


/** Hold the actual settled renderer between structural preview and final highlighting. */
export async function verifySettledHighlightInteraction(container: HTMLElement): Promise<string[]> {
  const root = createRoot(container)
  const verified: string[] = []
  const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  let menuButton: HTMLButtonElement | null = null
  const fragment = {
    path: '/fixture/interactive-control.html',
    contents: `<input id="persistent-control" value="initial"><script>
      const generation = Math.random().toString(36);
      addEventListener('message', event => {
        if (event.data?.source !== 'settled-highlight-fixture') return;
        const input = document.getElementById('persistent-control');
        if (typeof event.data.value === 'string') input.value = event.data.value;
        parent.postMessage({source:'settled-highlight-fixture',requestId:event.data.requestId,value:input.value,generation}, '*');
      });
    </script>`,
  }
  const source = '![Recorded clip](/fixture/recorded-clip.wav)\n\n'
    + '::klaus-inline-vis{path="/fixture/interactive-control.html"}\n\n'
    + '```\nconst result = values.map(value => ({ ...value, active: true }));\nconsole.log(result);\n```\n'
  const exchange = async (iframe: HTMLIFrameElement, value?: string): Promise<{ value: string; generation: string }> => {
    const requestId = Math.random().toString(36)
    let response: { value: string; generation: string } | null = null
    const receive = (event: MessageEvent) => {
      if (event.source === iframe.contentWindow && event.data?.source === 'settled-highlight-fixture' && event.data.requestId === requestId) response = event.data
    }
    window.addEventListener('message', receive)
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        iframe.contentWindow?.postMessage({ source: 'settled-highlight-fixture', requestId, value }, '*')
        await new Promise(resolve => setTimeout(resolve, 20))
        if (response) return response
      }
      throw new Error('The mounted visualization did not report its control state')
    } finally { window.removeEventListener('message', receive) }
  }
  try {
    for (const split of [false, true]) {
      const jobs: Array<{ id: number; source: string; sessionId: string }> = []
      const worker = {
        postMessage(message: any) { if (typeof message.id === 'number') jobs.push(message) },
        terminate() {}, onmessage: null as ((event: any) => void) | null, onerror: null,
      }
      setMarkdownWorkerFactory(() => worker as unknown as Worker)
      const sessionId = `settled-highlight-${split ? 'message' : 'wrapper'}`
      const references = split ? [{ id: 'fixture-reference', url: 'https://example.invalid/reference', title: 'Fixture reference', turnId: 'fixture-turn' }] : []
      const render = (text: string) => <FinalAssistantBubble text={text} sessionId={sessionId} turnId="fixture-turn" inlineVis={[fragment]} websiteReferences={references} />
      flushSync(() => root.render(render(source)))
      await frame(); await frame()
      const job = jobs.at(-1)
      if (!job) throw new Error('The settled interactive reply did not queue its final highlight')
      const audio = container.querySelector('audio')!
      const seek = container.querySelector<HTMLInputElement>('.md-media-player-seek input')!
      const iframe = container.querySelector('iframe')!
      const copy = container.querySelector<HTMLButtonElement>('.code-copy')!
      const code = container.querySelector('pre code')!
      if (!audio || !seek || !iframe || !copy || !code) throw new Error('The structural preview did not mount its interactive content')
      if (copy.parentElement!.querySelector(':scope > span')) throw new Error('The unlabeled code preview unexpectedly has a language badge')
      seek.max = '60'; seek.value = '12.5'
      audio.dataset.fixturePlaybackPosition = '12.5'
      audio.dispatchEvent(new Event('play'))
      const play = container.querySelector<HTMLButtonElement>('.md-media-player-play')!
      const playLabel = play.getAttribute('aria-label')
      const before = await exchange(iframe, 'Authored embedded input survives highlighting')
      let menu: HTMLElement | null = null
      if (split) {
        menuButton = container.querySelector<HTMLButtonElement>('.md-media-player-menu')!
        menuButton.click()
        menu = document.getElementById(menuButton.getAttribute('aria-controls') || '')
        if (!menu) throw new Error('The media actions menu did not open in the preview')
      } else {
        copy.focus()
        const range = document.createRange()
        range.setStart(code.firstChild!, 0)
        range.setEnd(code.firstChild!, 12)
        getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
      }
      const selected = getSelection()?.toString()
      worker.onmessage?.({ data: { id: job.id, html: renderMarkdownHtml(job.source, job.sessionId), stats: { entries: 0 } } })
      await frame(); await frame()
      if (container.querySelector('audio') !== audio || container.querySelector('.md-media-player-seek input') !== seek || seek.value !== '12.5') throw new Error('Final highlighting reset the mounted audio controls')
      if (audio.dataset.fixturePlaybackPosition !== '12.5' || play.getAttribute('aria-label') !== playLabel) throw new Error('Final highlighting reset playback presentation')
      if (container.querySelector('iframe') !== iframe) throw new Error('Final highlighting replaced the mounted visualization')
      const after = await exchange(iframe)
      if (after.generation !== before.generation || after.value !== before.value) throw new Error('Final highlighting reloaded the visualization or reset its input')
      if (container.querySelector('.code-copy') !== copy) throw new Error('Final highlighting replaced the code copy control')
      if (!copy.parentElement!.querySelector(':scope > span')?.textContent) throw new Error('Automatic language detection did not add its final badge')
      if (!container.querySelector('code span[class*="hljs-"]')) throw new Error('The final code highlight was not applied')
      if (!split && (document.activeElement !== copy || getSelection()?.toString() !== selected)) throw new Error('Final highlighting lost copy focus or code selection')
      if (split && (!menu?.isConnected || menuButton?.getAttribute('aria-expanded') !== 'true')) throw new Error('Final highlighting closed the media actions menu')
      if (menuButton?.isConnected) menuButton.click()
      menuButton = null
      verified.push(`${split ? 'message' : 'wrapper'} settled highlight preserves media, iframe input and code controls while adding an automatic language badge`)
      flushSync(() => root.render(render(source.replace('Recorded clip', 'A changed recording'))))
      await frame(); await frame()
      if (container.querySelector('audio') === audio || container.querySelector('iframe') === iframe) throw new Error('An actual Markdown content change incorrectly retained the old mounted content')
      verified.push(`${split ? 'message' : 'wrapper'} actual source change replaces the old interactive content`)
      flushSync(() => root.render(null))
    }
    return verified
  } finally {
    if (menuButton?.isConnected) menuButton.click()
    flushSync(() => root.unmount())
    setMarkdownWorkerFactory(null)
  }
}
