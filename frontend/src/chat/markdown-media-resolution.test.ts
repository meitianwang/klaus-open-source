import { describe, expect, test } from 'bun:test'
import { collectImageSourceAliases, resolveRelativeImagePaths } from './markdown'

const pooled = '/profile/media/0123456789abcdef.png'
const source = '/workspace/project/dist/checks/electron-static-orb.png'
const aliases = collectImageSourceAliases([{ path: pooled, sourcePath: source }])

describe('reply image recovery', () => {
  test('an absolute reply path with the wrong parent uses the unique confirmed image copy', () => {
    const wrong = '/workspace/dist/checks/electron-static-orb.png'
    expect(resolveRelativeImagePaths(`![Static avatars](${wrong})`, new Set([pooled]), aliases))
      .toBe(`![Static avatars](${pooled})`)
  })

  test('an exact source alias and a bare filename resolve to the same immutable copy', () => {
    for (const reference of [source, 'electron-static-orb.png']) {
      expect(resolveRelativeImagePaths(`![Result](${reference})`, new Set([pooled]), aliases))
        .toBe(`![Result](${pooled})`)
    }
  })

  test('an ambiguous basename never rewrites either a relative or absolute reference', () => {
    const otherPool = '/profile/media/fedcba9876543210.png'
    const otherSource = '/another/result/electron-static-orb.png'
    const ambiguous = collectImageSourceAliases([
      { path: pooled, sourcePath: source },
      { path: otherPool, sourcePath: otherSource },
    ])
    for (const reference of ['electron-static-orb.png', '/missing/electron-static-orb.png']) {
      const text = `![Result](${reference})`
      expect(resolveRelativeImagePaths(text, new Set([pooled, otherPool]), ambiguous)).toBe(text)
    }
  })

  test('unrelated absolute paths and remote images remain untouched', () => {
    for (const reference of ['/missing/unrelated.png', 'https://example.com/result.png']) {
      const text = `![Result](${reference})`
      expect(resolveRelativeImagePaths(text, new Set([pooled]), aliases)).toBe(text)
    }
  })
})
