import { useEffect, useId, useMemo, useState } from 'react'
import { fileIconSvg } from './file-icon'
import { cachedMarkdownHtml, forgetMarkdownSession, primeMarkdownHtml, renderMarkdownHtml, renderMarkdownPreview } from './markdown'

interface Subscriber {
  active: boolean
  latestSource: string
  sessionId: string
  streamId: string
  receive(source: string, html: string): void
  cancel?: () => void
}
interface RenderJob { id: number; source: string; settled: boolean; subscriber: Subscriber }
let factory: (() => Worker) | null = null
let worker: Worker | null = null
let workerGeneration = 0
let failed = false
let sequence = 0
let submitted = 0
let completed = 0
const pendingRetirements = new Set<number>()
let inFlight: RenderJob | null = null
let workerPrefixStats: unknown = null
const queued = new Map<Subscriber, RenderJob>()
const subscribers = new Set<Subscriber>()
const idleWaiters = new Set<() => void>()

export function setMarkdownWorkerFactory(next: (() => Worker) | null): void {
  worker?.terminate()
  worker = null
  workerGeneration++
  pendingRetirements.clear()
  if (inFlight?.subscriber.active && !queued.has(inFlight.subscriber)) queued.set(inFlight.subscriber, { ...inFlight, id: ++sequence })
  inFlight = null
  factory = next
  failed = false
  pump()
}

export function markdownWorkerStats() {
  return { submitted, completed, inFlight: inFlight ? 1 : 0, queued: queued.size, retirementPending: pendingRetirements.size, failed, prefixes: workerPrefixStats }
}

function notifyIdle() {
  if (inFlight || queued.size || pendingRetirements.size) return
  for (const resolve of idleWaiters) resolve()
  idleWaiters.clear()
}

export function waitForMarkdownWorkerIdle(): Promise<void> {
  if (!inFlight && !queued.size && !pendingRetirements.size) return Promise.resolve()
  return new Promise(resolve => { idleWaiters.add(resolve) })
}

function fallback(job: RenderJob) {
  if (job.subscriber.active && job.subscriber.latestSource === job.source) {
    job.subscriber.receive(job.source, renderMarkdownHtml(job.source, job.subscriber.sessionId))
  }
}

function ensureWorker(): Worker | null {
  if (worker || failed) return worker
  try {
    const generation = workerGeneration
    worker = factory?.() ?? new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' })
    const icons = Object.fromEntries(['note.md', 'config.json', 'run.sh', 'app.ts', 'file.bin'].map(path => {
      const name = path.endsWith('.md') ? 'chat-file' : path.endsWith('.json') ? 'chat-file-2'
        : path.endsWith('.sh') ? 'chat-file-3' : path.endsWith('.ts') ? 'chat-file-code' : 'chat-file-plain'
      return [name, fileIconSvg(path)]
    }))
    worker.postMessage({ type: 'initialize', icons })
    worker.onmessage = ({ data }) => {
      if (generation !== workerGeneration) return
      if (data.type === 'retired') {
        if (!pendingRetirements.delete(data.retirementId)) return
        workerPrefixStats = data.stats
        notifyIdle()
        return
      }
      const job = inFlight
      if (!job || data.id !== job.id) return
      inFlight = null
      completed++
      workerPrefixStats = data.stats ?? workerPrefixStats
      if (data.error) fallback(job)
      else if (job.subscriber.active && job.subscriber.latestSource.startsWith(job.source)) {
        if (job.settled) primeMarkdownHtml(job.source, job.subscriber.sessionId, data.html)
        job.subscriber.receive(job.source, data.html)
      }
      pump()
    }
    worker.onerror = () => {
      if (generation !== workerGeneration) return
      worker?.terminate(); worker = null; failed = true
      workerGeneration++
      pendingRetirements.clear()
      const current = inFlight
      inFlight = null
      if (current) fallback(current)
      for (const job of queued.values()) fallback(job)
      queued.clear()
      notifyIdle()
    }
    return worker
  } catch { failed = true; pendingRetirements.clear(); return null }
}

