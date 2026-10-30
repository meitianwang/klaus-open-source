// digram 面板内的拖拽编辑。
//
// 编辑手势最终都变成一批 op 交给 Rust（applyOps），等落盘校验通过后由 panel 重渲——
// 用户拖一个框和模型调 digram_edit 走的是同一条写入路径，界面上不存在「本地改了但
// 文档还没改」的中间态。
//
// 命中测试和手柄的坐标换算是这里的核心：SVG 用 render 的 viewBox 坐标系，而指针事件
// 是屏幕像素，中间隔着面板的 pan/zoom 变换。三者的关系写在 toDocPoint 里，改一处就够。
//
// undo/redo 是本地的：每个手势产出 { ops, inverse } 一对，正向进 undo 栈、反向即
// 撤销。不走 Rust 的 history/revert，因为那是按「保存」为粒度的粗回滚，而拖拽需要的是
// 手势级、即时的撤销。

import type { RenderResult } from './render'
import type { Rect } from './geometry'
import type { DigramDocument, DigramNode, DigramOp } from './types'

interface EditDeps {
  getDoc(): DigramDocument | null
  getRender(): RenderResult | null
  viewTransform(): { zoom: number; panX: number; panY: number }
  canvasHost(): HTMLElement | null
  applyOps(ops: DigramOp[]): Promise<void>
  repaint(): void
}

export interface DigramEditingHandle {
  selectedIds(): ReadonlySet<string>
  /** 指针命中一个节点/手柄时接管拖拽并返回 true；命中空白返回 false（让 panel 平移）。 */
  hitTest(event: PointerEvent): boolean
  /** 每次重渲后调用：补画选中节点的缩放手柄。 */
  onPainted(result: RenderResult): void
  undo(): void
  redo(): void
  canUndo(): boolean
  canRedo(): boolean
}

