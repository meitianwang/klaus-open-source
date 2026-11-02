import { randomBytes } from 'node:crypto';
import type { Json } from '../ipc/contract';
import { CRON_PERMISSION_PRESETS, CronStore } from './cron-store';
import { object, string, type JsonObject } from './service-types';

export const CRON_TOOL_SPECS: Json[] = [
  {
    type: 'function', name: 'CronCreate',
    description: 'Schedule a persistent local task that gives a saved prompt to Klaus at a future time, once or repeatedly. Use for reminders, recurring work, monitoring, follow-ups, or requests to check back later; do not use shell sleep or timers as a scheduling workaround. Write clear, cohesive, human-readable instructions. Inspect existing tasks with CronList before creating a replacement or duplicate. Preserve the user\'s notification intent in monitoring prompts: unless periodic updates were explicitly requested, stay quiet while the state is unchanged or non-actionable and notify only for a meaningful change, completion, failure, or required user action. Confirm the schedule in plain language; do not expose raw cron syntax unless requested. Pass the user\'s chosen project directory, workspace, and permission preset when they name one.',
    inputSchema: {
      type: 'object',
      properties: {
        cron: { type: 'string', description: 'Standard five-field cron expression in this computer\'s local timezone: minute hour day-of-month month day-of-week. For example, */5 * * * * runs every five minutes and 0 9 * * 1-5 runs at 09:00 on weekdays.' },
        prompt: { type: 'string', description: 'Clear, cohesive instructions replayed at each scheduled run. Preserve the task scope, relevant context, completion conditions, and the user\'s notification intent.' },
        recurring: { description: 'True (default) runs at every matching slot. False runs at the next matching slot and then disables the task. Use false for one-shot reminders and pin the intended minute, hour, day, and month.', type: 'boolean' },
        name: { description: 'Optional short, human-readable task name.', type: 'string' },
        workdir: { description: 'Optional project directory for every run. Mutually exclusive with workspaceId.', type: 'string' },
        workspaceId: { description: 'Optional workspace whose project directories every run may use. Mutually exclusive with workdir.', type: 'string' },
        permissionPreset: { description: 'Optional permission preset for each run. Omit to preserve the previous unrestricted scheduled-task behavior; an explicit value follows the ordinary conversation presets.', type: 'string', enum: [...CRON_PERMISSION_PRESETS] },
      },
      required: ['cron', 'prompt'], additionalProperties: false,
    },
  },
  {
    type: 'function', name: 'CronList', description: 'List tool-created scheduled tasks with their IDs, schedules, and prompts. Inspect this list when the user asks about an existing task or before replacing an existing schedule.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function', name: 'CronDelete', description: 'Cancel a tool-created scheduled task by an ID returned by CronCreate or CronList. Use only for the task the user asked to cancel or replace. This removes its saved run history.',
    inputSchema: {
      type: 'object', properties: { id: { type: 'string', description: 'Task ID to cancel, returned by CronCreate or CronList.' } },
      required: ['id'], additionalProperties: false,
    },
  },
];

export const toolText = (text: string, success = true): JsonObject => ({ success, contentItems: [{ type: 'inputText', text }] });

