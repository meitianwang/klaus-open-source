import { activityRecord, activityResultObjects, activityResultText } from './activity-semantic'

export interface ActivitySchedule {
  id: string
  name: string
  cron?: string
  humanSchedule?: string
  recurring?: boolean
  durable?: boolean
}

/** Stored event data is a snapshot; do not fill it from the current task list. */
export function activitySchedules(toolName: string, input: unknown, output: string | undefined): ActivitySchedule[] {
  const name = toolName.toLowerCase().replace(/^functions[._]/, '')
  const args = activityRecord(input)
  const objects = activityResultObjects(output)
  const text = activityResultText(output)
  const str = (value: unknown) => typeof value === 'string' ? value : ''
  if (name === 'croncreate') {
    const result = objects.find(item => typeof item.id === 'string' && ('humanSchedule' in item || 'durable' in item)) ?? {}
    const native = /Scheduled (recurring job|one-shot task) ([\w-]+) \(([^\n]+?)\)\./.exec(text)
    const id = str(result.id) || /\b(cron-[\w-]+)\b/.exec(text)?.[1] || native?.[2] || ''
    return [{ id, name: str(args.name) || str(args.prompt).slice(0, 40), cron: str(args.cron) || undefined,
      humanSchedule: str(result.humanSchedule) || native?.[3] || undefined,
      recurring: typeof result.recurring === 'boolean' ? result.recurring : native ? native[1] === 'recurring job' : args.recurring !== false,
      durable: typeof result.durable === 'boolean' ? result.durable : /已持久化|Persisted to/i.test(text) ? true : /Session-only/i.test(text) ? false : undefined }]
  }
  if (name === 'crondelete') return [{ id: str(args.id), name: '' }]
  if (name !== 'cronlist') return []
  const list = objects.find(item => Array.isArray(item.jobs))?.jobs
  if (Array.isArray(list)) return list.map(value => {
    const item = activityRecord(value)
    return { id: str(item.id), name: str(item.name) || str(item.prompt).slice(0, 80), cron: str(item.cron) || undefined,
      humanSchedule: str(item.humanSchedule) || undefined, recurring: item.recurring === true, durable: item.durable !== false }
  }).filter(item => item.id)
  return text.split(/\r?\n/).flatMap(line => {
    const host = /^(cron-[\w-]+) — (.+?)（(一次性|循环)）：(.*)$/.exec(line.trim())
    if (host) return [{ id: host[1], name: host[4], humanSchedule: host[2], recurring: host[3] === '循环' }]
    const native = /^([\w-]+) — (.+?) \((recurring|one-shot)\)( \[session-only\])?: (.*)$/.exec(line.trim())
    return native ? [{ id: native[1], name: native[5], humanSchedule: native[2], recurring: native[3] === 'recurring', durable: !native[4] }] : []
  })
}

export function activityScheduleIsEmpty(output: string | undefined): boolean {
  const objects = activityResultObjects(output)
  if (objects.some(item => Array.isArray(item.jobs) && item.jobs.length === 0)) return true
  return /^(?:当前没有已排程的定时任务。|No scheduled jobs\.)$/.test(activityResultText(output).trim())
}

/** Only invert schedule phrases emitted by the local scheduler. */
export function activityScheduleCron(human: string | undefined): string | undefined {
  if (!human) return undefined
  if (/^[\d*/,-]+(?:\s+[\d*/,-]+){4}$/.test(human)) return human
  const interval = /^Every (\d+) minutes$/.exec(human)
  if (interval && Number(interval[1]) >= 1 && Number(interval[1]) <= 59) return `*/${interval[1]} * * * *`
  if (human === 'Every minute') return '*/1 * * * *'
  if (human === 'Every hour') return '0 * * * *'
  const time = /^(Every day|Weekdays|Every Sunday|Every Monday|Every Tuesday|Every Wednesday|Every Thursday|Every Friday|Every Saturday) at (\d{1,2}):(\d{2}) (AM|PM)$/.exec(human)
  if (!time || Number(time[2]) < 1 || Number(time[2]) > 12 || Number(time[3]) > 59) return undefined
  const hour = Number(time[2]) % 12 + (time[4] === 'PM' ? 12 : 0)
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const day = time[1] === 'Every day' ? '*' : time[1] === 'Weekdays' ? '1-5' : String(days.indexOf(time[1].slice(6)))
  return `${Number(time[3])} ${hour} * * ${day}`
}

export function openActivityScheduleManagement(): boolean {
  const button = document.getElementById('btn-cron')
  if (!button) return false
  button.click()
  return true
}