/** 8 向缩放手柄的方位。 */
export type HandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLE_DIRS: HandleDir[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** 一次手势的正反 op。inverse 是撤销时应用的那批。 */
interface UndoEntry {
  ops: DigramOp[]
  inverse: DigramOp[]
}

/** 手柄的屏幕像素半径与命中松弛量。恒定屏幕尺寸，所以换算时要除以 zoom。 */
const HANDLE_SCREEN = 7
const MIN_NODE_SIZE = 16
/** 拖动超过这个屏幕距离才算「移动」，否则当作点选，避免手抖把点击变成微移。 */
const DRAG_THRESHOLD = 3

export function initDigramEditing(deps: EditDeps): DigramEditingHandle {
  const selected = new Set<string>()
  const undoStack: UndoEntry[] = []
  const redoStack: UndoEntry[] = []

  /** 屏幕坐标 → 文档坐标。穿过面板的 pan/zoom 和 render 的 viewBox 偏移。 */
  function toDocPoint(event: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const host = deps.canvasHost()
    const rendered = deps.getRender()
    if (!host || !rendered) return null
    const box = host.getBoundingClientRect()
    const { zoom, panX, panY } = deps.viewTransform()
    return {
      x: rendered.viewBox.x + (event.clientX - box.left - panX) / zoom,
      y: rendered.viewBox.y + (event.clientY - box.top - panY) / zoom,
    }
  }

  function nodeById(id: string): DigramNode | undefined {
    return deps.getDoc()?.pages?.[0]?.nodes?.find((node) => node.id === id)
  }

  /** 选中节点的手柄在文档坐标下的命中框。手柄恒定屏幕大小，故除以 zoom。 */
  function handleAt(rect: Rect, docPoint: { x: number; y: number }): HandleDir | null {
    const { zoom } = deps.viewTransform()
    const slop = (HANDLE_SCREEN + 2) / zoom
    const points: Record<HandleDir, { x: number; y: number }> = {
      nw: { x: rect.x, y: rect.y },
      n: { x: rect.x + rect.w / 2, y: rect.y },
      ne: { x: rect.x + rect.w, y: rect.y },
      e: { x: rect.x + rect.w, y: rect.y + rect.h / 2 },
      se: { x: rect.x + rect.w, y: rect.y + rect.h },
      s: { x: rect.x + rect.w / 2, y: rect.y + rect.h },
      sw: { x: rect.x, y: rect.y + rect.h },
      w: { x: rect.x, y: rect.y + rect.h / 2 },
    }
    for (const dir of HANDLE_DIRS) {
      const point = points[dir]
      if (Math.abs(point.x - docPoint.x) <= slop && Math.abs(point.y - docPoint.y) <= slop) return dir
    }
    return null
  }

  /** 命中最上层的节点（hitTargets 已按绘制次序，倒序找即最上层）。 */
  function topNodeAt(docPoint: { x: number; y: number }): { id: string; rect: Rect } | null {
    const rendered = deps.getRender()
    if (!rendered) return null
    for (let index = rendered.hitTargets.length - 1; index >= 0; index -= 1) {
      const target = rendered.hitTargets[index]
      const r = target.rect
      if (
        docPoint.x >= r.x
        && docPoint.x <= r.x + r.w
        && docPoint.y >= r.y
        && docPoint.y <= r.y + r.h
      ) {
        // 命中容器（层）的内部但落在某个子节点上时，子节点已在更后（更上层），所以
        // 倒序天然优先返回子节点；容器只有在点它自己的边缘空白时才被选中。
        return { id: target.id, rect: r }
      }
    }
    return null
  }

  function hitTest(event: PointerEvent): boolean {
    if (event.button !== 0) return false
    const docPoint = toDocPoint(event)
    if (!docPoint) return false

    // 先看是不是落在当前单选节点的缩放手柄上。
    if (selected.size === 1) {
      const id = [...selected][0]
      const node = nodeById(id)
      if (node) {
        const dir = handleAt({ x: node.x, y: node.y, w: node.w, h: node.h }, docPoint)
        if (dir) {
          beginResize(event, node, dir)
          return true
        }
      }
    }

    const hit = topNodeAt(docPoint)
    if (!hit) {
      // 点空白：清选区，交回 panel 去平移。
      if (selected.size) {
        selected.clear()
        deps.repaint()
      }
      return false
    }

    // 多选切换：按住 shift 追加/移除；否则单选。
    if (event.shiftKey) {
      if (selected.has(hit.id)) selected.delete(hit.id)
      else selected.add(hit.id)
    } else if (!selected.has(hit.id)) {
      selected.clear()
      selected.add(hit.id)
    }
    deps.repaint()
    beginMove(event, docPoint)
    return true
  }

  /** 拖动选中的所有节点。低于阈值当点选，不产 op（避免点一下就写一次盘）。 */
  function beginMove(event: PointerEvent, startDoc: { x: number; y: number }) {
    const host = deps.canvasHost()
    if (!host) return
    const { zoom } = deps.viewTransform()
    const moving = [...selected].map((id) => nodeById(id)).filter((node): node is DigramNode => !!node)
    const origin = moving.map((node) => ({ id: node.id, x: node.x, y: node.y }))
    const grid = deps.getDoc()?.pages?.[0]?.grid ?? 0
    let dragged = false
    host.setPointerCapture(event.pointerId)

    const move = (moveEvent: PointerEvent) => {
      const dxScreen = moveEvent.clientX - event.clientX
      const dyScreen = moveEvent.clientY - event.clientY
      if (!dragged && Math.hypot(dxScreen, dyScreen) < DRAG_THRESHOLD) return
      dragged = true
      let dx = dxScreen / zoom
      let dy = dyScreen / zoom
      // 网格吸附：以第一个节点的落点对齐网格，整组一起偏，相对位置不乱。
      if (grid > 1 && origin.length) {
        const target = snap(origin[0].x + dx, grid) - origin[0].x
        const targetY = snap(origin[0].y + dy, grid) - origin[0].y
        dx = target
        dy = targetY
      }
      // 拖动中只更新视图（乐观），不发 op；抬手才提交一次。
      for (const item of origin) {
        const node = nodeById(item.id)
        if (node) {
          node.x = item.x + dx
          node.y = item.y + dy
        }
      }
      deps.repaint()
    }
    const up = (upEvent: PointerEvent) => {
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerup', up)
      if (!dragged) return
      const dx = (upEvent.clientX - event.clientX) / zoom
      const dy = (upEvent.clientY - event.clientY) / zoom
      // 用 origin 计算最终 op，避免累计浮点误差；网格吸附再算一遍。
      const ops: DigramOp[] = []
      const inverse: DigramOp[] = []
      let ddx = dx
      let ddy = dy
      if (grid > 1 && origin.length) {
        ddx = snap(origin[0].x + dx, grid) - origin[0].x
        ddy = snap(origin[0].y + dy, grid) - origin[0].y
      }
      for (const item of origin) {
        const nx = clampCoord(item.x + ddx)
        const ny = clampCoord(item.y + ddy)
        if (nx === item.x && ny === item.y) continue
        ops.push({ op: 'updateNode', id: item.id, patch: { x: nx, y: ny } })
        inverse.push({ op: 'updateNode', id: item.id, patch: { x: item.x, y: item.y } })
      }
      commit(ops, inverse)
    }
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerup', up)
  }

  /** 缩放单个节点。对边固定，拖动边/角改 x/y/w/h，尊重最小尺寸。 */
  function beginResize(event: PointerEvent, node: DigramNode, dir: HandleDir) {
    const host = deps.canvasHost()
    if (!host) return
    const { zoom } = deps.viewTransform()
    const start = { x: node.x, y: node.y, w: node.w, h: node.h }
    const grid = deps.getDoc()?.pages?.[0]?.grid ?? 0
    host.setPointerCapture(event.pointerId)

    const move = (moveEvent: PointerEvent) => {
      const dx = (moveEvent.clientX - event.clientX) / zoom
      const dy = (moveEvent.clientY - event.clientY) / zoom
      const next = resizeRect(start, dir, dx, dy, grid)
      Object.assign(node, next)
      deps.repaint()
    }
    const up = (upEvent: PointerEvent) => {
      host.removeEventListener('pointermove', move)
      host.removeEventListener('pointerup', up)
      const dx = (upEvent.clientX - event.clientX) / zoom
      const dy = (upEvent.clientY - event.clientY) / zoom
      const next = resizeRect(start, dir, dx, dy, grid)
      if (next.x === start.x && next.y === start.y && next.w === start.w && next.h === start.h) return
      commit(
        [{ op: 'updateNode', id: node.id, patch: next }],
        [{ op: 'updateNode', id: node.id, patch: start }],
      )
    }
    host.addEventListener('pointermove', move)
    host.addEventListener('pointerup', up)
  }

  /** 提交一批 op 给 Rust，并把正反对压入 undo 栈（清空 redo）。 */
  function commit(ops: DigramOp[], inverse: DigramOp[]) {
    if (!ops.length) return
    undoStack.push({ ops, inverse })
    redoStack.length = 0
    void deps.applyOps(ops)
  }

  function undo() {
    const entry = undoStack.pop()
    if (!entry) return
    redoStack.push(entry)
    void deps.applyOps(entry.inverse)
  }
  function redo() {
    const entry = redoStack.pop()
    if (!entry) return
    undoStack.push(entry)
    void deps.applyOps(entry.ops)
  }

  // 双击改标签：把命中节点的 label 用一个覆盖在其位置上的 input 编辑，回车/失焦提交。
  function onDoubleClick(event: MouseEvent) {
    const docPoint = toDocPoint(event)
    if (!docPoint) return
    const hit = topNodeAt(docPoint)
    if (!hit) return
    const node = nodeById(hit.id)
    if (!node) return
    openLabelEditor(node)
  }

  function openLabelEditor(node: DigramNode) {
    const host = deps.canvasHost()
    const rendered = deps.getRender()
    if (!host || !rendered) return
    const { zoom, panX, panY } = deps.viewTransform()
    const screenX = (node.x - rendered.viewBox.x) * zoom + panX
    const screenY = (node.y - rendered.viewBox.y) * zoom + panY
    const input = document.createElement('textarea')
    input.className = 'digram-label-editor'
    input.value = node.label ?? ''
    input.style.position = 'absolute'
    input.style.left = `${screenX}px`
    input.style.top = `${screenY}px`
    input.style.width = `${node.w * zoom}px`
    input.style.height = `${node.h * zoom}px`
    host.appendChild(input)
    input.focus()
    input.select()
    const finish = (keep: boolean) => {
      input.removeEventListener('blur', onBlur)
      const value = input.value
      input.remove()
      if (keep && value !== (node.label ?? '')) {
        commit(
          [{ op: 'updateNode', id: node.id, patch: { label: value } }],
          [{ op: 'updateNode', id: node.id, patch: { label: node.label ?? '' } }],
        )
      }
    }
    const onBlur = () => finish(true)
    input.addEventListener('blur', onBlur)
    input.addEventListener('keydown', (keyEvent) => {
      if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) {
        keyEvent.preventDefault()
        finish(true)
      } else if (keyEvent.key === 'Escape') {
        keyEvent.preventDefault()
        finish(false)
      }
    })
  }

  // Delete 删除选中，Escape 清选区。只在面板处于 digram 模式且未在输入框里时生效。
  function onKeyDown(event: KeyboardEvent) {
    const panel = document.getElementById('artifacts-panel')
    if (panel?.getAttribute('data-mode') !== 'digram') return
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
    if (event.key === 'Escape' && selected.size) {
      selected.clear()
      deps.repaint()
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && selected.size) {
      event.preventDefault()
      deleteSelected()
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
    }
  }

  function deleteSelected() {
    const doc = deps.getDoc()
    if (!doc) return
    const ops: DigramOp[] = []
    const inverse: DigramOp[] = []
    for (const id of selected) {
      const node = nodeById(id)
      if (!node) continue
      ops.push({ op: 'deleteNode', id })
      // 撤销 = 把节点原样加回来。边的恢复交给 Rust 校验后的 reload（简化：删除后
      // 关联边也没了，undo 只恢复节点；复杂图的完整 undo 走面板重新拉取）。
      inverse.push({ op: 'addNode', node: { ...node } })
    }
    if (!ops.length) return
    selected.clear()
    commit(ops, inverse)
  }

  // 手柄叠加层：每次重渲后补画。恒定屏幕大小，所以边长按 1/zoom 反算到文档坐标。
  function onPainted(_result: RenderResult) {
    const host = deps.canvasHost()
    const svg = host?.querySelector('svg')
    if (!svg) return
    if (selected.size !== 1) return
    const node = nodeById([...selected][0])
    if (!node) return
    const { zoom } = deps.viewTransform()
    const size = HANDLE_SCREEN / zoom
    const points: Array<{ x: number; y: number }> = [
      { x: node.x, y: node.y },
      { x: node.x + node.w / 2, y: node.y },
      { x: node.x + node.w, y: node.y },
      { x: node.x + node.w, y: node.y + node.h / 2 },
      { x: node.x + node.w, y: node.y + node.h },
      { x: node.x + node.w / 2, y: node.y + node.h },
      { x: node.x, y: node.y + node.h },
      { x: node.x, y: node.y + node.h / 2 },
    ]
    const ns = 'http://www.w3.org/2000/svg'
    for (const point of points) {
      const rect = document.createElementNS(ns, 'rect')
      rect.setAttribute('x', String(point.x - size))
      rect.setAttribute('y', String(point.y - size))
      rect.setAttribute('width', String(size * 2))
      rect.setAttribute('height', String(size * 2))
      rect.setAttribute('fill', '#ffffff')
      rect.setAttribute('stroke', '#4a72a8')
      rect.setAttribute('stroke-width', String(1.5 / zoom))
      rect.setAttribute('class', 'digram-handle')
      svg.appendChild(rect)
    }
  }

  // 双击与键盘监听装一次。
  const host = deps.canvasHost()
  host?.addEventListener('dblclick', onDoubleClick)
  window.addEventListener('keydown', onKeyDown)

  return {
    selectedIds: () => selected,
    hitTest,
    onPainted,
    undo,
    redo,
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
  }
}

