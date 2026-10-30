import { useCallback, useEffect, useState } from 'react'
import { useAccountId } from './data'
import { emptyProjectPreferences, parseProjectPreferences, projectPreferencesKey, type ProjectPreferences } from './project-model'
import { t } from './i18n'

export function useProjectPreferences() {
  const accountId = useAccountId()!
  const key = projectPreferencesKey(accountId)
  const [state, setState] = useState(() => {
    try { return { preferences: parseProjectPreferences(localStorage.getItem(key)), error: '' } }
    catch { return { preferences: emptyProjectPreferences(), error: t('tc_preferences_failed') } }
  })
  const update = useCallback((change: (current: ProjectPreferences) => ProjectPreferences) => {
    setState(current => {
      const preferences = change(current.preferences)
      try { localStorage.setItem(key, JSON.stringify(preferences)); return { preferences, error: '' } }
      catch { return { preferences, error: t('tc_preferences_failed') } }
    })
  }, [key])
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== key) return
      try { setState({ preferences: parseProjectPreferences(event.newValue), error: '' }) }
      catch { setState(current => ({ ...current, error: t('tc_preferences_failed') })) }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [key])
  return { ...state, update }
}
