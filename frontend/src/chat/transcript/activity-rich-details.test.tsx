import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import events from '../../../../contracts/vectors/tool-activity-events.json'
import images from '../../../../contracts/vectors/image-view-events.json'
import type { ActivityToolData, ActivityToolState } from './activity-tool-model'
import { activitySchedules, activityScheduleCron, activityScheduleIsEmpty } from './activity-schedule'
import { semanticActivity, webActivitySources } from './activity-semantic'

;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {}, currentLang: 'en',
  klaus: { media: { url: (path: string, session: string) => `klaus-media://fixture/${encodeURIComponent(path)}?s=${session}` } } }

const { ActivityToolContent, activityToolPresentation, activityToolIconName } = await import('./activity-tool')
const { ActivityHeader, activitySummaryLabel, LiveToolCard, HistoryToolCards } = await import('./TranscriptView')
const { describeActivity, summarizeActivity } = await import('./activity-model')
const { I18N } = await import('../../i18n')
const value = (toolName: string, args: unknown, state: ActivityToolState = 'done'): ActivityToolData => ({
  toolName, args, state, toolCallId: 'rich-event', sessionId: 'owner', output: 'RESULT_DETAILS',
})

describe('semantic activity contract', () => {
  for (const vector of events.cases) test(`${vector.toolName} preserves state, identity, and outcomes`, () => {
    for (const [state, labels] of Object.entries(vector.labels)) {
      for (const [index, locale] of ['en', 'zh'].entries()) {
        ;(window as any).currentLang = locale
        const tool = value(vector.toolName, vector.args, state as ActivityToolState)
        const action = describeActivity(tool.toolName, tool.args, state)
        const summary = summarizeActivity([{ key: 'one', value: tool, grouping: 'tool', action }])
        const t = (key: string) => I18N[locale as 'en' | 'zh'][key] || key
        const html = renderToStaticMarkup(<ActivityToolContent tool={tool} open onToggle={() => {}} locale={locale} />)
        expect(html).toContain(labels![index])
        expect(html).toContain('aria-expanded="true"')
        // A friend card is self-contained: recipient, sent text and one status
        // line carry the outcome, so its raw result renders in neither state.
        const friendCard = semanticActivity(tool.toolName, tool.args)?.category === 'friend'
        if (friendCard) {
          expect(html).toContain('data-friend-result')
          // A failed call still prints its failure reason verbatim; every other
          // state keeps the raw result out of the card.
          if (state !== 'error' && state !== 'interrupted') expect(html).not.toContain('RESULT_DETAILS')
        } else expect(html).toContain('RESULT_DETAILS')
        expect(activityToolIconName(tool.toolName, tool.args)).toBe(vector.icon)
        expect(activitySummaryLabel(t, { mode: 'active', activeAction: action, summary })).toBe(labels![index])
        expect(activitySummaryLabel(t, { mode: 'summary', summary })).toBe(labels![index])
        expect(renderToStaticMarkup(<ActivityHeader node={{ mode: 'active', activeAction: action, summary }} />)).toContain(labels![index])
        const collapsed = renderToStaticMarkup(<ActivityToolContent tool={tool} open={false} onToggle={() => {}} locale={locale} />)
        expect(collapsed).not.toContain('RESULT_DETAILS')
        expect(collapsed).not.toContain('PRIVATE_TYPED_VALUE')
        expect(collapsed).not.toContain('token=secret')
      }
    }
  })

  test('unknown host calls expose failures and details while unrelated MCP sources retain identity', () => {
    const unknown = renderToStaticMarkup(<ActivityToolContent tool={value('custom_probe', { nested: 'INPUT_DETAILS' }, 'error')} open onToggle={() => {}} locale="zh" />)
    expect(unknown).toContain('工具调用失败')
    expect(unknown).toContain('INPUT_DETAILS')
    expect(unknown).toContain('RESULT_DETAILS')
    expect(semanticActivity('mcp__other__prototype_open')).toBeNull()
    const mcp = renderToStaticMarkup(<ActivityToolContent tool={value('mcp__calendar__lookup', {})} open onToggle={() => {}} locale="en" />)
    expect(mcp).toContain('Calendar · Lookup')
    expect(mcp).toContain('mcp__calendar__lookup')
    for (const name of ['constructor', '__proto__', 'toString']) expect(semanticActivity(name)).toBeNull()
  })

  test('tab actions retain their actual operation in rows and mixed summaries', () => {
    ;(window as any).currentLang = 'en'
    expect(semanticActivity('browser_tabs', { action: 'get' })?.action).toBe('browser_tabs')
    expect(semanticActivity('browser_tabs', { action: 'selected' })?.action).toBe('browser_tabs')
    expect(semanticActivity('browser_tabs', { action: 'select' })?.action).toBe('browser_select_tab')
    expect(semanticActivity('browser_tabs', { action: 'finalize' })?.action).toBe('browser_close')
    const calls = ['new', 'close'].map((action, index) => {
      const tool = { ...value('browser_tabs', { action }), toolCallId: String(index) }
      return { key: String(index), value: tool, grouping: 'tool' as const, action: describeActivity(tool.toolName, tool.args, tool.state) }
    })
    const summary = summarizeActivity(calls)
    const label = activitySummaryLabel((key: string) => I18N.en[key] || key, { mode: 'summary', summary })
    expect(label).toContain('Opened browser tab')
    expect(label).toContain('closed browser tab')
  })

  test('web source extraction supports native, host and structured results without unsafe links', () => {
    expect(webActivitySources(events.sources.native)).toEqual([{ title: 'Example documentation', url: 'https://example.com/docs' }])
    expect(webActivitySources(events.sources.host)).toEqual([{ title: 'Example guide', url: 'https://example.com/guide' }])
    expect(webActivitySources(events.sources.unsafe)).toEqual([])
    expect(webActivitySources(JSON.stringify({ results: [{ title: 'Result', url: 'https://example.com' }] }))).toEqual([{ title: 'Result', url: 'https://example.com/' }])
    const tool = { ...value('web_search', { query: 'example' }), output: events.sources.native }
    const html = renderToStaticMarkup(<ActivityToolContent tool={tool} open onToggle={() => {}} locale="en" />)
    expect(html).toContain('data-web-sources')
    expect(html).toContain('Example documentation')
    expect(html).toContain('data-source-url="https://example.com/docs"')
  })

  test('schedule results retain snapshot names, localizable cadence, recurrence, and a management action', () => {
    ;(window as any).currentLang = 'zh'
    const tool = { ...value('CronCreate', events.cases.find(item => item.toolName === 'CronCreate')!.args), output: events.schedule.host }
    expect(activitySchedules(tool.toolName, tool.args, tool.output)[0]).toMatchObject({ id: 'cron-a-b', name: 'Morning review', recurring: true, durable: true })
    const html = renderToStaticMarkup(<ActivityToolContent tool={tool} open onToggle={() => {}} locale="zh" />)
    for (const expected of ['Morning review', '09:00', '重复执行', '管理定时任务', '已保存']) expect(html).toContain(expected)
    expect(activitySchedules('CronList', {}, events.schedule.list)[0]).toMatchObject({ id: 'cron-a-b', humanSchedule: 'Every day at 9:00 AM' })
    expect(activityScheduleCron('Every day at 9:00 AM')).toBe('0 9 * * *')
    expect(activityScheduleCron('Unknown schedule')).toBeUndefined()
    const failed = renderToStaticMarkup(<ActivityToolContent tool={{ ...tool, state: 'error' }} open onToggle={() => {}} locale="zh" />)
    expect(failed).not.toContain('data-schedule-result')
    const native = activitySchedules('CronList', {}, JSON.stringify({ jobs: [{ id: 'native-1', prompt: 'Once', cron: '0 9 * * *' }] }))[0]
    expect(native).toMatchObject({ recurring: false, durable: true })
  })

  test('schedule replay parses native text and localizes raw schedules without false empty states', () => {
    const nativeCreate = 'Scheduled recurring job 1a2b3c4d (Every 5 minutes). Session-only (not written to disk, dies when the session ends).'
    expect(activitySchedules('CronCreate', { prompt: 'Check build' }, nativeCreate)[0]).toMatchObject({ id: '1a2b3c4d', humanSchedule: 'Every 5 minutes', recurring: true, durable: false })
    const list = 'aaaaaaaa — Every 5 minutes (recurring): watch the build\nbbbbbbbb — 30 14 28 2 * (one-shot) [session-only]: 没有错误时提醒我'
    expect(activitySchedules('CronList', {}, list)).toEqual([
      { id: 'aaaaaaaa', name: 'watch the build', humanSchedule: 'Every 5 minutes', recurring: true, durable: true },
      { id: 'bbbbbbbb', name: '没有错误时提醒我', humanSchedule: '30 14 28 2 *', recurring: false, durable: false },
    ])
    expect(activityScheduleIsEmpty(list)).toBe(false)
    expect(activityScheduleIsEmpty('No scheduled jobs.')).toBe(true)
    expect(activityScheduleIsEmpty('当前没有已排程的定时任务。')).toBe(true)
    expect(activityScheduleIsEmpty(JSON.stringify({ jobs: [] }))).toBe(true)
    expect(activityScheduleCron('0 9 15 * *')).toBe('0 9 15 * *')
    ;(window as any).currentLang = 'zh'
    const html = renderToStaticMarkup(<ActivityToolContent tool={{ ...value('CronList', {}), output: 'cron-a-b — 0 9 15 * *（循环）：Monthly review' }} open onToggle={() => {}} locale="zh" />)
    expect(html).toContain('每月 · 15 · 09:00')
  })
})

