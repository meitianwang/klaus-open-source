import { registerPageIsland } from '../../app/island'
import { FriendsPage, FRIENDS_PAGE_VISIBLE_EVENT } from './FriendsPage'
import { updateFriendsRuntime } from './runtime-state'

registerPageIsland({
  name: 'friends',
  viewId: 'friends-view',
  containerId: 'friends-view-content',
  node: () => <FriendsPage />,
  onShow: () => {
    ;(window as any).closeSettings?.()
    window.dispatchEvent(new CustomEvent(FRIENDS_PAGE_VISIBLE_EVENT, { detail: { visible: true } }))
  },
  onHide: () => {
    window.dispatchEvent(new CustomEvent(FRIENDS_PAGE_VISIBLE_EVENT, { detail: { visible: false } }))
  },
})

// The sidebar owns every friend attention badge: the group row carries the
// pending-request and unread-message count. This island only keeps the page's
// own runtime snapshot current across auth and inbox changes.
async function refreshFriendsRuntime() {
  try {
    updateFriendsRuntime(await window.klaus.friends.runtime())
  } catch {
    updateFriendsRuntime(null)
  }
}
window.klaus.on.friendsChanged(() => void refreshFriendsRuntime())
window.klaus.on.klausAuthUpdated(() => { updateFriendsRuntime(null); void refreshFriendsRuntime() })
window.addEventListener('focus', () => void refreshFriendsRuntime())
void refreshFriendsRuntime()
