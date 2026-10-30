import {
  LEGACY_UI_STATE_CONSUMED, LEGACY_UI_STATE_KV_KEY, LEGACY_UI_STATE_LOCAL_MARKER,
  parseLegacyUiStateSnapshot,
} from '../../../contracts/legacy-ui-state'

export interface MigrationSettingsKv {
  get(key: string): Promise<unknown>
  set(key: string, value: string): Promise<unknown>
}

export interface MigrationStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type LegacyUiStateRestoreResult = 'restored' | 'complete' | 'missing' | 'invalid' | 'retry'

export async function restoreLegacyUiState(kv: MigrationSettingsKv, storage: MigrationStorage): Promise<LegacyUiStateRestoreResult> {
  try {
    const raw = await kv.get(LEGACY_UI_STATE_KV_KEY)
    if (raw == null) return 'missing'
    if (raw === LEGACY_UI_STATE_CONSUMED) return 'complete'
    const snapshot = parseLegacyUiStateSnapshot(raw)
    if (!snapshot) return 'invalid'
    if (storage.getItem(LEGACY_UI_STATE_LOCAL_MARKER) !== '1') {
      for (const [key, value] of Object.entries(snapshot.entries)) {
        // Empty strings and explicit "0" values are saved choices, too.
        if (storage.getItem(key) === null) storage.setItem(key, value)
      }
      storage.setItem(LEGACY_UI_STATE_LOCAL_MARKER, '1')
    }
    // Keep a tombstone so the host cannot import the old source again. If this
    // write fails, the local marker prevents deleted keys from being resurrected.
    await kv.set(LEGACY_UI_STATE_KV_KEY, LEGACY_UI_STATE_CONSUMED)
    return 'restored'
  } catch {
    // A quota error or unavailable host must not prevent the app from starting.
    // The staged snapshot is retained and missing entries can be retried later.
    return 'retry'
  }
}

/** UI modules must not evaluate their module-scope storage reads before restore. */
export async function bootstrapLegacyUiState(
  kv: MigrationSettingsKv,
  storage: () => MigrationStorage,
  startApp: () => Promise<unknown>,
): Promise<void> {
  try { await restoreLegacyUiState(kv, storage()) } catch { /* Storage access can be disabled. */ }
  await startApp()
}
