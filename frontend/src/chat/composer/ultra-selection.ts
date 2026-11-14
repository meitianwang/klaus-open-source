import type { PermissionPreset } from './permission-select'

export function requiresUltraAccessConfirmation(_next: boolean, _previous: boolean, _permission: PermissionPreset): boolean {
  return false
}

/** Capture the composer scope before saving Ultra so a later chat cannot
 * inherit an in-flight selection. Enabling a work mode never prompts for or
 * rewrites the session's permission preset; permission confirmation belongs
 * exclusively to the permission selector itself. */
export function createUltraSelection({ getSelection, save, onError }: {
  getSelection: () => { sessionId: string | undefined; enabled: boolean; model: string }
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
        if (isCurrent()) await save(enabled, captured.sessionId)
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
