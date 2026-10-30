import { useCallback, useEffect, useState } from 'react'
import { useSettingsSnapshot } from './settings-snapshot'

export function useWebSourceAvailability(kind: 'search' | 'fetch' = 'search'): {
  availability: Record<string, boolean | undefined>
  failed: boolean
  seq: number
  reload: () => void
} {
  const [availability, , beginRead] = useSettingsSnapshot<Record<string, boolean | undefined>>(`web:${kind}:availability`, {})
  const [seq, setSeq] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    let sequence = 0
    const load = () => {
      const publish = beginRead()
      const mine = ++sequence
      void (window as any).settingsApi[kind === 'search' ? 'webSearchSources' : 'webFetchSources'].get()
        .then((reply: { availability?: Record<string, boolean> }) => {
          // A later event's read must win even when an earlier request lands
          // after it; without the sequence guard a stale login state would
          // re-disable a source the user just signed in to.
          if (!cancelled && mine === sequence) {
            if (!reply?.availability || typeof reply.availability !== 'object') throw Error('Invalid source availability')
            publish(reply.availability); setFailed(false)
          }
        })
        .catch(() => { if (!cancelled && mine === sequence) setFailed(true) })
    }
    load()
    window.addEventListener('klaus:auth-mode-changed', load)
    window.addEventListener('klaus:models-changed', load)
    return () => {
      cancelled = true
      window.removeEventListener('klaus:auth-mode-changed', load)
      window.removeEventListener('klaus:models-changed', load)
    }
  }, [kind, seq, beginRead])
  return { availability, failed, seq, reload: useCallback(() => setSeq(value => value + 1), []) }
}

