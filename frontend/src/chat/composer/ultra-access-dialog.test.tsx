import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18N } from '../../i18n/messages'
import { UltraAccessDialog } from './ultra-access-dialog'

test('Ultra confirmation uses the shared dialog style and distinct permission actions', () => {
  for (const language of ['en', 'zh'] as const) {
    const translate = (key: string) => I18N[language][key] || key
    const html = renderToStaticMarkup(createElement(UltraAccessDialog, { translate, onDecision: () => {} }))
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby=')
    expect(html).toContain('aria-describedby=')
    expect(html).toContain(translate('ultra_full_access_title'))
    expect(html).toContain(translate('ultra_full_access_use'))
    expect(html).toContain(translate('ultra_full_access_continue'))
    expect(html).toContain('klaus-dialog-danger')
    expect(html).toContain('<svg')
    expect(html).not.toContain('title=')
  }
})
