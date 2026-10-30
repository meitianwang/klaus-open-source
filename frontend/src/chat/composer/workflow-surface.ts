/** Cloned side composers accept messages and attachments without main workflow controls. */
export function removeSideWorkflowControls(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('#side-slash-menu, #side-composer-plus-menu, #side-composer-plus-submenu, #side-action-dots-host, #side-spec-banner, #side-goal-indicator, #side-planning-input-panel, #side-planning-decision-panel, #side-plan-mode-badge, #side-goal-mode-badge, #side-spec-mode-badge')
    .forEach(element => element.remove())
}

export interface GoalSurfaceSession {
  role?: string
  archived?: boolean
  threadSource?: string | null
  goalPursuitEligible?: boolean
  friendGroupId?: string | null
  hostMetadata?: { threadSource?: string; friendTask?: unknown }
}

/** Existing local goals keep controls that can stop or clear their work. */
export function goalSurfaceControlsAvailable(session: GoalSurfaceSession | null | undefined, externalChannel: boolean): boolean {
  return !externalChannel && session?.role !== 'side_task' && session?.archived !== true && session?.threadSource !== 'automation'
}

/** Pursuit is confined to ordinary conversations and never extends a bounded task. */
export function goalSurfaceEligible(session: GoalSurfaceSession | null | undefined, externalChannel: boolean): boolean {
  return goalSurfaceControlsAvailable(session, externalChannel) && session?.goalPursuitEligible !== false && session?.threadSource !== 'friend'
    && session?.hostMetadata?.threadSource !== 'friend' && !session?.hostMetadata?.friendTask && !session?.friendGroupId
}
