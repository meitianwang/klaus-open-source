// Synapse 覆盖层（迁自 js/memory-view.js）：命令式 SVG 层——
// (1) 贯穿所有神经元标记的纵向「纤维」（替代旧 border-left 沟线），
// (2) 任意两行触及同一记忆文件时的弧形突触（轴突末梢球 + 突触间隙 + 受体点），
// (3) 6-12s 随机放电脉冲（SMIL animateMotion 沿路径行进）。
//
// 位置每次从 DOM 实测（行高随 vivid/faint、侧栏折叠、字号缩放变化），
// 不做解析计算。宿主是 React 之外的独立层：挂在组件提供的 host 元素内，
// React 永不触碰其子树。
import styles from './memory.module.css'
import type { DreamRun } from './data'

const SVG_NS = 'http://www.w3.org/2000/svg'
// Cap edges to keep gutter readable — sorted by sharedFiles count desc.
const MAX_SYNAPSES = 60
// Cleft gap (px from receiver's neuron-core center). Small but visible.
const CLEFT_GAP = 5

interface SynapseEl {
  syn: { from: number; to: number; weight: number }
  path: SVGPathElement
  term: SVGCircleElement
  rec: SVGCircleElement
  pathId: string
  fromTaskId: string
  toTaskId: string
}

let pulseTimer: ReturnType<typeof setTimeout> | null = null
let activeSynapses: SynapseEl[] = []

export function stopSynapsePulses(): void {
  if (pulseTimer) {
    clearTimeout(pulseTimer)
    pulseTimer = null
  }
}

/** 行 hover → 高亮锚定在该行上的突触（React 行的 onMouseEnter/Leave 调用）。 */
export function highlightSynapsesForRow(taskId: string, on: boolean): void {
  for (const s of activeSynapses) {
    if (s.fromTaskId === taskId || s.toTaskId === taskId) {
      s.path.classList.toggle('is-active', on)
      s.term.classList.toggle('is-active', on)
    }
  }
}

