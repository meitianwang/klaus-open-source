import { Activity, createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import { flushSync } from 'react-dom'
import type { Root } from 'react-dom/client'

const visibilityEpoch = createContext(0)
const islandVisibility = createContext(true)

export function useRetainedVisibility(): boolean { return useContext(islandVisibility) }

/** Transient menus never reopen after their owning island has been hidden. */
export function useRetainedOpenState(initial = false): [boolean, Dispatch<SetStateAction<boolean>>] {
  const epoch = useContext(visibilityEpoch)
  const [state, setState] = useState({ epoch, open: initial })
  const open = state.epoch === epoch && state.open
  return [open, next => setState(previous => ({
    epoch, open: typeof next === 'function' ? next(previous.epoch === epoch && previous.open) : next,
  }))]
}

/** Pause React effects and portals without discarding the island's persistent state. */
export function mountRetainedIsland(root: Root, content: () => ReactNode) {
  let visible = true, disposed = false, epoch = 0
  const render = (mode: 'visible' | 'hidden' = visible ? 'visible' : 'hidden') => root.render(<Activity mode={mode}>
    <islandVisibility.Provider value={visible}>
      <visibilityEpoch.Provider value={epoch}>{content()}</visibilityEpoch.Provider>
    </islandVisibility.Provider>
  </Activity>)
  render()
  return {
    refresh() { if (!disposed) flushSync(render) },
    setVisible(value: boolean) {
      if (disposed || visible === value) return
      visible = value
      if (!value) {
        epoch++
        // Close transient portals before hidden work is deferred by Activity.
        flushSync(() => render('visible'))
      }
      flushSync(render)
    },
    dispose() {
      if (disposed) return
      disposed = true
      flushSync(() => root.unmount())
    },
  }
}
