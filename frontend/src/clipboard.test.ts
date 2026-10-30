import { describe, expect, test } from 'bun:test'
import { readClipboardText, writeClipboardText } from './clipboard'

describe('desktop clipboard bridge', () => {
  test('uses the host clipboard for exact message text before browser APIs', async () => {
    const writes: string[] = []
    const environment = {
      host: {
        readText: async () => '原样\ntext',
        writeText: async (text: string) => { writes.push(text) },
      },
      browser: {
        readText: async () => { throw new Error('browser clipboard must not run') },
        writeText: async () => { throw new Error('browser clipboard must not run') },
      },
    }

    await writeClipboardText('复制 `code` 😀', environment)
    expect(writes).toEqual(['复制 `code` 😀'])
    expect(await readClipboardText(environment)).toBe('原样\ntext')
  })

  test('surfaces a rejected host write instead of reporting a false success', async () => {
    const environment = { host: { writeText: async () => { throw new Error('clipboard denied') } } }
    let failure: unknown
    try { await writeClipboardText('text', environment) } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe('clipboard denied')
  })
})
