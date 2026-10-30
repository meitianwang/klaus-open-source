import { registerPageIsland } from '../../app/island'
import { ProfilePage, PROFILE_VISIBLE_EVENT } from './ProfilePage'

registerPageIsland({
  name: 'profile', viewId: 'profile-view', containerId: 'profile-view-content', node: () => <ProfilePage />,
  onShow: () => {
    ;(window as any).closeSettings?.()
    window.dispatchEvent(new CustomEvent(PROFILE_VISIBLE_EVENT, { detail: { visible: true } }))
  },
  onHide: () => window.dispatchEvent(new CustomEvent(PROFILE_VISIBLE_EVENT, { detail: { visible: false } })),
})
