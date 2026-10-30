import type { GoalLocale, GoalStatus } from './types'

const en = {
  goal: 'Goal', active: 'Pursuing goal', paused: 'Paused goal', blocked: 'Goal stalled',
  usage_limited: 'Goal usage limited', budget_limited: 'Goal limited', complete: 'Goal achieved',
  view: 'View goal', restricted: 'This conversation can view, pause, or clear this goal.', readOnlyObjective: 'The goal objective is read-only in this conversation.',
  edit: 'Edit goal', pause: 'Pause goal', resume: 'Resume goal', clear: 'Clear goal',
  tokens: 'Tokens used', duration: 'Time pursuing goal', save: 'Save', saving: 'Saving…', revert: 'Revert',
  objective: 'Goal objective', empty: 'Enter a goal objective.', loading: 'Loading goal objective…',
  loadFailed: 'Could not load the goal objective.', retry: 'Try again', saveFailed: 'Could not save the goal.',
  actionFailed: 'Could not update the goal.', sourceChanged: 'The goal changed elsewhere. Revert to load the saved objective.',
  updatedNow: 'Updated just now', updated: 'Updated {time}', unsaved: 'Unsaved changes',
  resumePausedTitle: 'Resume paused goal?', resumeTitle: 'Resume goal?',
  resumeBody: 'Klaus will continue working toward this objective.', keepPaused: 'Keep paused', notNow: 'Not now',
  replaceTitle: 'Replace goal?', replaceBody: 'Use this objective for the current goal?', replace: 'Replace goal', cancel: 'Cancel',
  close: 'Close', pending: 'Updating goal…',
}
const zh: typeof en = {
  goal: '目标', active: '正在推进目标', paused: '目标已暂停', blocked: '目标受阻',
  usage_limited: '目标用量受限', budget_limited: '目标预算已用尽', complete: '目标已达成',
  view: '查看目标', restricted: '此对话可查看、暂停或清除此目标。', readOnlyObjective: '此对话中的目标内容为只读。',
  edit: '编辑目标', pause: '暂停目标', resume: '恢复目标', clear: '清除目标',
  tokens: '已用 Token', duration: '目标推进用时', save: '保存', saving: '正在保存…', revert: '还原',
  objective: '目标内容', empty: '请输入目标内容。', loading: '正在加载目标内容…',
  loadFailed: '无法加载目标内容。', retry: '重试', saveFailed: '无法保存目标。',
  actionFailed: '无法更新目标。', sourceChanged: '目标已在其他位置更改。请还原以加载已保存的内容。',
  updatedNow: '刚刚更新', updated: '{time}更新', unsaved: '有未保存的更改',
  resumePausedTitle: '恢复已暂停的目标？', resumeTitle: '恢复目标？',
  resumeBody: 'Klaus 将继续推进此目标。', keepPaused: '保持暂停', notNow: '暂不恢复',
  replaceTitle: '替换目标？', replaceBody: '将当前目标替换为此内容？', replace: '替换目标', cancel: '取消',
  close: '关闭', pending: '正在更新目标…',
}

export type GoalMessage = keyof typeof en
export function goalText(key: GoalMessage, locale: GoalLocale = 'en'): string {
  return (locale.startsWith('zh') ? zh : en)[key]
}
export function goalStatusLabel(status: GoalStatus, locale: GoalLocale = 'en'): string {
  return goalText(status, locale)
}
