import { t } from '../../i18n'
import { mountStaticIcons } from '../../icons/static-mount'

const w = window as any
const panel = document.getElementById('artifacts-panel')!
const collapse = document.getElementById('artifacts-panel-toggle-inner')!
const toggle = document.getElementById('artifacts-panel-toggle')!
document.getElementById('app')!.style.visibility = 'visible'
panel.style.transition = 'none'
w.tt = t

function setPanel(open: boolean, mode = 'diff') {
  panel.dataset.mode = mode
  panel.classList.toggle('collapsed', !open)
  document.body.classList.toggle('artifacts-open', open)
  collapse.style.display = open ? '' : 'none'
  toggle.style.display = open ? 'none' : ''
  w.KlausPanelTabs?.onModeChanged(mode)
}
w.enterDiffArtifactsPanel = () => setPanel(true)
w.exitDiffArtifactsPanel = () => setPanel(false, 'monitor')
w.klausOpenDiffPanel = () => w.showDiffView({ source: 'branch' })
w.klausOpenMonitorPanel = () => { w.deactivateDiffView(); setPanel(true, 'monitor') }
document.getElementById('btn-diff')!.onclick = w.klausOpenDiffPanel
collapse.onclick = () => w.hideDiffView()
document.documentElement.style.setProperty('--artifacts-panel-width', '560px')

void (async () => {
  await import('../../chat/panels/panel-tabs')
  await import('./diff-changes-dom-entry')
  mountStaticIcons()
  w.changesShellFixture = {
    outerScrollRange(enabled: boolean) {
      document.getElementById('outer-scroll-range')?.remove()
      if (enabled) {
        // A flow-based auxiliary host makes unintended root scrolling observable.
        const host = document.createElement('div')
        host.id = 'outer-scroll-range'; host.style.height = '128px'; host.setAttribute('aria-hidden', 'true')
        document.body.appendChild(host)
      }
    },
    resetScroll() {
      for (const node of [document.documentElement, document.body, ...document.querySelectorAll('#app,#artifacts-panel,.artifacts-body,#diff-view,#diff-view-content')]) {
        node.scrollTop = 0; node.scrollLeft = 0
      }
    },
    geometry() {
      const rect = (node: Element | null) => { const box = node?.getBoundingClientRect(); return box ? { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height } : null }
      const visible = (node: Element | null) => {
        const box = node?.getBoundingClientRect()
        if (!node || !box || !box.width || !box.height || box.top < 0 || box.bottom > innerHeight) return false
        const target = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return target === node || node.contains(target)
      }
      return {
        viewport: { width: innerWidth, height: innerHeight }, app: rect(document.getElementById('app')),
        sidebar: rect(document.getElementById('sidebar')), header: rect(panel.querySelector('.artifacts-header')),
        reviewScroll: document.querySelector('[data-review-scroll]')?.scrollTop ?? 0,
        ancestors: [document.documentElement, document.body, ...document.querySelectorAll('#app,#artifacts-panel,.artifacts-body,#diff-view,#diff-view-content')].map(node => ({ name: node.id || node.tagName, top: node.scrollTop, left: node.scrollLeft })),
        collapseVisible: visible(collapse), railVisible: visible(document.getElementById('btn-diff')),
        bodyClass: document.body.className, rail: rect(document.getElementById('btn-diff')),
        railHit: (() => { const box = document.getElementById('btn-diff')!.getBoundingClientRect(); const node = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return node ? { id: node.id, className: node.getAttribute('class') } : null })(),
        tabLabels: Array.from(panel.querySelectorAll('[role=tab]')).filter(visible).map(node => node.textContent),
      }
    },
  }
})()
