import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { FinalAssistantBubble, LiveTail, TranscriptView } from './TranscriptView'
import { openSiteReference, replaceSiteReferences, websiteReferencesFromText } from '../site-references'
import { setOverviewDeps } from '../overview/shared'
import { renderArtifactsSection } from '../overview/artifacts'
import { createTurnNavigationController } from '../turn-navigation'
import { t } from '../../i18n'
import { chatStreamStore, selectSessionStream } from '../stream-store'

const w = window as any
w.currentLang = 'zh'
w.siteFixture = { calls: [], toasts: [], preferred: 'in-app', delay: 0, failOpen: false, failTargets: false, failCopy: false }
const state = w.siteFixture
w.showToast = (text: string) => state.toasts.push(text)
w.klaus = {
  browser: {
    siteOpenTargets: async () => {
      await new Promise(resolve => setTimeout(resolve, state.delay))
      if (state.failTargets) throw new Error('probe failed')
      return { preferredTarget: state.preferred, targets: [
        { id: 'in-app', kind: 'in-app', name: 'Klaus' },
        // The harness main process injects the real official artwork it reads
        // through the host's own icon code; tiles are a last-resort stand-in.
        { id: 'chrome', kind: 'named', name: 'Google Chrome', ...(state.chromeIcon ? { iconDataUrl: state.chromeIcon } : {}) },
        { id: 'system-default', kind: 'system-default', name: '', isDefault: true, ...(state.defaultIcon ? { iconDataUrl: state.defaultIcon } : {}) },
      ] }
    },
    openSite: async (request: any) => {
      state.calls.push(request)
      if (state.failOpen) throw new Error('launch refused')
      state.preferred = request.target || state.preferred
      return { ok: true, target: state.preferred }
    },
  },
  clipboard: { writeText: async (text: string) => { if (state.failCopy) throw new Error('copy refused'); state.calls.push({ copy: text }) } },
}
const references = websiteReferencesFromText('[Preview](http://localhost:3000)', 'turn-a')
setOverviewDeps({ currentSessionId: () => 'saved-session', escapeHtml: (s: string) => s, specDocuments: () => [], subscribeSpecDocuments: () => () => {} } as any)
replaceSiteReferences('saved-session', references)
renderArtifactsSection()
const root = createRoot(document.getElementById('message')!)
root.render(createElement(FinalAssistantBubble, { sessionId: 'saved-session', text: '已打开：[好友页面预览](http://localhost:3000)。', turnId: 'turn-a', actionsHtml: '<div class="msg-actions" data-copy-text="">Copy · Quote</div>' }))
state.openSiteReference = openSiteReference
state.replace = replaceSiteReferences
state.frames = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => requestAnimationFrame(resolve)) }
state.mountNavigation = () => {
  state.navigation = createTurnNavigationController({ scrollEl: document.getElementById('scroll'), railEl: document.getElementById('rail'), listEl: document.getElementById('rail-list'), tooltipEl: document.getElementById('nav-preview'), translate: key => t(key) })
  state.navigation?.setChatActive(true)
}

const liveHost = document.createElement('div')
liveHost.id = 'live-regression'
liveHost.hidden = true
document.body.appendChild(liveHost)
const liveRoot = createRoot(liveHost)
state.renderLive = () => {
  const previous = chatStreamStore.getState()
  chatStreamStore.setState({ sessions: { ...previous.sessions, 'live-session': {
    ...selectSessionStream(previous, 'live-session'), running: false, liveTurnId: 'live-turn',
    liveUnits: [
      { type: 'live-text', key: 'commentary', turnId: 'live-turn', phase: 'commentary', text: '[Earlier preview](http://localhost:3000)', streaming: false },
      { type: 'live-text', key: 'final', turnId: 'live-turn', phase: 'final_answer', text: 'Done.', streaming: false, turnTail: { ts: Date.now(), meta: null } },
    ],
  } } })
  liveRoot.render(createElement(LiveTail, { sessionId: 'live-session', unitProps: {
    sessionId: 'live-session', isThinkingExpanded: () => false, onToggleThinking: () => {}, archived: false,
    running: false, composerAuthored: false, readOnly: false, editTarget: null,
  } as any }))
}
const childHost = document.createElement('div')
childHost.id = 'child-regression'
childHost.hidden = true
document.body.appendChild(childHost)
const childRoot = createRoot(childHost)
state.renderChild = () => {
  const previous = chatStreamStore.getState()
  chatStreamStore.setState({ sessions: { ...previous.sessions, 'child-session': {
    ...selectSessionStream(previous, 'child-session'), history: [
      { role: 'user', uuid: 'child-user', turnId: 'child-turn', text: 'Build a site' },
      { role: 'assistant', uuid: 'child-assistant', turnId: 'child-turn', text: '[Child site](https://child.example)', isFinalReply: true },
    ],
  } } })
  childRoot.render(createElement(TranscriptView, { sessionId: 'child-session', container: childHost, readOnly: true, contextSessionId: 'saved-session' }))
}
