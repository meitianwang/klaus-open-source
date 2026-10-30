import { object } from './types';

/** Typed browser timestamps are nonnegative integer milliseconds. Keep any
 * fractional source timestamp on the raw entry for diagnostic precision. */
export function integerTimestampMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.trunc(value) : undefined;
}

export function consoleLevel(value: unknown): 'debug' | 'info' | 'warning' | 'error' | 'log' {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'verbose': case 'debug': case 'trace': return 'debug';
    case 'warn': case 'warning': return 'warning';
    case 'error': case 'assert': return 'error';
    case 'info': case 'count': case 'timeend': return 'info';
    default: return 'log';
  }
}

export function consoleArgumentsText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map(raw => {
    const argument = object(raw);
    if (argument.value !== undefined) {
      if (typeof argument.value === 'string') return argument.value;
      try { return JSON.stringify(argument.value); } catch { return String(argument.value); }
    }
    return typeof argument.description === 'string' ? argument.description : '[object]';
  }).join(' ');
}
