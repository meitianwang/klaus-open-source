import { BrowserError, object, type BrowserObject } from './types';

export function locatorFields(fields: BrowserObject): BrowserObject {
  const nested = fields.locator;
  if (nested !== undefined && (nested === null || !['object', 'string'].includes(typeof nested) || Array.isArray(nested))) throw new BrowserError('invalid_request', 'locator must be a selector or criteria object.');
  return { ...fields, ...(typeof nested === 'string' ? { selector: nested } : object(nested)) };
}

export function locatorBudget(input: unknown, fallback: number, maximum: number, field: string, minimum = 0): number {
  if (input === undefined) return fallback;
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < minimum || input > maximum) throw new BrowserError('invalid_request', `${field} must be an integer from ${minimum} to ${maximum}.`);
  return input;
}

/** Invalid vocabulary must not silently widen a search or become a default. */
export function validateLocator(fields: BrowserObject, depth = 0): BrowserObject {
  if (depth > 8) throw new BrowserError('invalid_request', 'Nested locators may be at most eight levels deep.');
  const f = locatorFields(fields);
  if (f.state !== undefined && !['attached', 'visible', 'hidden', 'enabled', 'disabled'].includes(String(f.state))) throw new BrowserError('invalid_request', 'Locator state must be attached, visible, hidden, enabled or disabled.');
  for (const key of ['selector', 'ref', 'refId', 'role', 'name', 'text', 'query', 'label', 'placeholder', 'testId', 'hasText', 'hasNotText', 'attribute']) {
    if (f[key] !== undefined && typeof f[key] !== 'string') throw new BrowserError('invalid_request', `${key} must be a string.`);
  }
  for (const key of ['selector', 'ref', 'refId']) if (typeof f[key] === 'string' && !String(f[key]).trim()) throw new BrowserError('invalid_request', `${key} cannot be empty.`);
  for (const key of ['exact', 'first', 'last', 'visible', 'enabled', 'strict', 'frames', 'textContent']) if (f[key] !== undefined && typeof f[key] !== 'boolean') throw new BrowserError('invalid_request', `${key} must be a boolean.`);
  if (f.nth !== undefined && (typeof f.nth !== 'number' || !Number.isSafeInteger(f.nth))) throw new BrowserError('invalid_request', 'nth must be an integer.');
  for (const key of ['within', 'has', 'hasNot']) {
    const nested = f[key];
    if (nested === undefined) continue;
    if (typeof nested === 'string' && nested.trim()) continue;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) throw new BrowserError('invalid_request', `${key} must be a nonempty selector, ref or criteria object.`);
    validateLocator(object(nested), depth + 1);
  }
  for (const key of ['any', 'or']) {
    const alternatives = f[key];
    if (alternatives === undefined) continue;
    if (!Array.isArray(alternatives) || alternatives.length < 1 || alternatives.length > 32 || alternatives.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new BrowserError('invalid_request', `${key} must contain from one to 32 criteria objects.`);
    for (const row of alternatives) validateLocator(object(row), depth + 1);
  }
  return f;
}
