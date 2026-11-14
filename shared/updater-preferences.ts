/** Persisted on this computer; controls whether found app updates download on their own. Absent means on. */
export const UPDATER_AUTO_DOWNLOAD_KEY = 'updater.autoDownload';

/** Interpret the stored `updater.autoDownload` setting row; absent or blank defaults to on. */
export function isUpdaterAutoDownloadEnabled(value: string | null | undefined): boolean {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return true;
  return !['off', '0', 'false', 'no', 'disable', 'disabled'].includes(raw);
}
