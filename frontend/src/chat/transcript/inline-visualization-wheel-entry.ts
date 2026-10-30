import { createBottomSticker } from '../bottom-sticker'
import { mountInlineVisualizations } from './inline-visualization'

const viewport = document.createElement('div')
viewport.id = 'wheel-viewport'
viewport.style.cssText = 'position:absolute;inset:20px auto auto 20px;width:760px;height:520px;overflow:auto;scroll-behavior:auto;'
document.body.appendChild(viewport)
const sticker = createBottomSticker({ scrollEl: viewport })
let guest = { root: 0, nested: 0, nestedLeft: 0, wheels: 0 }
let generation = 0
window.addEventListener('message', event => {
  if (event.source !== viewport.querySelector('iframe')?.contentWindow || event.data?.source !== 'wheel-fixture') return
  guest = event.data.position
})
const pause = () => new Promise(resolve => setTimeout(resolve, 80))
const api = {
  async mount(kind = 'plain', expanded = false) {
    const path = `/tmp/wheel-${++generation}.html`
    guest = { root: 0, nested: 0, nestedLeft: 0, wheels: 0 }
    viewport.replaceChildren()
    const before = document.createElement('div')
    before.style.height = '700px'
    const host = document.createElement('div')
    const paragraph = document.createElement('p')
    paragraph.textContent = `::klaus-inline-vis{path="${path}"}`
    host.appendChild(paragraph)
    const after = document.createElement('div')
    after.style.height = '60px'
    viewport.append(before, host, after)
    const contents = `<!doctype html><html><head><style>
      html,body{margin:0;${kind === 'native' ? '' : 'overscroll-behavior:none'}}body{height:${kind === 'capped' ? 14000 : 1600}px}
      #nested{position:absolute;bottom:100px;left:100px;width:400px;height:200px;overflow:auto;overscroll-behavior:contain}
    </style></head><body><div id="page">Page</div>
    ${kind === 'nested' ? '<div id="nested"><div style="height:900px">Scrollable panel</div></div>' : kind === 'horizontal' ? '<div id="nested"><div style="width:1200px;height:100px">Wide panel</div></div>' : ''}
    <script>
      let wheels = 0;
      const report = () => parent.postMessage({source:'wheel-fixture',position:{root:document.scrollingElement.scrollTop,nested:document.getElementById('nested')?.scrollTop || 0,nestedLeft:document.getElementById('nested')?.scrollLeft || 0,wheels}}, '*');
      addEventListener('wheel', () => { wheels++; setTimeout(report, 20); });
      addEventListener('scroll', report, true);
      addEventListener('message', event => { if(event.data?.source !== 'wheel-fixture') return; const node = event.data.target === 'nested' ? document.getElementById('nested') : document.scrollingElement; if(node) node.scrollTop=event.data.top; requestAnimationFrame(report); });
      addEventListener('load', report);
    </script></body></html>`
    mountInlineVisualizations(host, [{ path, contents }])
    for (let i = 0; i < 100; i++) {
      if (parseFloat((host.querySelector('.klaus-inline-vis-shell') as HTMLElement)?.style.height) >= 1600) break
      await new Promise(resolve => setTimeout(resolve, 15))
    }
    if (expanded) (host.querySelector('[data-klaus-inline-vis-expand]') as HTMLButtonElement).click()
    await new Promise(resolve => setTimeout(resolve, 250))
    sticker.scrollToBottom({ force: true, immediate: true })
    await pause()
    return api.read()
  },
  async position(target: string, top: number) {
    viewport.querySelector('iframe')?.contentWindow?.postMessage({ source: 'wheel-fixture', target, top }, '*')
    await pause()
    return api.read()
  },
  read() {
    const rect = viewport.querySelector('iframe')!.getBoundingClientRect()
    const point = { x: Math.round(rect.left + 150), y: Math.round(Math.min(rect.bottom - 150, 300)) }
    return { top: viewport.scrollTop, following: sticker.isFollowing(), guest: { ...guest }, point,
      hit: document.elementFromPoint(point.x, point.y)?.outerHTML.slice(0, 120), rect: { top: rect.top, bottom: rect.bottom } }
  },
  async collapse() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await new Promise(resolve => setTimeout(resolve, 250))
    sticker.scrollToBottom({ force: true, immediate: true })
    await pause()
    return api.read()
  },
  follow() { sticker.scrollToBottom({ immediate: true }); return api.read() },
}
;(window as any).inlineVisWheelFixture = api