// Deterministic hash for stable per-id wobble in the gutter path.
function hashStr(s: string): number {
  let h = 0
  for (let i = 0; i < (s || '').length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

export interface SynapseRenderInput {
  /** SVG 层宿主（React ref 元素，子树归本模块独管）。 */
  host: HTMLElement
  /** 行定位容器（.memory-history，绝对层的 containing block）。 */
  container: HTMLElement
  runsById: Map<string, DreamRun>
  isVisible: () => boolean
}

export function renderSynapses({ host, container, runsById, isVisible }: SynapseRenderInput): void {
  // Drop any prior overlay before rebuilding.
  host.querySelectorAll(`.${styles['memory-synapse-layer']}`).forEach(n => n.remove())
  stopSynapsePulses()
  activeSynapses = []

  const rows = Array.from(container.querySelectorAll<HTMLElement>(`.${styles['memory-history-row']}`))
  if (rows.length === 0) return

  // Measure each marker's center relative to container's content box.
  // We use the .neuron-core circle inside the marker SVG for sub-pixel
  // accuracy — that's the spot a synapse actually targets.
  const containerRect = container.getBoundingClientRect()
  const markers: Array<{ row: HTMLElement; taskId: string; x: number; y: number; files: string[] }> = []
  for (const row of rows) {
    const core = row.querySelector('.neuron-core')
    if (!core) continue
    const r = core.getBoundingClientRect()
    const taskId = row.dataset.taskId || ''
    const run = runsById.get(taskId)
    markers.push({
      row,
      taskId,
      x: r.left - containerRect.left + r.width / 2,
      y: r.top - containerRect.top + r.height / 2,
      files: run?.filesTouched ?? [],
    })
  }
  if (markers.length === 0) return

  // Build synapses: for each pair of rows that share at least one touched
  // memory file. Sort by sharedCount desc and cap.
  const synapses: Array<{ from: number; to: number; weight: number }> = []
  for (let i = 0; i < markers.length; i++) {
    const a = markers[i]
    if (!a.files.length) continue
    const aSet = new Set(a.files)
    for (let j = i + 1; j < markers.length; j++) {
      const b = markers[j]
      if (!b.files.length) continue
      let shared = 0
      for (const f of b.files) if (aSet.has(f)) shared++
      if (shared > 0) synapses.push({ from: i, to: j, weight: shared })
    }
  }
  synapses.sort((x, y) => y.weight - x.weight)
  const trimmed = synapses.slice(0, MAX_SYNAPSES)

  // ─── Build SVG ─────────────────────────────────────────────────────
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', styles['memory-synapse-layer'])
  svg.setAttribute('xmlns', SVG_NS)

  // Vertical gutter "fiber". A long path that wends slightly through all
  // marker x positions — gives an organic look (not a rigid line).
  {
    const gutter = document.createElementNS(SVG_NS, 'path')
    gutter.setAttribute('class', styles['memory-synapse-gutter'])
    const gutterX = markers[0].x
    const top = Math.max(0, markers[0].y - 14)
    const bottom = markers[markers.length - 1].y + 14
    // Cubic curves between consecutive marker y values, with a small ±2px
    // x wobble to read as biological filament instead of CAD line.
    let d = `M ${gutterX.toFixed(1)} ${top.toFixed(1)}`
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i]
      const wobble = ((hashStr(m.taskId) % 100) / 100 - 0.5) * 4 // ±2px
      const cx = gutterX + wobble
      const py = i === 0 ? top : markers[i - 1].y
      const midY = (py + m.y) / 2
      d += ` C ${gutterX.toFixed(1)} ${midY.toFixed(1)}, ${cx.toFixed(1)} ${midY.toFixed(1)}, ${gutterX.toFixed(1)} ${m.y.toFixed(1)}`
    }
    d += ` L ${gutterX.toFixed(1)} ${bottom.toFixed(1)}`
    gutter.setAttribute('d', d)
    svg.appendChild(gutter)
  }

  // Synapse paths + axon terminals + receptor dots.
  const synapseEls: SynapseEl[] = []
  for (const syn of trimmed) {
    const a = markers[syn.from]
    const b = markers[syn.to]
    // The axon bows OUT to the left (negative x deflection) so multiple
    // synapses don't overlap the gutter line. Stronger bow for stronger
    // weight (more shared files → fatter arc).
    const bow = 12 + Math.min(syn.weight, 4) * 4
    const cpX = a.x - bow
    const cpY = (a.y + b.y) / 2

    // Compute the cleft endpoint — stop short of marker b's core by
    // CLEFT_GAP px along the curve's exit direction (approximated by the
    // chord from cp to b).
    const dx = b.x - cpX
    const dy = b.y - cpY
    const len = Math.hypot(dx, dy) || 1
    const t = (len - CLEFT_GAP) / len
    const endX = cpX + dx * t
    const endY = cpY + dy * t

    const pathId = `synapse-${a.taskId}-${b.taskId}`.replace(/[^a-z0-9_-]/gi, '_')
    const path = document.createElementNS(SVG_NS, 'path') as SVGPathElement
    path.setAttribute('class', styles['memory-synapse-path'])
    path.setAttribute('id', pathId)
    path.setAttribute('data-from', a.taskId)
    path.setAttribute('data-to', b.taskId)
    path.setAttribute('d', `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cpX.toFixed(1)} ${cpY.toFixed(1)} ${endX.toFixed(1)} ${endY.toFixed(1)}`)
    svg.appendChild(path)

    // Axon terminal bulb at the cleft end.
    const term = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement
    term.setAttribute('class', styles['memory-synapse-terminal'])
    term.setAttribute('data-from', a.taskId)
    term.setAttribute('data-to', b.taskId)
    term.setAttribute('cx', endX.toFixed(1))
    term.setAttribute('cy', endY.toFixed(1))
    term.setAttribute('r', '1.6')
    svg.appendChild(term)

    // Receptor dot on the receiving neuron's side. Sits a tiny bit further
    // along (closer to b's core) than the terminal — represents the
    // dendritic spine across the synaptic cleft.
    const recX = cpX + dx * (t + (CLEFT_GAP * 0.5) / len)
    const recY = cpY + dy * (t + (CLEFT_GAP * 0.5) / len)
    const rec = document.createElementNS(SVG_NS, 'circle') as SVGCircleElement
    rec.setAttribute('class', styles['memory-synapse-receptor'])
    rec.setAttribute('data-target', b.taskId)
    rec.setAttribute('cx', recX.toFixed(1))
    rec.setAttribute('cy', recY.toFixed(1))
    rec.setAttribute('r', '1.2')
    svg.appendChild(rec)

    synapseEls.push({ syn, path, term, rec, pathId, fromTaskId: a.taskId, toTaskId: b.taskId })
  }

  host.appendChild(svg)
  activeSynapses = synapseEls

  // Start the ambient pulse loop.
  startSynapsePulses(svg, synapseEls, isVisible)
}