describe('image inspection disclosure contract', () => {
  for (const vector of images.cases) test(vector.name, () => {
    ;(window as any).klaus = { media: { url: (path: string, session: string) => `klaus-media://fixture/${encodeURIComponent(path)}?s=${session}` } }
    const tool = { ...value(vector.toolName, vector.args), sessionId: images.owningSession,
      output: 'output' in vector ? vector.output : '', media: 'media' in vector ? vector.media : undefined }
    expect(activityToolPresentation(tool).imagePaths).toEqual(vector.paths)
    const closed = renderToStaticMarkup(<ActivityToolContent tool={tool} open={false} onToggle={() => {}} locale="en" />)
    expect(closed).not.toContain('<img')
    const open = renderToStaticMarkup(<ActivityToolContent tool={tool} open onToggle={() => {}} locale="en" />)
    expect((open.match(/data-media-thumb=/g) ?? []).length).toBe(vector.paths.length)
    for (const path of vector.paths) {
      expect(open).toContain(`data-media-path="${path}"`)
      expect(open).toContain(`?s=${images.owningSession}`)
    }
  })

  test('viewed image media stays in the disclosure while generated output keeps its deliverable', () => {
    ;(window as any).currentLang = 'en'
    const card = { toolCallId: 'preview', toolName: 'view_image', args: {}, argsDelta: '', progress: [], agent: false, bgTask: false,
      status: 'ok' as const, media: [{ path: '/tmp/one.png', mimeType: 'image/png' }] }
    const closed = renderToStaticMarkup(<LiveToolCard card={card} sessionId="owner" open={false} onToggle={() => {}} />)
    const open = renderToStaticMarkup(<LiveToolCard card={card} sessionId="owner" open onToggle={() => {}} />)
    expect(closed).not.toContain('<img')
    expect((open.match(/<img/g) ?? []).length).toBe(1)
    const history = renderToStaticMarkup(<HistoryToolCards tools={[{ toolCallId: 'preview', toolName: 'view_image', args: {}, state: 'done', agent: false,
      activityKind: null, output: { text: '', isError: false, media: card.media } }]} sessionId="owner" />)
    expect(history).not.toContain('<img')
    const generated = renderToStaticMarkup(<LiveToolCard card={{ ...card, toolName: 'generate_image' }} sessionId="owner" open={false} onToggle={() => {}} />)
    expect(generated).toContain('<img')
  })
})
