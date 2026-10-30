export interface WidgetInteractionRequest {
  sessionId: string
  toolCallId: string
  widgetId: string
  revision: number
  path: string
  title: string
  text: string
  submit: boolean
}

export interface WidgetInteractionDeps {
  isCurrent: (request: WidgetInteractionRequest) => Promise<boolean>
  confirm: (text: string) => Promise<boolean>
  appendDraft: (text: string) => void
  isBusy: () => boolean
  needsManualSend: () => boolean
  modelReady: () => Promise<boolean>
  queue: (text: string) => Promise<boolean>
  send: (text: string) => Promise<boolean>
  stale: () => void
  manual: () => void
}

export async function dispatchWidgetInteraction(request: WidgetInteractionRequest, deps: WidgetInteractionDeps): Promise<boolean> {
  if (!request || typeof request.text !== 'string' || !request.text.trim()
    || new TextEncoder().encode(request.text).length > 20 * 1024 || !await deps.isCurrent(request)) {
    deps.stale()
    return false
  }
  if (!request.submit) {
    deps.appendDraft(request.text)
    return true
  }
  if (!await deps.confirm(request.text)) return false
  if (!await deps.isCurrent(request)) { deps.stale(); return false }
  if (deps.isBusy()) return deps.queue(request.text)
  if (deps.needsManualSend()) {
    deps.appendDraft(request.text)
    deps.manual()
    return false
  }
  if (!await deps.modelReady() || !await deps.isCurrent(request)) return false
  if (deps.isBusy()) return deps.queue(request.text)
  if (deps.needsManualSend()) {
    deps.appendDraft(request.text)
    deps.manual()
    return false
  }
  return deps.send(request.text)
}
