// Browser permission questions, answered by the product's own dialog.
//
// A page inside the embedded browser can ask for a permission (geolocation,
// notifications, camera…). The host parks the question and pushes it here;
// this module shows it through the same dialog component every other
// confirmation in the window uses, and sends the answer back per requestId.
//
// The dialog is the only surface: an operating-system box would sit outside
// the window's theme and language and would not say which task's page asked.
import { tt } from './i18n'

interface PermissionRequest {
  requestId: string
  sessionId: string
  permission: string
  origin: string
  pageUrl: string
}

const api = () => (window as unknown as { klaus?: { browserUse?: Record<string, unknown> } }).klaus?.browserUse

// One dialog at a time: Chromium can ask for several permissions in the same
// tick (media splits into audio plus video), and stacking modal cards would
// make the user answer blind. Queue them instead.
const queue: PermissionRequest[] = []
let showing = false
let subscribed = false
let active: { requestId: string; controller: AbortController } | undefined

function fmt(key: string, vars: Record<string, string>): string {
  return tt(key).replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? '')
}

function answer(request: PermissionRequest, allowed: boolean): void {
  const surface = api()
  if (!surface?.answerPermission) return
  void (surface.answerPermission as (requestId: string, allowed: boolean) => Promise<unknown>)(request.requestId, allowed).catch(() => {})
}

function showNext(): void {
  if (showing) return
  const request = queue.shift()
  if (!request) return
  showing = true
  const controller = new AbortController()
  active = { requestId: request.requestId, controller }
  const dialog = (window as unknown as { klausDialog?: { confirm(opts: unknown): Promise<unknown> } }).klausDialog
  const resource = request.permission.startsWith('browser:') ? request.permission.slice('browser:'.length) : undefined
  const settled = dialog
    ? dialog.confirm({
        title: tt(resource ? 'browser_access_prompt_title' : 'browser_permission_title'),
        message: fmt(resource ? 'browser_access_prompt_message' : 'browser_permission_message',
          { origin: request.origin, permission: resource ? tt(`browser_access_${resource}`) : request.permission }),
        detail: tt(resource ? 'browser_access_prompt_detail' : 'browser_permission_detail'),
        confirmText: tt('browser_permission_allow'),
        cancelText: tt('cancel'),
        signal: controller.signal,
      })
    : Promise.resolve(false)
  void settled
    .then(result => { answer(request, result === true) })
    .catch(() => { answer(request, false) })
    .finally(() => { active = undefined; showing = false; showNext() })
}

export function mountBrowserPermissionDialogs(): void {
  if (subscribed) return
  const surface = api()
  if (!surface?.onPermissionRequest) return
  subscribed = true
  ;(surface.onPermissionRequest as (cb: (request: PermissionRequest) => void) => () => void)(request => {
    if (!request || typeof request.requestId !== 'string') return
    queue.push(request)
    showNext()
  })
  ;(surface.onPermissionCancelled as undefined | ((cb: (event: { requestId: string }) => void) => () => void))?.(event => {
    for (let index = queue.length - 1; index >= 0; index--) if (queue[index]?.requestId === event.requestId) queue.splice(index, 1)
    if (active?.requestId === event.requestId) active.controller.abort()
  })
}

mountBrowserPermissionDialogs()
