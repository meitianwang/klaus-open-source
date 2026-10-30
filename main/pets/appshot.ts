import type { PetAppshotContext, PetCapturedScreenshot } from '../../contracts/desktop-pet-composer';
import { decodeBinary } from '../ipc/binary';
import type { Json } from '../ipc/contract';

function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
/** Validates one native capture transaction without deriving application context from pixels. */
export function petAppshot(raw: unknown): PetCapturedScreenshot {
  const result = object(raw), screenshot = object(result.screenshot), value = object(result.context), data = decodeBinary(screenshot.data as Json, 10 * 1024 * 1024);
  if (screenshot.mimeType !== 'image/png' || !data || data.length < 24 || !Buffer.from(data.subarray(0, 8)).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('The application capture returned no valid image');
  const header = Buffer.from(data.subarray(0, 24)), width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 8_000_000 || screenshot.width !== width || screenshot.height !== height) throw new Error('The application capture image dimensions are invalid');
  if (typeof value.capturedAt !== 'number' || !Number.isFinite(value.capturedAt) || value.capturedAt <= 0) throw new Error('The application capture has no capture timestamp');
  const context: PetAppshotContext = { capturedAt: value.capturedAt };
  for (const field of ['appName', 'bundleId', 'windowTitle', 'url', 'selectedText', 'accessibilityText', 'accessibilityUnavailableReason'] as const) {
    if (value[field] !== undefined) { if (typeof value[field] !== 'string' || value[field].length > (field === 'accessibilityText' ? 50_000 : 4096)) throw new Error('The application capture context exceeds its limits'); context[field] = value[field]; }
  }
  for (const field of ['pid', 'windowId'] as const) if (value[field] !== undefined) { if (typeof value[field] !== 'number' || !Number.isSafeInteger(value[field]) || value[field] < 1) throw new Error('The application capture identity is invalid'); context[field] = value[field]; }
  for (const field of ['treeTruncated', 'observationChanged'] as const) if (typeof value[field] === 'boolean') context[field] = value[field];
  const bounds = object(value.bounds);
  if (Object.keys(bounds).length) { if (['x', 'y', 'width', 'height'].some(key => typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key])) || Number(bounds.width) <= 0 || Number(bounds.height) <= 0) throw new Error('The application capture bounds are invalid'); context.bounds = bounds as unknown as NonNullable<PetAppshotContext['bounds']>; }
  return { data, context };
}
