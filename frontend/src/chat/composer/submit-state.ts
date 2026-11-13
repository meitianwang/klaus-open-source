export interface ComposerSubmitInput {
  ownerReady: boolean
  running: boolean
  stopping: boolean
  preparing?: boolean
  cancelled?: boolean
  goalPreparing?: boolean
  hasContent: boolean
  uploading: boolean
  waitingForUpload: boolean
  continueOffered: boolean
  continuing: boolean
  followUpMode: string
  escapeArmed?: boolean
}

/** Every conversation surface derives its submit affordance from the same state. */
export function composerSubmitState(input: ComposerSubmitInput) {
  const busy = input.running || !!input.preparing
  const runningSubmit = busy && !input.preparing && !input.stopping && !input.goalPreparing && input.hasContent
  const continuing = !busy && !input.stopping && input.continueOffered
  const waitingForUpload = input.uploading && input.waitingForUpload && (!busy || runningSubmit)
  const disabled = !input.ownerReady || input.stopping || !!input.cancelled
    || (!busy && input.goalPreparing === true)
    || (continuing ? input.continuing : !busy && (input.uploading || !input.hasContent))
  const label = input.stopping ? 'submit_tooltip_stopping'
    : waitingForUpload ? 'submit_tooltip_waiting_upload'
      : runningSubmit ? input.followUpMode === 'steer' ? 'submit_tooltip_steer' : 'submit_tooltip_queue'
        : busy ? 'submit_tooltip_stop'
          : continuing ? input.continuing ? 'submit_tooltip_continuing' : 'submit_tooltip_continue'
            : 'submit_tooltip_send'
  return { busy, runningSubmit, stopping: input.stopping, continuing,
    continuePending: continuing && input.continuing, disabled, label,
    awaitingUpload: waitingForUpload, escapeArmed: busy && !input.stopping && !runningSubmit && !!input.escapeArmed }
}

export function applyComposerSubmitState(button: HTMLButtonElement, state: ReturnType<typeof composerSubmitState>,
  translate: (key: string) => string, options: { tooltip: boolean }) {
  for (const [name, enabled] of Object.entries({ busy: state.busy, 'running-submit': state.runningSubmit,
    stopping: state.stopping, continue: state.continuing, continuing: state.continuePending,
    'awaiting-upload': state.awaitingUpload, 'esc-armed': state.escapeArmed })) button.classList.toggle(name, enabled)
  button.disabled = state.disabled
  button.setAttribute('aria-label', translate(state.label))
  if (options.tooltip) button.title = translate(state.label)
  else button.removeAttribute('title')
}
