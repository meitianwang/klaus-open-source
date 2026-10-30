// Command menu host: mounts the global search panel behind the
// titlebar search button. Entry is the button only — no keyboard chords are
// registered anywhere; inside the panel the input keeps ordinary combobox
// behaviour (arrow keys, Enter, Escape).
//
// The button opens the panel with chat-search intent: "Search chats" placeholder,
// Chats group, Quick actions below.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { openWorkspaceFilePath } from '../workspace-panel'
import { CommandMenu, type CommandMenuDeps } from './command-menu'
import type { CommandMenuMode } from './model'

interface HostState {
  open: boolean
  mode: CommandMenuMode
  intent: boolean
  query: string
  highlighted: number | null
}

function api(): any {
  return (window as any).klausCommandMenu
}

function Host() {
  const [state, setState] = useState<HostState>({ open: false, mode: 'root', intent: false, query: '', highlighted: 0 })

  const close = useCallback(() => setState(prev => ({ ...prev, open: false })), [])

  const deps: CommandMenuDeps = useMemo(() => ({
    sessions: () => api()?.sessions?.() ?? [],
    switchSession: (id: string) => { (window as any).klausSwitchSession?.(id) },
    newChat: () => { api()?.newChat?.() },
    openFolder: () => { api()?.openFolder?.() },
    openFile: (path: string) => { openWorkspaceFilePath(path) },
  }), [])

  useEffect(() => {
    const button = document.getElementById('titlebar-search')
    if (!button) return
    const onClick = () => setState(prev => prev.open && prev.intent
      ? { ...prev, open: false }
      : { open: true, mode: 'root', intent: true, query: '', highlighted: 0 })
    button.addEventListener('click', onClick)
    return () => button.removeEventListener('click', onClick)
  }, [])

  // Programmatic entry for the keybinding commands. `openCommandMenu` (⌘K) opens
  // the unified root panel without chat-search intent;
  // `searchFiles` opens straight into file mode. Both live on window so the
  // keybinding runtime (a plain module) can reach them.
  useEffect(() => {
    const w = window as any
    w.klausOpenCommandMenu = () => setState({ open: true, mode: 'root', intent: false, query: '', highlighted: 0 })
    w.klausOpenCommandMenuInFilesMode = () => setState({ open: true, mode: 'files', intent: false, query: '', highlighted: 0 })
    return () => { delete w.klausOpenCommandMenu; delete w.klausOpenCommandMenuInFilesMode }
  }, [])

  return (
    <CommandMenu
      open={state.open}
      mode={state.mode}
      chatSearchIntent={state.intent}
      query={state.query}
      highlighted={state.highlighted}
      deps={deps}
      onQueryChange={query => setState(prev => ({ ...prev, query, highlighted: 0 }))}
      onModeChange={mode => setState(prev => ({ ...prev, mode, query: '', highlighted: 0 }))}
      onHighlightedChange={highlighted => setState(prev => ({ ...prev, highlighted }))}
      onClose={close}
    />
  )
}

export function mountCommandMenu(): void {
  const host = document.getElementById('command-menu-host')
  if (!host) return
  createRoot(host).render(<Host />)
}
