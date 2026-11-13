import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startComposerLifecycleProvider } from './composer-lifecycle-provider'

test('a held provider exposes first-token and completion barriers independently without duplicating text', { timeout: 5000 }, async () => {
  const provider = await startComposerLifecycleProvider({ responseText: 'PHASED_PROVIDER_TEXT' })
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    provider.holdNext(true)
    const response = await fetch(provider.url + '/v1/messages', { method: 'POST', body: JSON.stringify({
      stream: true, model: 'fixture', tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: 'Input' }],
    }) })
    reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let output = ''
    async function readUntil(predicate: () => boolean) {
      while (!predicate()) {
        const chunk = await reader!.read()
        if (chunk.done) break
        output += decoder.decode(chunk.value, { stream: true })
      }
    }
    await readUntil(() => output.includes('content_block_start'))
    assert.equal(provider.entered(), 1)
    assert(!output.includes('PHASED_PROVIDER_TEXT'))
    assert(!output.includes('message_stop'))
    provider.streamHeldText()
    provider.streamHeldText()
    await readUntil(() => output.includes('PHASED_PROVIDER_TEXT'))
    assert(!output.includes('message_stop'))
    provider.release()
    await readUntil(() => output.includes('message_stop'))
    assert.equal(output.match(/PHASED_PROVIDER_TEXT/g)?.length, 1)
    assert(output.includes('message_stop'))
  } finally {
    provider.release()
    await reader?.cancel()
    await provider.close()
  }
})
