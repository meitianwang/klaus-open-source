// Host for the read-only keyboard-shortcuts dialog.
//
// `showKeyboardShortcuts` has a handler that flips a boolean, and the dialog
// renders only while it is true. One component owns the open state, the command
// handler sets it, and a window event offers the same opening to menu entries
// that arrive without a keyboard event.

import { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useCommandHandler } from './use-command-handler'
import { KeyboardShortcutsDialog } from './keyboard-shortcuts-dialog'

const OPEN_EVENT = 'klaus:show-keyboard-shortcuts'

function Host() {
  const [open, setOpen] = useState(false)
  // Returning nothing means "consumed" to the dispatcher, which is all a
  // handler that only ever opens needs.
  useCommandHandler('showKeyboardShortcuts', useCallback(() => { setOpen(true) }, []))

  useEffect(() => {
    const onEvent = () => setOpen(true)
    document.addEventListener(OPEN_EVENT, onEvent)
    return () => document.removeEventListener(OPEN_EVENT, onEvent)
  }, [])

  if (!open) return null
  return <KeyboardShortcutsDialog onClose={() => setOpen(false)} />
}

export function mountKeyboardShortcutsDialog(): void {
  // Reachable without a keyboard event, so a help menu can open the same dialog.
  (window as any).klausShowKeyboardShortcutsDialog = () => {
    document.dispatchEvent(new CustomEvent(OPEN_EVENT))
  }
  const host = document.createElement('span')
  host.id = 'keyboard-shortcuts-dialog-host'
  host.style.display = 'contents'
  document.body.appendChild(host)
  createRoot(host).render(<Host />)
}
