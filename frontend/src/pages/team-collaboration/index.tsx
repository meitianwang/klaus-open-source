import { registerPageIsland } from '../../app/island'
import { TeamCollaborationPage } from './TeamCollaborationPage'
import { COLLABORATION_HIDE, COLLABORATION_REFRESH } from './data'
import './i18n'

registerPageIsland({
  name: 'team-collaboration',
  viewId: 'team-collaboration-view',
  containerId: 'team-collaboration-view-content',
  node: () => <TeamCollaborationPage />,
  onShow: () => window.dispatchEvent(new CustomEvent(COLLABORATION_REFRESH)),
  onHide: () => window.dispatchEvent(new CustomEvent(COLLABORATION_HIDE)),
})