function received(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function parseToolInput(input: unknown, requiredStrings: string[], optionalStrings: string[], optionalBooleans: string[]): { value?: JsonObject; error?: string } {
  const args = object(input), value: JsonObject = {}, issues: string[] = [];
  for (const key of requiredStrings) {
    if (typeof args[key] === 'string') value[key] = args[key]!;
    else issues.push(`${key}: Invalid input: expected string, received ${received(args[key])}`);
  }
  for (const key of optionalStrings) {
    if (args[key] == null) continue;
    if (typeof args[key] === 'string') value[key] = args[key]!;
    else issues.push(`${key}: Invalid input: expected string, received ${received(args[key])}`);
  }
  for (const key of optionalBooleans) {
    if (args[key] == null) continue;
    if (typeof args[key] === 'boolean') value[key] = args[key]!;
    else issues.push(`${key}: Invalid input: expected boolean, received ${received(args[key])}`);
  }
  return issues.length ? { error: `Invalid arguments: ${issues.join('; ')}` } : { value };
}

const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

function expandField(field: string, min: number, max: number): number[] | null {
  if (!field) return null;
  const values: number[] = [];
  for (const part of field.split(',')) {
    const segments = part.split('/');
    if (segments.length > 2) return null;
    const spec = segments[0]!;
    const step = segments.length === 2 && /^\d+$/.test(segments[1]!) ? Number(segments[1]) : 1;
    if (!Number.isSafeInteger(step) || step <= 0) return null;
    let start: number, end: number;
    if (spec === '*') { start = min; end = max; }
    else if (spec.includes('-')) {
      const bounds = spec.split('-');
      if (bounds.length !== 2 || !bounds.every(value => /^\d+$/.test(value))) return null;
      start = Number(bounds[0]); end = Number(bounds[1]);
      if (start < min || end > max || start > end) return null;
    } else {
      if (segments.length === 2 || !/^\d+$/.test(spec)) return null;
      start = Number(spec); end = start;
      if (start < min || start > max) return null;
    }
    for (let value = start; value <= end; value += step) values.push(value);
  }
  return values.length ? values : null;
}

function parseCronFields(schedule: string): number[][] | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields: number[][] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const range = FIELD_RANGES[index]!, expanded = expandField(parts[index]!, range[0], range[1]);
    if (!expanded) return null;
    fields.push(expanded);
  }
  return fields;
}

function hasUpcomingRun(schedule: string, from = Date.now()): boolean {
  const fields = parseCronFields(schedule);
  if (!fields) return false;
  const months = fields[3]!, daysOfMonth = fields[2]!, daysOfWeek = fields[4]!;
  const domConstrained = daysOfMonth.length !== 31, dowConstrained = daysOfWeek.length !== 8;
  const date = new Date(from);
  if (!Number.isFinite(date.getTime())) return false;
  date.setHours(0, 0, 0, 0);
  for (let index = 0; index < 367; index += 1) {
    if (months.includes(date.getMonth() + 1)) {
      const domHit = daysOfMonth.includes(date.getDate());
      const dow = date.getDay(), dowHit = daysOfWeek.includes(dow) || (dow === 0 && daysOfWeek.includes(7));
      if ((domConstrained && dowConstrained && (domHit || dowHit)) || (domConstrained && !dowConstrained && domHit)
        || (!domConstrained && dowConstrained && dowHit) || (!domConstrained && !dowConstrained)) return true;
    }
    date.setDate(date.getDate() + 1);
  }
  return false;
}

