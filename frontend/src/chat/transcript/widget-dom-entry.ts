import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { ActivityToolContent } from './activity-tool'
import { dispatchWidgetInteraction } from '../widget-interaction'

const fixture = (window as any).fixtureWidget as { snapshot: any; url: string }
const { snapshot, url } = fixture
const calls = { url: 0, confirm: 0, draft: [] as string[], send: [] as string[], stale: 0 }
;(window as any).currentSessionId = snapshot.sessionId
;(window as any).klaus = { artifacts: { widgetUrl: async () => {
  calls.url++
  return { ok: true, url, currentRevision: snapshot.revision }
} } }
;(window as any).klausHandleWidgetInteraction = (request: any) => dispatchWidgetInteraction(request, {
  isCurrent: async (value: any) => value.sessionId === snapshot.sessionId && value.widgetId === snapshot.widgetId && value.revision === snapshot.revision,
  confirm: async () => { calls.confirm++; return true },
  appendDraft: (text: string) => { calls.draft.push(text) },
  isBusy: () => false,
  needsManualSend: () => false,
  modelReady: async () => true,
  queue: async () => false,
  send: async (text: string) => { calls.send.push(text); return true },
  stale: () => { calls.stale++ },
  manual: () => {},
})
let observedOrigin = ''
let observedSource = false
window.addEventListener('message', event => {
  if (event.data?.type === 'klaus-widget:send') {
    observedOrigin = event.origin
    observedSource = event.source === document.querySelector('iframe')?.contentWindow
  }
})
const root = createRoot(document.getElementById('root')!)
const tool = (state: 'running' | 'done') => ({ toolCallId: snapshot.toolCallId, toolName: 'show_widget',
  sessionId: snapshot.sessionId, state, args: { title: snapshot.title },
  output: JSON.stringify({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(snapshot) }] }) })
const render = (state: 'running' | 'done') => flushSync(() => root.render(createElement(ActivityToolContent, {
  tool: tool(state), open: false, onToggle: () => {}, locale: 'en',
})))
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 15))
  if (!predicate()) throw new Error('Widget end-to-end DOM timed out')
}
const checks: Record<string, boolean> = {}
async function main() {
  render('running')
  checks.pendingNoIframe = calls.url === 0 && document.querySelector('iframe') === null
  render('done')
  await waitFor(() => document.querySelector('iframe') !== null)
  const frame = document.querySelector('iframe')!
  checks.hostCapabilityInSandbox = calls.url === 1 && frame.getAttribute('src') === url
    && frame.getAttribute('sandbox') === 'allow-scripts allow-forms'
  await waitFor(() => calls.draft.length === 1)
  checks.draftDoesNotSend = calls.send.length === 0 && calls.confirm === 0
  await waitFor(() => calls.send.length === 1)
  checks.opaqueSourceAccepted = observedOrigin === 'null' && observedSource
  checks.topLevelConfirmed = calls.confirm === 1 && calls.send[0] === `[Widget: ${snapshot.title}]\n{"count":2}`
  checks.firstMessageWasDraft = calls.draft[0] === `[Widget: ${snapshot.title}]\n{"count":1}`
  checks.noStaleOrForeignAction = calls.stale === 0
  document.getElementById('result')!.textContent = JSON.stringify(checks)
}
main().catch(error => { document.getElementById('result')!.textContent = JSON.stringify({ error: String(error), calls }) })