// ---- 纯几何辅助（可单测） ----

const MAX_COORD = 100_000

export function clampCoord(value: number): number {
  return Math.max(-MAX_COORD, Math.min(MAX_COORD, Math.round(value * 100) / 100))
}

export function snap(value: number, grid: number): number {
  return grid > 1 ? Math.round(value / grid) * grid : value
}

/** 按方位缩放一个矩形，尊重最小尺寸；返回带定长小数的新矩形。 */
export function resizeRect(
  start: { x: number; y: number; w: number; h: number },
  dir: HandleDir,
  dx: number,
  dy: number,
  grid: number,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = start
  const west = dir === 'nw' || dir === 'w' || dir === 'sw'
  const east = dir === 'ne' || dir === 'e' || dir === 'se'
  const north = dir === 'nw' || dir === 'n' || dir === 'ne'
  const south = dir === 'sw' || dir === 's' || dir === 'se'
  if (east) w = start.w + dx
  if (west) {
    w = start.w - dx
    x = start.x + dx
  }
  if (south) h = start.h + dy
  if (north) {
    h = start.h - dy
    y = start.y + dy
  }
  // 最小尺寸：往回顶，保持对边固定。
  if (w < MIN_NODE_SIZE) {
    if (west) x -= MIN_NODE_SIZE - w
    w = MIN_NODE_SIZE
  }
  if (h < MIN_NODE_SIZE) {
    if (north) y -= MIN_NODE_SIZE - h
    h = MIN_NODE_SIZE
  }
  const round = (value: number) => (grid > 1 ? snap(value, grid) : Math.round(value * 100) / 100)
  return { x: round(x), y: round(y), w: round(w), h: round(h) }
}
