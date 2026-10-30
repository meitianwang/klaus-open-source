import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { GoalConfirmation, GoalEditor, GoalProgressRow } from './components'
import { GoalEditorController } from './editor-state'
import type { GoalSnapshot, GoalStatus } from './types'

const base: GoalSnapshot = {
  goalId: 'goal-one', threadId: 'thread-one', objective: 'Ship <safe> multiline\n`code` and links', status: 'active',
  tokenBudget: null, tokensUsed: 6400, timeUsedSeconds: 62, createdAtMs: 1000, updatedAtMs: Date.now(),
}
const noop = () => {}
const action = async () => {}
function row(status: GoalStatus, locale = 'en') {
  return renderToStaticMarkup(<GoalProgressRow goal={{ ...base, status }} locale={locale} onOpen={noop} onPause={action} onResume={action} onClear={action} />)
}

describe('goal controls and outcomes', () => {
  test('active row exposes edit, pause and clear with safe objective text', () => {
    const html = row('active')
    expect(html).toContain('Pursuing goal')
    expect(html).toContain('data-goal-action="edit"')
    expect(html).toContain('data-goal-action="pause"')
    expect(html).toContain('data-goal-action="clear"')
    expect(html).toContain('Ship &lt;safe&gt; multiline')
    expect(html).not.toContain('title=')
    expect(html).not.toContain('data-klaus-tip')
  })
  for (const status of ['paused', 'blocked', 'usage_limited'] as const) {
    test(`${status} has resume and localized accessible controls`, () => {
      expect(row(status)).toContain('data-goal-action="resume"')
      const html = row(status, 'zh-CN')
      expect(html).toContain('aria-label="恢复目标"')
      expect(html).toContain('aria-label="编辑目标"')
      expect(html).not.toContain('title=')
    })
  }
  test('budget limited has terminal controls and complete moves out of the live row', () => {
    const limited = row('budget_limited')
    expect(limited).toContain('Goal limited')
    expect(limited).not.toContain('data-goal-action="resume"')
    expect(row('complete')).toBe('')
  })
  test('resume confirmations preserve state-specific dismissal and compact objective', () => {
    const paused = renderToStaticMarkup(<GoalConfirmation kind="resume" goal={{ ...base, status: 'paused' }} onCancel={noop} onConfirm={noop} />)
    expect(paused).toContain('Resume paused goal?')
    expect(paused).toContain('Keep paused')
    expect(paused).toContain('aria-modal="true"')
    for (const status of ['blocked', 'usage_limited'] as const) {
      const html = renderToStaticMarkup(<GoalConfirmation kind="resume" goal={{ ...base, status }} onCancel={noop} onConfirm={noop} />)
      expect(html).toContain('Resume goal?')
      expect(html).toContain('Not now')
      expect(html).not.toContain('Keep paused')
    }
  })
  test('pending confirmation cannot dispatch a second action', () => {
    const html = renderToStaticMarkup(<GoalConfirmation kind="replace" goal={base} pending onCancel={noop} onConfirm={noop} />)
    expect(html).toContain('aria-busy="true"')
    expect(html.match(/disabled=""/g)).toHaveLength(2)
    expect(html).toContain('Updating goal…')
  })
  test('editor has Save/Revert, last-updated information and no numeric budget field', () => {
    const html = renderToStaticMarkup(<GoalEditor goal={base} controller={new GoalEditorController(base)} onSave={async (objective, goal) => ({ ...goal, objective })} />)
    expect(html).toContain('data-goal-editor')
    expect(html).toContain('Updated just now')
    expect(html).toContain('Revert')
    expect(html).toContain('Save')
    expect(html.match(/disabled=""/g)).toHaveLength(2)
    expect(html).not.toContain('type="number"')
    expect(html).not.toContain('title=')
  })
})

for (const status of ['active', 'paused', 'blocked', 'usage_limited'] as const) test(`restricted ${status} goals retain read/clear and appropriate pause without edit or resume`, () => {
  const html = renderToStaticMarkup(<GoalProgressRow goal={{ ...base, status }} canPursue={false} onOpen={noop} onPause={action} onResume={action} onClear={action} />)
  expect(html).toContain('aria-label="View goal"')
  expect(html).toContain('data-goal-action="open"')
  expect(html).toContain('data-goal-action="clear"')
  expect(html).toContain('This conversation can view, pause, or clear this goal.')
  expect(html.includes('data-goal-action="pause"')).toBe(status === 'active')
  expect(html).not.toContain('data-goal-action="edit"')
  expect(html).not.toContain('data-goal-action="resume"')
  expect(html).not.toContain('title=')
})
test('restricted objective editor presents readable content and disables Save/Revert with localized context', () => {
  const controller = new GoalEditorController(base)
  controller.setText('Retained unsaved objective')
  const html = renderToStaticMarkup(<GoalEditor goal={base} controller={controller} readOnly locale="zh" onSave={async (objective, goal) => ({ ...goal, objective })} />)
  expect(html).toContain('此对话中的目标内容为只读。')
  expect(html.match(/disabled=""/g)).toHaveLength(2)
})