function localTime(minute: number, hour: number): string {
  const suffix = hour < 12 ? 'AM' : 'PM', displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, '0')} ${suffix}`;
}

export function cronToolScheduleLabel(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];
  const wildcardDate = dayOfMonth === '*' && month === '*' && dayOfWeek === '*';
  const numeric = (field: string): number | undefined => /^\d+$/.test(field) ? Number(field) : undefined;
  const step = (field: string): number | undefined => /^\*\/\d+$/.test(field) ? Number(field.slice(2)) : undefined;
  const minuteStep = step(minute);
  if (minuteStep !== undefined && hour === '*' && wildcardDate) return minuteStep === 1 ? 'Every minute' : `Every ${minuteStep} minutes`;
  const minuteNumber = numeric(minute);
  if (minuteNumber !== undefined) {
    if (hour === '*' && wildcardDate) return minuteNumber === 0 ? 'Every hour' : `Every hour at :${String(minuteNumber).padStart(2, '0')}`;
    const hourStep = step(hour);
    if (hourStep !== undefined && wildcardDate) {
      const suffix = minuteNumber === 0 ? '' : ` at :${String(minuteNumber).padStart(2, '0')}`;
      return hourStep === 1 ? `Every hour${suffix}` : `Every ${hourStep} hours${suffix}`;
    }
  }
  const hourNumber = numeric(hour);
  if (minuteNumber === undefined || hourNumber === undefined) return schedule;
  const time = localTime(minuteNumber, hourNumber);
  if (wildcardDate) return `Every day at ${time}`;
  if (dayOfMonth === '*' && month === '*') {
    const day = numeric(dayOfWeek);
    if (dayOfWeek.length === 1 && day !== undefined) return `Every ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day % 7]} at ${time}`;
    if (dayOfWeek === '1-5') return `Weekdays at ${time}`;
  }
  return schedule;
}

function newTaskId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz', suffix = [...randomBytes(4)].map(value => alphabet[value % 36]).join('');
  return `cron-${Date.now().toString(36)}-${suffix}`;
}

export function cronToolResultText(result: JsonObject): string {
  const item = Array.isArray(result.contentItems) ? object(result.contentItems[0]) : {};
  return string(item.text);
}

export function executeCronTool(store: CronStore, name: string, input: unknown): JsonObject {
  if (name === 'CronList') {
    let tasks: JsonObject[];
    try { tasks = store.toolTasks().filter(task => task.enabled); }
    catch { return toolText('当前没有已排程的定时任务。'); }
    if (!tasks.length) return toolText('当前没有已排程的定时任务。');
    const lines = tasks.map(task => {
      const kind = task.deleteAfterRun === true ? '（一次性）' : '（循环）';
      return `${string(task.id)} — ${cronToolScheduleLabel(string(task.schedule))}${kind}：${[...string(task.prompt)].slice(0, 80).join('')}`;
    });
    return toolText(`已排程 ${tasks.length} 个定时任务：\n${lines.join('\n')}`);
  }
  if (name === 'CronDelete') {
    const parsed = parseToolInput(input, ['id'], [], []);
    if (parsed.error) return toolText(parsed.error, false);
    const id = string(parsed.value?.id);
    try {
      if (!store.toolTasks().some(task => task.id === id)) return toolText(`没有 ID 为 "${id}" 的定时任务。`, false);
      return store.deleteToolTask(id) ? toolText(`已取消定时任务 ${id}。`) : toolText('定时任务系统不可用。', false);
    } catch { return toolText('定时任务系统不可用。', false); }
  }
  if (name !== 'CronCreate') return toolText(`Dynamic tool is not registered: ${name}`, false);
  const parsed = parseToolInput(input, ['cron', 'prompt'], ['name', 'workdir', 'workspaceId', 'permissionPreset'], ['recurring']);
  if (parsed.error) return toolText(parsed.error, false);
  const args = parsed.value!, schedule = string(args.cron).trim(), prompt = string(args.prompt);
  if (!parseCronFields(schedule)) return toolText(`cron 表达式无效："${schedule}"。应为 5 个字段：分 时 日 月 周。`, false);
  if (!hasUpcomingRun(schedule)) return toolText(`cron 表达式 "${schedule}" 在未来一年内没有任何可触发时刻。`, false);
  const workdir = string(args.workdir).trim(), workspaceId = string(args.workspaceId).trim();
  if (workdir && workspaceId) return toolText('workdir 与 workspaceId 不能同时设置。', false);
  const requestedPermission = string(args.permissionPreset).trim();
  if (args.permissionPreset !== undefined && !requestedPermission) {
    return toolText(`permissionPreset 必须是 ${CRON_PERMISSION_PRESETS.join('、')} 之一。`, false);
  }
  const permissionPreset = requestedPermission || 'bypassPermissions';
  if (!CRON_PERMISSION_PRESETS.includes(permissionPreset as typeof CRON_PERMISSION_PRESETS[number])) {
    return toolText(`permissionPreset 必须是 ${CRON_PERMISSION_PRESETS.join('、')} 之一。`, false);
  }
  try {
    if (store.toolTasks().length >= 50) return toolText('定时任务过多（上限 50），请先取消一个再创建。', false);
    const recurring = args.recurring !== false, id = newTaskId();
    store.upsertTask({ id, userId: 'desktop', name: string(args.name) || [...prompt].slice(0, 40).join(''), schedule, prompt,
      ...(workdir ? { workdir } : {}), ...(workspaceId ? { workspaceId } : {}), permissionPreset,
      enabled: true, deleteAfterRun: !recurring, createdBy: 'klaus_chat', createdAt: Date.now() });
    const human = cronToolScheduleLabel(schedule);
    return toolText(recurring
      ? `已创建循环定时任务 ${id}（${human}），已持久化到服务端。用 CronDelete 可取消。`
      : `已创建一次性定时任务 ${id}（${human}），将在下次匹配时触发一次后自动停用。`);
  } catch {
    return toolText('定时任务系统不可用（store 未注入）。', false);
  }
}
