import { setTimeout as delay } from 'node:timers/promises';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { escapeAppleScript as esc, string, type MacOsExecution, type Row } from './types';

export const APPLICATION_EXECUTABLES = ['/usr/bin/osascript', '/usr/bin/open'];
export type OrganizerApp = 'Calendar' | 'Contacts' | 'Reminders' | 'Notes' | 'Mail' | 'Messages' | 'Safari' | 'Photos';
const bundleIds = { Calendar: 'com.apple.iCal', Contacts: 'com.apple.AddressBook', Reminders: 'com.apple.reminders', Notes: 'com.apple.Notes', Mail: 'com.apple.mail', Messages: 'com.apple.MobileSMS', Safari: 'com.apple.Safari', Photos: 'com.apple.Photos' };
export async function applicationAvailable(app: OrganizerApp): Promise<boolean> {
  try { await access(`${app === 'Safari' ? '/Applications' : '/System/Applications'}/${app}.app/Contents/MacOS/${app}`, constants.X_OK); return true; } catch { return false; }
}
export const APPLE_JSON = `use framework "Foundation"
use scripting additions
on jsonText(value_)
  set data_ to current application's NSJSONSerialization's dataWithJSONObject:value_ options:0 |error|:(missing value)
  if data_ is missing value then error "The application result could not be serialized"
  return (current application's NSString's alloc()'s initWithData:data_ encoding:(current application's NSUTF8StringEncoding)) as text
end jsonText
on jsonRow(keys_, values_)
  return current application's NSDictionary's dictionaryWithObjects:values_ forKeys:keys_
end jsonRow
on nullable(value_)
  if value_ is missing value or value_ is "" then return current application's NSNull's |null|()
  return value_
end nullable
on textOrEmpty(value_)
  if value_ is missing value then return ""
  return value_ as text
end textOrEmpty
`;
export const APPLE_DATE = `on dateAt(seconds_)
  return (current application's NSDate's dateWithTimeIntervalSince1970:seconds_) as date
end dateAt
`;

export async function applicationScript(app: OrganizerApp, script: string, execution: MacOsExecution, timeoutMs?: number): Promise<string> {
  const target = `application id "${bundleIds[app]}"`;
  await execution.run('/usr/bin/open', ['-gj', '-b', bundleIds[app]], { timeoutMs: 10_000 });
  // Only a read-only readiness request may retry. A mutation is dispatched exactly once.
  for (let attempt = 0; ; attempt++) {
    try {
      const version = await execution.osa(`tell ${target} to return version`, 5000);
      if (!version.trim()) throw new Error(app + ' did not report a ready version');
      break;
    } catch (error) {
      if (attempt >= 4 || !(error instanceof Error) || !/\(-600\)|not running|应用程序没有运行/.test(error.message)) throw error;
      await delay(250, undefined, { signal: execution.signal }); execution.assertCurrent();
    }
  }
  return execution.osa(APPLE_JSON + APPLE_DATE + script.replaceAll(`tell application "${app}"`, 'tell ' + target), timeoutMs);
}

export const quote = (value: string): string => '"' + esc(value) + '"';
export const definedText = (args: Row, key: string): string | undefined => args[key] === undefined ? undefined : string(args[key] === null ? '' : args[key], key);
export function boundedLimit(args: Row, fallback: number, cap: number): number {
  const value = args.limit ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('limit must be a finite number');
  return Math.max(1, Math.min(cap, Math.floor(value)));
}
export function dateSeconds(value: string, name = 'date'): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value.trim());
  const invalid = () => new Error('Invalid ' + name + ': ' + value);
  if (!match) throw invalid();
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4] ?? 0), minute = Number(match[5] ?? 0), second = Number(match[6] ?? 0), zone = match[8];
  const utc = new Date(0); utc.setUTCFullYear(year, month - 1, day); utc.setUTCHours(hour, minute, second, 0);
  if (year < 1 || utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) throw invalid();
  if (!match[4] || zone === 'Z') return utc.getTime() / 1000;
  if (zone) {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4, 6)); if (hours > 23 || minutes > 59) throw invalid();
    return utc.getTime() / 1000 - (zone[0] === '+' ? 1 : -1) * (hours * 3600 + minutes * 60);
  }
  const local = new Date(0); local.setFullYear(year, month - 1, day); local.setHours(hour, minute, second, 0);
  if (local.getFullYear() !== year || local.getMonth() !== month - 1 || local.getDate() !== day || local.getHours() !== hour || local.getMinutes() !== minute || local.getSeconds() !== second) throw invalid();
  return local.getTime() / 1000;
}
export function appleDate(seconds: number): string {
  if (!Number.isSafeInteger(seconds)) throw new Error('Invalid application date instant');
  return `(my dateAt(${seconds}))`;
}
export function arrayResult(raw: string, limit: number): unknown[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > limit) throw new Error('The application returned an invalid bounded array');
  return value;
}
export function namesResult(raw: string): string[] {
  const value = arrayResult(raw, 2000);
  if (value.some(name => typeof name !== 'string')) throw new Error('The application returned an invalid name list');
  return value as string[];
}
export function confirmed(raw: string): void { if (raw !== 'ok') throw new Error('The application did not confirm the requested change'); }
