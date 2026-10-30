import { registerCustomTheme } from '@pierre/diffs'

registerCustomTheme('klaus-review-light', async () => {
  const { default: base } = await import('@shikijs/themes/github-light')
  return {
    ...base, name: 'klaus-review-light', tokenColors: [
      ...(base.tokenColors ?? []),
      { scope: ['string.quoted.double.json', 'string.quoted.single.json'], settings: { foreground: '#008800' } },
      { scope: ['support.type.property-name.json'], settings: { foreground: '#f44343' } },
    ],
  }
})
