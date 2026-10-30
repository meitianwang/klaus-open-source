import type { Json } from './contract';
import { IpcHandlerError, type HandlerContext } from './registry';

export function object(value: unknown): Record<string, Json> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Json> : undefined;
}

export function payload(context: HandlerContext): Record<string, Json> {
  const value = context.args[0];
  if (value === undefined || value === null) return {};
  const result = object(value);
  if (!result) throw new IpcHandlerError('BAD_REQUEST', 'An argument object is required');
  return result;
}

export function requiredString(value: Record<string, Json>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) {
    throw new IpcHandlerError('BAD_REQUEST', `${key} is required`);
  }
  return field;
}
