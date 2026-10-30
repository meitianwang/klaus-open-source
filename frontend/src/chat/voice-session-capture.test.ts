import { expect, test } from 'bun:test'
import { VoiceSessionCapture } from './voice-session-capture'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }

function fixture(replies: { audio?: unknown; stop?: unknown } = {}) {
  const opening = deferred<{ ok: boolean; sessionId: string }>()
  const sent: Array<{ id: string; seq: number; data: number[] }> = []
  const stopped: string[] = [], cancelled: string[] = [], errors: string[] = []
  const opened: Array<{ chatSessionId?: string }> = []
  let send!: (data: ArrayBuffer, seq: number) => Promise<void>
  let started = 0, closed = 0
  const capture = new VoiceSessionCapture({} as MediaStream, {
    operationId: 'capture', source: 'antigravity', context: '', chatSessionId: 'dictating-chat', failed: error => errors.push(error.message),
    transport: {
      sessionStart: options => { opened.push(options); return opening.promise },
      sessionAudio: async (id, data, seq) => { sent.push({ id, seq, data: [...new Uint8Array(data)] }); return (Object.hasOwn(replies, 'audio') ? replies.audio : { ok: true }) as { ok?: boolean } | null },
      sessionStop: async id => { stopped.push(id); return (Object.hasOwn(replies, 'stop') ? replies.stop : { ok: true }) as { ok?: boolean } | null },
      sessionCancel: async id => { cancelled.push(id); return { ok: true } },
    },
    pcm: (_stream, callback) => {
      send = callback
      return { start: async () => { started++ }, stop: async () => {}, close: async () => { closed++ } }
    },
  })
  return { capture, opening, opened, sent, stopped, cancelled, errors, send: (data: number[], seq: number) => send(Uint8Array.from(data).buffer, seq), started: () => started, closed: () => closed }
}

test('microphone capture begins while the remote session is still connecting, without losing its first frames', async () => {
  const row = fixture()
  await row.capture.start()
  expect(row.opened[0]?.chatSessionId).toBe('dictating-chat')
  expect(row.started()).toBe(1)
  await row.send([1, 0], 1); await row.send([2, 0], 2)
  expect(row.sent).toHaveLength(0)
  row.opening.resolve({ ok: true, sessionId: 'remote-capture' }); await tick()
  await row.send([3, 0], 3); await tick()
  expect(row.sent).toEqual([
    { id: 'remote-capture', seq: 1, data: [1, 0] }, { id: 'remote-capture', seq: 2, data: [2, 0] }, { id: 'remote-capture', seq: 3, data: [3, 0] },
  ])
  await row.capture.stop()
  expect(row.stopped).toEqual(['remote-capture']); expect(row.errors).toEqual([])
})

test('release during connection waits for buffered frames to drain before ending the remote session', async () => {
  const row = fixture(); await row.capture.start(); await row.send([1, 0], 1)
  const stopping = row.capture.stop(); await tick()
  expect(row.stopped).toEqual([])
  row.opening.resolve({ ok: true, sessionId: 'remote-capture' }); await stopping
  expect(row.sent).toHaveLength(1); expect(row.stopped).toEqual(['remote-capture'])
})

test('cancelled capture discards pending local frames and cancels a late remote identity', async () => {
  const row = fixture(); await row.capture.start(); await row.send([1, 0], 1)
  await row.capture.close(); row.opening.resolve({ ok: true, sessionId: 'late-remote' }); await tick()
  expect(row.closed()).toBe(1); expect(row.sent).toEqual([]); expect(row.cancelled).toEqual(['late-remote'])
})

test('an input sequence gap fails explicitly rather than silently reordering microphone audio', async () => {
  const row = fixture(); await row.capture.start()
  let error = ''
  try { await row.send([1, 0], 2) } catch (value) { error = (value as Error).message }
  expect(error).toBe('speech-audio-sequence')
  await row.capture.close(); row.opening.resolve({ ok: true, sessionId: 'capture' }); await tick()
  expect(row.sent).toEqual([])
})

for (const reply of [null, {}, { ok: false }]) {
  test(`missing or rejected audio acknowledgment terminates capture: ${JSON.stringify(reply)}`, async () => {
    const row = fixture({ audio: reply })
    await row.capture.start()
    row.opening.resolve({ ok: true, sessionId: 'capture' }); await tick()
    await row.send([1, 0], 1); await tick()
    expect(row.errors).toEqual(['speech-audio-failed'])
    expect(row.closed()).toBe(1)
    await row.capture.stop()
    expect(row.stopped).toEqual([])
  })

  test(`missing or rejected end acknowledgment fails completion: ${JSON.stringify(reply)}`, async () => {
    const row = fixture({ stop: reply })
    await row.capture.start()
    row.opening.resolve({ ok: true, sessionId: 'capture' }); await tick()
    await row.send([1, 0], 1); await tick()
    let code = ''
    try { await row.capture.stop() } catch (error) { code = (error as Error).message }
    expect(code).toBe('speech-stop-failed')
    await row.capture.close()
  })
}
