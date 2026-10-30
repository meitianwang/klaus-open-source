/** Exact errors written by older clients for intentional run termination. */
export const LEGACY_CRON_STOP_ERRORS = ['Task interrupted', 'interrupted (app shutdown)'] as const;

export function effectiveCronRunStatus(run: { status: string; error?: string | null }): string {
  if ((run.status === 'failed' || run.status === 'success')
    && LEGACY_CRON_STOP_ERRORS.some(error => error === run.error)) return 'stopped';
  return run.status === 'success' && !!run.error ? 'failed' : run.status;
}
