import { describe, expect, test } from 'bun:test'
import { assertSelfHostedFontAssets } from '../../../scripts/frontend-font-assets.mjs'

function fixture(css: string, font: string | Uint8Array = new Uint8Array([119, 79, 70, 50])) {
  return {
    'assets/styles.css': { type: 'asset', fileName: 'assets/styles.css', source: css },
    'assets/font.woff2': { type: 'asset', fileName: 'assets/font.woff2', source: font },
  }
}

describe('built font resources', () => {
  test('relative and root paths resolve to emitted files while local font names remain valid', () => {
    const bundle = fixture(`@font-face { font-family: Fixture; src: local('Fixture'), url("/assets/font.woff2") format('woff2'); }
      @font-face { font-family: Fixture2; src: url(font.woff2?v=1#font) format('woff2'); }`)
    expect(assertSelfHostedFontAssets(bundle)).toEqual({ stylesheets: 1, fonts: 1 })
  })

  test('inline fonts fail even when a same-origin fallback is also present', () => {
    const bundle = fixture(`@font-face{font-family:Fixture;src:url(data:font/woff2;base64,d09GMg==) format('woff2'),url(/assets/font.woff2)}`)
    expect(() => assertSelfHostedFontAssets(bundle)).toThrow("font URL violates font-src 'self'")
  })

  test('remote blob and protocol-relative fonts cannot bypass the source policy', () => {
    for (const url of ['https://example.invalid/font.woff2', '//example.invalid/font.woff2', 'blob:fixture']) {
      expect(() => assertSelfHostedFontAssets(fixture(`@font-face{src:url('${url}')}`))).toThrow("font URL violates font-src 'self'")
    }
  })

  test('missing and empty font outputs fail the build check', () => {
    expect(() => assertSelfHostedFontAssets(fixture('@font-face{src:url(missing.woff2)}'))).toThrow('missing or empty')
    expect(() => assertSelfHostedFontAssets(fixture('@font-face{src:url(font.woff2)}', ''))).toThrow('missing or empty')
  })

  test('image data URLs are unaffected by the font-only policy', () => {
    const bundle = fixture('.icon{background:url(data:image/svg+xml;base64,fixture)}')
    expect(assertSelfHostedFontAssets(bundle)).toEqual({ stylesheets: 1, fonts: 0 })
  })
})
