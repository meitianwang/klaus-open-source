// DOM-verification entry: exposes the REAL postProcessHtml path (markdown render
// → created-thread pass) plus the real factories to a headless-Chrome harness.
// Built by esbuild with css loader; the built CSS is injected by the harness so
// geometry assertions run against the shipped styles, not a re-implementation.
import { renderMarkdownHtml } from '../../chat/markdown'
// The whole TranscriptView graph pulls React + bridge shims; postProcessHtml is
// not exported. Re-importing it here would drag the component tree into the
// harness, so the harness drives the SAME per-line walk the real
// `renderCreatedThreadCards` runs — including the `<br>`→newline normalization,
// which is the part textContent-only unit stubs cannot see (`breaks: true`
// glues consecutive directive lines into one textContent run).
import { renderCreatedThreadListHtml, renderCreatedThreadCardHtml } from './factories'
import { parseCreatedThreadDirective } from '../../../../contracts/created-thread-directive'
import { makeTranscriptClickHandler } from './TranscriptView'

export function consume(markdown: string): { bodyHtml: string; cardsHtml: string; leaked: boolean } {
  const html = renderMarkdownHtml(markdown)
  const host = document.createElement('div')
  host.innerHTML = html
  const threadIds: string[] = []
  for (const paragraph of [...host.querySelectorAll('p')]) {
    for (const br of paragraph.querySelectorAll('br')) br.replaceWith('\n')
    const lines = (paragraph.textContent ?? '').split('\n').map(line => line.trim()).filter(line => line.length > 0)
    if (lines.length === 0) continue
    const directives = lines.map(line => parseCreatedThreadDirective(line))
    if (directives.some(d => d === null)) continue
    for (const directive of directives) threadIds.push(directive!.threadId)
    paragraph.remove()
  }
  return { bodyHtml: host.innerHTML, cardsHtml: renderCreatedThreadListHtml(threadIds), leaked: host.innerHTML.includes('::created-thread') }
}

export { makeTranscriptClickHandler }
