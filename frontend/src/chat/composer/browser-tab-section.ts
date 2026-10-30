import type { MentionSection } from './mention-sections'
import { projectBrowserTabRows, type BrowserTabsResult, type Translate } from './mention-queries'

const browserTabErrorKeys: Readonly<Record<string, string>> = {
  browser_disabled: 'mention_browser_disabled',
  external_browser_disabled: 'mention_external_browser_disabled',
  browser_unavailable: 'mention_browser_unavailable',
  external_browser_unavailable: 'mention_external_browser_unavailable',
}

function browserTabErrorDetail(error: { code?: string; message: string }, t: Translate): string {
  const key = error.code ? browserTabErrorKeys[error.code] : undefined
  if (!key) return error.message
  return error.code === 'external_browser_unavailable' && error.message
    ? `${t(key)}\n${error.message}` : t(key)
}

/** Partial browser failures remain visible without hiding the healthy candidates. */
export function browserTabMentionSection(result: {
  data?: BrowserTabsResult; error?: unknown; isError: boolean; isFetching: boolean; refetch: () => unknown,
}, t: Translate = key => key): MentionSection {
  const rows = projectBrowserTabRows(result.data?.tabs ?? [])
  const errors = result.data?.errors ?? []
  return {
    key: 'browser-tabs', labelKey: 'mention_group_browser_tabs', rows,
    ...(result.isError || errors.length ? {
      state: { kind: 'error' as const, labelKey: 'mention_group_browser_tabs_error',
        detail: errors.length ? errors.map(error => browserTabErrorDetail(error, t)).join('\n')
          : result.error instanceof Error ? result.error.message === 'browser_tab_mentions_unavailable'
            ? t('mention_browser_unavailable') : result.error.message : '',
        retry: () => { void result.refetch() },
      },
    } : !rows.length && result.isFetching ? {
      state: { kind: 'loading' as const, labelKey: 'mention_group_browser_tabs_loading' },
    } : {}),
  }
}
