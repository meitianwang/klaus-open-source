import { afterEach, describe, expect, test } from 'bun:test'
import { markdownWorkerStats, requestMarkdownHtml, retireMarkdownRuntime, setMarkdownWorkerFactory, waitForMarkdownWorkerIdle } from './markdown-async'

class FakeWorker {
  messages: any[] = []
  onmessage: ((event: any) => void) | null = null
  onerror: ((event: any) => void) | null = null
  terminated = false
  postMessage(message: unknown) { this.messages.push(message) }
  terminate() { this.terminated = true }
  renderReply() {
    const job = this.messages.findLast(message => typeof message.id === 'number')
    this.onmessage?.({ data: { id: job.id, html: `<p>${job.source}</p>\n`, stats: { entries: 0 } } })
  }
}

afterEach(() => setMarkdownWorkerFactory(null))

describe('Markdown worker lifecycle', () => {
  test('requeues a live request when its worker factory changes and ignores the retired worker reply', async () => {
    const first = new FakeWorker()
    setMarkdownWorkerFactory(() => first as unknown as Worker)
    const request = requestMarkdownHtml('first', 'worker-generation', 'message')
    const second = new FakeWorker()
    setMarkdownWorkerFactory(() => second as unknown as Worker)
    expect(first.terminated).toBe(true)
    first.renderReply()
    expect(markdownWorkerStats().inFlight).toBe(1)
    second.renderReply()
    expect(await request.result).toBe('<p>first</p>\n')
    await waitForMarkdownWorkerIdle()
    expect(markdownWorkerStats().inFlight).toBe(0)
  })

  test('waits for retirement acknowledgements after a render completes', async () => {
    const worker = new FakeWorker()
    setMarkdownWorkerFactory(() => worker as unknown as Worker)
    const request = requestMarkdownHtml('old', 'worker-retirement', 'message')
    retireMarkdownRuntime('worker-retirement')
    expect(await request.result).toBeNull()
    let idle = false
    const waiting = waitForMarkdownWorkerIdle().then(() => { idle = true })
    worker.renderReply()
    await Promise.resolve()
    expect(idle).toBe(false)
    expect(markdownWorkerStats().retirementPending).toBe(1)
    const retirementId = worker.messages.findLast(message => message.type === 'retire').retirementId
    worker.onmessage?.({ data: { type: 'retired', retirementId: retirementId + 1, stats: { entries: 0 } } })
    expect(markdownWorkerStats().retirementPending).toBe(1)
    worker.onmessage?.({ data: { type: 'retired', retirementId, stats: { entries: 0 } } })
    await waiting
    expect(idle).toBe(true)
  })

  test('a failed worker settles retirement waiters and pending work', async () => {
    const worker = new FakeWorker()
    setMarkdownWorkerFactory(() => worker as unknown as Worker)
    const request = requestMarkdownHtml('cancelled', 'worker-error', 'message')
    retireMarkdownRuntime('worker-error')
    const idle = waitForMarkdownWorkerIdle()
    worker.onerror?.({})
    await idle
    expect(await request.result).toBeNull()
    expect(markdownWorkerStats().failed).toBe(true)
    expect(markdownWorkerStats().retirementPending).toBe(0)
  })
})
