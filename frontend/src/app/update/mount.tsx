// Mounts the update surfaces once per renderer. The persistent card lives above
// the sidebar footer so available, downloading, and ready offers stay reachable
// without interrupting the user; the installation modal portals to the body.
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { UpdateBanner, UpdateOverlays, useUpdateSnapshot } from './components'
import { startUpdateNotices } from './store'

function SidebarUpdateCard() {
  const { status, surfaces, downloadRequested, installRequested } = useUpdateSnapshot()
  return <UpdateBanner status={status} surfaces={surfaces} pending={installRequested} downloadingPending={downloadRequested} />
}

let cardRoot: Root | null = null
let overlayRoot: Root | null = null

export function mountUpdateNotices(): void {
  if (typeof document === 'undefined' || cardRoot || overlayRoot) return
  startUpdateNotices()
  const cardHost = document.getElementById('sidebar-update-card')
  if (cardHost) {
    cardRoot = createRoot(cardHost)
    // Commit synchronously: an async first frame would leave the sidebar footer
    // jumping when a transfer is already running at boot.
    flushSync(() => cardRoot?.render(<SidebarUpdateCard />))
  }
  const overlayHost = document.createElement('div')
  overlayHost.id = 'update-overlay-host'
  document.body.appendChild(overlayHost)
  overlayRoot = createRoot(overlayHost)
  flushSync(() => overlayRoot?.render(<UpdateOverlays />))
}

/** Test seam and teardown: unmount both hosts and drop their roots. */
export function unmountUpdateNotices(): void {
  cardRoot?.unmount(); cardRoot = null
  overlayRoot?.unmount(); overlayRoot = null
  document.getElementById('update-overlay-host')?.remove()
}
