import type { PermissionPreset } from './permission-select'

export type UltraAccessDecision = 'full-access' | 'restricted' | 'cancel'

export function requiresUltraAccessConfirmation(next: boolean, previous: boolean, permission: PermissionPreset): boolean {
  return next && !previous && permission === 'bypassPermissions'
}

/** Capture the composer scope before opening a dialog; a later chat cannot
 * inherit either the selection or the permission change from that dialog. */
export function createUltraSelection({ getSelection, getPermission, confirm, save, onError }: {
  getSelection: () => { sessionId: string | undefined; enabled: boolean; model: string }
  getPermission: () => Promise<{ mode: PermissionPreset }>
  confirm: () => Promise<UltraAccessDecision>
  save: (enabled: boolean, sessionId: string | undefined, permissionMode?: PermissionPreset) => Promise<void>
  onError: (error: unknown) => void
}) {
  let revision = 0
  return {
    invalidate() { revision++ },
    async choose(enabled: boolean) {
      const requestRevision = ++revision
      const captured = getSelection()
      const isCurrent = () => {
        const current = getSelection()
        return revision === requestRevision && captured.sessionId === current.sessionId
          && captured.enabled === current.enabled && captured.model === current.model
      }
      try {
        let permissionMode: PermissionPreset | undefined
        if (enabled && !captured.enabled) {
          const permission = await getPermission()
          if (!isCurrent()) return
          if (requiresUltraAccessConfirmation(enabled, captured.enabled, permission.mode)) {
            const decision = await confirm()
            if (!isCurrent() || decision === 'cancel') return
            if (decision === 'restricted') permissionMode = 'default'
          }
        }
        if (isCurrent()) await save(enabled, captured.sessionId, permissionMode)
      } catch (error) {
        if (isCurrent()) onError(error)
      }
    },
  }
}

/** Native reasoning picks change only the provider effort: no confirmation and
 * no permission preset rides along, because the orchestration mode owns those. */
export function createThinkingSelection({ getSelection, save, onError }: {
  getSelection: () => { sessionId: string | undefined; level: string; model: string }
  save: (level: string, sessionId: string | undefined) => Promise<void>
  onError: (error: unknown) => void
}) {
  let revision = 0
  return {
    invalidate() { revision++ },
    async choose(level: string) {
      const requestRevision = ++revision
      const captured = getSelection()
      const isCurrent = () => {
        const current = getSelection()
        return revision === requestRevision && captured.sessionId === current.sessionId
          && captured.level === current.level && captured.model === current.model
      }
      try {
        if (isCurrent()) await save(level, captured.sessionId)
      } catch (error) {
        if (isCurrent()) onError(error)
      }
    },
  }
}
