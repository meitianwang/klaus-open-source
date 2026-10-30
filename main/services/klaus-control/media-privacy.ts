import type { Json } from '../../ipc/contract';
import { object, string, type JsonObject } from '../service-types';
import type { ControlSurface } from './catalog';

const MEDIA_SETTINGS_NOTICE = 'Generation tools use the selected media configuration automatically. Review provider and model choices in Settings → Multimodal Models.';
export const MEDIA_SETTINGS_FAILURE = 'Media settings could not be read or updated. Open Settings → Multimodal Models to review the configuration.';

export function mediaControlKind(key: string): string | undefined {
  return /^(image|video|audio|music)(?:Gen|Selection)$/u.exec(key)?.[1];
}

export function isMediaSettingRow(key: string): boolean {
  return /^(?:image|video|audio|music)_generation(?:[.:]|$)/iu.test(key.trim());
}

export function isMediaControlRequest(input: Json): boolean {
  const request = object(input), key = string(request.key).trim();
  return Boolean(mediaControlKind(key)) || key === 'setting' && (string(request.action).trim() === 'list' || isMediaSettingRow(string(object(request.arguments).key)));
}

export function mediaControlAbout(key: string): string | undefined {
  const kind = mediaControlKind(key);
  return kind ? `Global ${kind} generation settings. ${MEDIA_SETTINGS_NOTICE}` : undefined;
}

/** Control tools expose operations while owner settings retain routing identities. */
export function describeMediaControl(surface: ControlSurface): string | undefined {
  const about = mediaControlAbout(surface.key);
  if (!about) return undefined;
  const lines = [`${surface.key}: ${about}`];
  for (const [label, operations] of [['Read actions (klaus_query)', surface.reads], ['Write actions (klaus_action)', surface.writes]] as const) {
    if (!operations.length) continue;
    lines.push(`\n${label}:`);
    for (const operation of operations) lines.push(`- ${operation.action}: ${operation.action === 'selection' ? '{} — returns enabled and available status without routing identities'
      : operation.action === 'config' ? '{ source?: string } — returns supported controls without routing identities'
      : operation.action === 'setSelection' ? '{ selection: string, model?: string } — use only choices explicitly supplied by the user'
      : '{ source?: string, provider?: string, baseUrl?: string, apiKey?: string, model?: string, voice?: string } — use only changes explicitly supplied by the user; custom configuration replaces its stored row, so omitted fields are cleared. Leave credential edits to the user in Settings'}`);
  }
  lines.push('\nLocation: nav.open { "view": "settings", "tab": "multimodal" }.');
  return lines.join('\n');
}

/** Allow only bounded status fields; identity may also appear in arbitrary errors. */
export function projectMediaControlResult(key: string, value: Json, write: boolean): { value: JsonObject; success: boolean } {
  const row = object(value);
  if (row.ok === false || row.success === false || row.error != null && row.error !== '') return { value: { ok: false, error: MEDIA_SETTINGS_FAILURE }, success: false };
  const kind = mediaControlKind(key)!;
  const safe: JsonObject = { ok: true, kind, ...(write ? { updated: true } : {}), notice: MEDIA_SETTINGS_NOTICE };
  if (!write && key.endsWith('Selection')) {
    const selected = string(row.selection), availability = object(row.availability);
    if (selected) safe.enabled = selected !== 'none';
    if (typeof availability[selected] === 'boolean') safe.available = availability[selected]!;
  }
  if (!write) {
    const capability = object(object(row.capabilities)[kind]);
    for (const name of ['available', 'referenceImages', 'voice', 'speed']) if (typeof capability[name] === 'boolean') safe[name] = capability[name]!;
  }
  return { value: safe, success: true };
}

export function withoutMediaSettingRows(rows: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(rows).filter(([key]) => !isMediaSettingRow(key)));
}