// ─── Pulse animation ──────────────────────────────────────────────────
// Every 6-12 seconds, pick one random synapse and "fire" it — a tiny bright
// dot travels from the source neuron's nucleus along the axon path to the
// cleft, then the receiving neuron's receptor briefly lights up. Only one
// active pulse at a time. Pauses while the memory view is hidden.

function startSynapsePulses(svg: SVGSVGElement, synapseEls: SynapseEl[], isVisible: () => boolean): void {
  stopSynapsePulses()
  if (synapseEls.length === 0) return

  function schedule(extra = 0) {
    // 6-12s gap, +extra slack when we skipped a tick (e.g. view hidden).
    const delay = 6000 + Math.random() * 6000 + extra
    pulseTimer = setTimeout(fire, delay)
  }

  function fire() {
    pulseTimer = null
    if (!isVisible()) { schedule(2000); return }
    if (!svg.isConnected) return // overlay was replaced — stop
    // Weighted pick — synapses with more shared files fire slightly more
    // often (stronger connection, more "active" thread of memory).
    const totalWeight = synapseEls.reduce((sum, s) => sum + (s.syn.weight || 1), 0)
    let pick = Math.random() * totalWeight
    let chosen = synapseEls[0]
    for (const s of synapseEls) {
      pick -= (s.syn.weight || 1)
      if (pick <= 0) { chosen = s; break }
    }
    firePulseAlong(svg, chosen)
    schedule()
  }

  schedule(1500 + Math.random() * 1500)
}

function firePulseAlong(svg: SVGSVGElement, syn: SynapseEl): void {
  const pulse = document.createElementNS(SVG_NS, 'circle')
  pulse.setAttribute('class', styles['memory-synapse-pulse'])
  pulse.setAttribute('r', '1.7')

  // SMIL animateMotion follows the synapse path exactly.
  const am = document.createElementNS(SVG_NS, 'animateMotion') as SVGElement & { beginElement?: () => void }
  am.setAttribute('dur', '1.4s')
  am.setAttribute('repeatCount', '1')
  am.setAttribute('fill', 'freeze')
  const mpath = document.createElementNS(SVG_NS, 'mpath')
  mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#' + syn.pathId)
  mpath.setAttribute('href', '#' + syn.pathId)
  am.appendChild(mpath)
  pulse.appendChild(am)

  // Fade in / out via Web Animations — independent of motion.
  svg.appendChild(pulse)
  pulse.animate(
    [
      { opacity: 0 },
      { opacity: 1, offset: 0.2 },
      { opacity: 1, offset: 0.85 },
      { opacity: 0 },
    ],
    { duration: 1400, fill: 'forwards' },
  )
  // Briefly highlight the source's outgoing axon during travel.
  syn.path.classList.add('is-active')
  syn.term.classList.add('is-active')

  // Trigger SMIL animation explicitly (some Chromium builds need this when
  // the element is added after the page parses).
  try { am.beginElement?.() } catch {}

  // Receptor lights up just before the pulse arrives — synaptic delay.
  setTimeout(() => syn.rec.classList.add(styles['is-receiving']), 1100)
  setTimeout(() => {
    syn.rec.classList.remove(styles['is-receiving'])
    syn.path.classList.remove('is-active')
    syn.term.classList.remove('is-active')
  }, 1700)

  setTimeout(() => pulse.remove(), 1500)
}