function pump() {
  if (inFlight) return
  const first = queued.entries().next().value as [Subscriber, RenderJob] | undefined
  if (!first) { notifyIdle(); return }
  const [subscriber, job] = first
  queued.delete(subscriber)
  if (!subscriber.active) { pump(); return }
  const target = ensureWorker()
  if (!target) { fallback(job); pump(); return }
  inFlight = job
  submitted++
  try { target.postMessage({ id: job.id, source: job.source, sessionId: subscriber.sessionId, streamId: subscriber.streamId, settled: job.settled }) }
  catch { target.onerror?.(new Event('error') as ErrorEvent) }
}

export function retireMarkdownRuntime(sessionId: string): void {
  forgetMarkdownSession(sessionId)
  for (const subscriber of subscribers) if (subscriber.sessionId === sessionId) {
    subscriber.active = false
    subscriber.cancel?.()
    queued.delete(subscriber)
    subscribers.delete(subscriber)
  }
  if (worker) {
    const retirementId = ++sequence
    pendingRetirements.add(retirementId)
    try { worker.postMessage({ type: 'retire', sessionId, retirementId }) }
    catch { worker.onerror?.(new Event('error') as ErrorEvent) }
  }
  notifyIdle()
}

/** A cancellable one-shot render also supports prewarming a settled history row. */
export function requestMarkdownHtml(source: string, sessionId: string, streamId: string, settled = true) {
  let resolve!: (html: string | null) => void
  const result = new Promise<string | null>(complete => { resolve = complete })
  const dispose = () => {
    subscriber.active = false
    subscribers.delete(subscriber)
    queued.delete(subscriber)
    notifyIdle()
  }
  const subscriber: Subscriber = {
    active: true, latestSource: source, sessionId, streamId,
    receive: (_source, html) => { dispose(); resolve(html) },
    cancel: () => { dispose(); resolve(null) },
  }
  subscribers.add(subscriber)
  queued.set(subscriber, { id: ++sequence, source, settled, subscriber })
  pump()
  return { result, cancel: subscriber.cancel! }
}

/** Expensive parsing and highlighting run outside the renderer's input thread. */
export function useAsyncMarkdownHtml(source: string, sessionId: string, streamId: string, streaming: boolean): string {
  const identity = useId()
  const [result, setResult] = useState({ source: '', html: '', sessionId: '', streamId: '' })
  const available = typeof document !== 'undefined' && (factory !== null || typeof Worker !== 'undefined') && !failed
  const asynchronous = available && (streaming || source.length > 4096 || source.includes('```'))
  const cached = !streaming ? cachedMarkdownHtml(source, sessionId) : undefined
  const subscriber = useMemo<Subscriber>(() => ({
    active: true, latestSource: source, sessionId, streamId: streamId || identity,
    receive: (text, html) => setResult({ source: text, html, sessionId, streamId }),
  }), [sessionId, streamId, identity])
  // The first source has no previous worker frame. Render its structure once,
  // without synchronous highlighting, instead of flashing raw Markdown syntax.
  const hasVisibleSource = !!source.trim()
  const firstPaint = useMemo(() => ({ source, html: asynchronous && cached === undefined ? renderMarkdownPreview(source, sessionId) : '' }), [subscriber, asynchronous, hasVisibleSource, cached !== undefined])
  subscriber.latestSource = source
  useEffect(() => {
    subscriber.active = true
    subscribers.add(subscriber)
    return () => { subscriber.active = false; subscribers.delete(subscriber); queued.delete(subscriber); notifyIdle() }
  }, [subscriber])
  useEffect(() => {
    if (!asynchronous || !subscriber.active || cached !== undefined) return
    queued.set(subscriber, { id: ++sequence, source, settled: !streaming, subscriber })
    pump()
  }, [source, streaming, asynchronous, subscriber, cached])
  if (cached !== undefined) return cached
  if (!asynchronous) return renderMarkdownHtml(source, sessionId)
  if (result.sessionId === sessionId && result.streamId === streamId && result.source && source.startsWith(result.source)) return result.html
  if (source.startsWith(firstPaint.source)) return firstPaint.html
  return renderMarkdownPreview(source, sessionId)
}
