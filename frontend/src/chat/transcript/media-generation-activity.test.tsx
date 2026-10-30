import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../../contracts/vectors/media-generation-activity.json'
import type { ActivityToolData, ActivityToolState } from './activity-tool-model'
import { mediaGenerationKind } from './media-generation-activity'

;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {}, currentLang: 'en' }

const { ActivityToolContent, activityToolIconName, activityToolPresentation, activityToolSummary } = await import('./activity-tool')
const { ActivityHeader, HistoryToolCards, LiveToolCard, activitySummaryLabel, chatGroupIcon } = await import('./TranscriptView')
const { describeActivity, summarizeActivity } = await import('./activity-model')
const { isDynamicActivityTool, isExplicitMediaGenerationTool } = await import('./chat-activity')
const { icon } = await import('../../icons/registry')
const { I18N } = await import('../../i18n')

const tool = (toolName: string, state: ActivityToolState = 'done'): ActivityToolData => ({
  toolCallId: 'generation-call', toolName, state, args: { prompt: 'A quiet garden' }, output: 'Generation result details',
})
const glyph = (html: string) => /<svg[\s\S]*?<\/svg>/.exec(html)?.[0]

describe('media generation event contract', () => {
  for (const vector of vectors.tools) {
    test(`${vector.name} has a dedicated type and localized lifecycle on every surface`, () => {
      for (const name of [vector.name, ...vector.aliases]) {
        expect(mediaGenerationKind(name)).toBe(vector.kind)
        expect(activityToolPresentation(tool(name))).toMatchObject({ kind: 'generation', generationKind: vector.kind })
        expect(activityToolIconName(name)).toBe(vector.icon)
        expect(isDynamicActivityTool(name)).toBe(false)
      }
      const previous = (window as any).currentLang
      try {
        for (const locale of ['en', 'zh'] as const) {
          ;(window as any).currentLang = locale
          const t = (key: string) => I18N[locale][key] || key
          for (const [state, label] of Object.entries(vector.labels[locale])) {
            const value = tool(vector.name, state as ActivityToolState)
            const action = describeActivity(value.toolName, value.args, state)
            const summary = summarizeActivity([{ key: value.toolCallId, value, grouping: 'tool', action }])
            const active = { mode: 'active' as const, activeAction: action, summary }
            const completed = { mode: 'summary' as const, summary }
            expect(activityToolSummary(activityToolPresentation(value), value.state, false, locale)).toBe(label)
            expect(activitySummaryLabel(t, active)).toBe(label)
            expect(activitySummaryLabel(t, completed)).toBe(label)
            const row = renderToStaticMarkup(<ActivityToolContent tool={value} open={false} onToggle={() => {}} locale={locale} />)
            expect(row).toContain(label)
            expect(row).toContain('data-tool-kind="generation"')
            expect(row).toContain('aria-expanded="false"')
            expect(row).not.toContain(vector.name)
            expect(row).not.toContain(value.output!)
            expect(glyph(row)).toBe(icon(vector.icon, { size: 16 }))
            expect(glyph(renderToStaticMarkup(<ActivityHeader node={active} />))).toBe(glyph(row))
            expect(glyph(renderToStaticMarkup(chatGroupIcon(completed)))).toBe(icon(vector.icon))
            const expanded = renderToStaticMarkup(<ActivityToolContent tool={value} open onToggle={() => {}} locale={locale} />)
            expect(expanded).toContain('A quiet garden')
            expect(expanded).toContain(value.output!)
            expect(expanded).toContain('aria-expanded="true"')
            if (state === 'error') expect(row).toContain(`aria-label="${locale === 'zh' ? '失败' : 'Failed'}"`)

            const live = renderToStaticMarkup(<LiveToolCard card={{ toolCallId: value.toolCallId, toolName: value.toolName,
              args: value.args, argsDelta: '', progress: [], agent: false, bgTask: false, content: value.output,
              status: value.state === 'done' ? 'ok' : value.state }} open={false} onToggle={() => {}} />)
            const history = renderToStaticMarkup(<HistoryToolCards tools={[{ ...value, agent: false, activityKind: null, output: { text: value.output!, isError: state === 'error', media: [] } }]} />)
            expect(live).toContain(label)
            expect(history).toContain(label)
          }
        }
      } finally { (window as any).currentLang = previous }
    })
  }

  test('keeps unrelated tool identities and media delivery rules separate', () => {
    for (const name of vectors.unrelatedTools) {
      expect(mediaGenerationKind(name)).toBeNull()
      expect(activityToolPresentation(tool(name)).kind).not.toBe('generation')
    }
    expect(isExplicitMediaGenerationTool('generate_image')).toBe(true)
    expect(isExplicitMediaGenerationTool('generate_video')).toBe(true)
    expect(isExplicitMediaGenerationTool('generate_audio')).toBe(false)
    expect(isExplicitMediaGenerationTool('generate_music')).toBe(false)
    expect(activityToolIconName('generate_audio')).not.toBe(activityToolIconName('generate_music'))
  })

  test('a repeated generation failure is not summarized as success', () => {
    const previous = (window as any).currentLang
    ;(window as any).currentLang = 'en'
    try {
      const entries = ['done', 'error'].map((state, index) => ({ key: String(index), value: null, grouping: 'tool' as const,
        action: describeActivity('generate_music', {}, state) }))
      const summary = summarizeActivity(entries)
      expect(summary.allTools).toHaveLength(2)
      expect(summary.tools).toEqual([{ name: 'generate_music', count: 2 }])
      expect(activitySummaryLabel(key => I18N.en[key] || key, { mode: 'summary', summary })).toBe('Failed to generate music')
    } finally { (window as any).currentLang = previous }
  })
})
