import { ByteBudgetLru } from './byte-budget'
import type { MarkdownPipeline } from './markdown-pipeline'

type Pipeline = MarkdownPipeline
interface PrefixState { sessionId: string; source: string; html: string }

/** Cache one stable prefix per live message, rather than every growing version. */
export function createStreamingMarkdownRenderer(buildPipeline: (sessionId: string) => Pipeline, maxBytes = 16 * 1024 * 1024) {
  const prefixes = new ByteBudgetLru<string, PrefixState>(maxBytes, 32)
  const pipelines = new ByteBudgetLru<string, Pipeline>(1024 * 1024, 8)
  let parsedChars = 0
  let reusedChars = 0
  const parse = (pipeline: Pipeline, source: string) => { parsedChars += source.length; return pipeline(source) }
  return {
    render(source: string, sessionId: string, streamId: string, settled = false): string {
      let pipeline = pipelines.get(sessionId)
      if (!pipeline) { pipeline = buildPipeline(sessionId); pipelines.set(sessionId, pipeline, 1024); pipelines.trim() }
      const key = JSON.stringify([sessionId, streamId])
      if (settled) { prefixes.delete(key); return parse(pipeline, source) }
      // Reference definitions can resolve links in earlier blocks. Reparse those
      // messages as a whole, including definitions nested in lists or quotes.
      if (source.includes('$') || source.includes(']:')) { prefixes.delete(key); return parse(pipeline, source) }
      const previous = prefixes.get(key)
      const state = previous && source.startsWith(previous.source) ? previous : { sessionId, source: '', html: '' }
      const tail = source.slice(state.source.length)
      const tokens = pipeline.lex(tail)
      // Some extensions normalize their raw input. Only source-exact token
      // boundaries can be reused without changing the document's whitespace.
      if (tokens.map(token => token.raw).join('') !== tail) { prefixes.delete(key); return parse(pipeline, source) }
      let last = tokens.length - 1
      while (last >= 0 && tokens[last].type === 'space') last--
      let stableLength = 0
      for (let index = 0; index < last; index++) stableLength += tokens[index].raw.length
      const stable = tail.slice(0, stableLength)
      const prefix = { sessionId, source: state.source + stable, html: state.html + (stable ? parse(pipeline, stable) : '') }
      reusedChars += state.source.length
      const html = prefix.html + parse(pipeline, tail.slice(stableLength))
      const bytes = 64 + (prefix.source.length + prefix.html.length) * 2
      if (bytes <= maxBytes) { prefixes.set(key, prefix, bytes); prefixes.trim() }
      else prefixes.delete(key)
      return html
    },
    forget(sessionId: string) {
      pipelines.delete(sessionId)
      // At most 32 prefix records are retained. Deletion does not leave their
      // source strings alive in a separate registry.
      prefixes.deleteWhere((_, state) => state.sessionId === sessionId)
    },
    stats: () => ({ entries: prefixes.size, bytes: prefixes.bytes, maxBytes, parsedChars, reusedChars }),
  }
}
