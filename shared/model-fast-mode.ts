/** Native request Fast preferences are independent for each model source. */
export const REQUEST_FAST_SOURCES = ['codex', 'subscription', 'qoder', 'qoderwork'] as const;
export type RequestFastSource = typeof REQUEST_FAST_SOURCES[number];
export interface FastModeMetadata {
  supportsFastMode?: boolean;
  fastBilling?: 'extraCredits';
}
export interface FastModeState {
  enabled: boolean;
  supported: boolean;
  billing?: 'extraCredits';
}
export function isRequestFastSource(source: string): source is RequestFastSource {
  return (REQUEST_FAST_SOURCES as readonly string[]).includes(source);
}
export function fastModePreferenceKey(source: string): string | undefined {
  return isRequestFastSource(source) ? `composer.${source}_fast_mode` : undefined;
}
export function isFastModePreferenceKey(key: string): boolean {
  return REQUEST_FAST_SOURCES.some(source => fastModePreferenceKey(source) === key);
}
/** Transport metadata never infers eligibility from a model name. */
export function pickFastModeMetadata(value: unknown): FastModeMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return {
    ...(typeof row.supportsFastMode === 'boolean' ? { supportsFastMode: row.supportsFastMode } : {}),
    ...(row.supportsFastMode === true && row.fastBilling === 'extraCredits' ? { fastBilling: 'extraCredits' as const } : {}),
  };
}
