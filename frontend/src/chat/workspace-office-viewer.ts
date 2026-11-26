import type { OfficePreviewPayload, OfficeInlineRun, OfficeDocBlock, OfficeSlideParagraph } from '../../../contracts/office-preview'
import { officePreviewEn } from '../i18n/office-preview-messages'
import css from './workspace-office-viewer.module.css'

export interface WorkspaceOfficeViewState {
  activeSheet?: number
  sheetStates?: Record<number, { r: number; c: number; scrollTop: number; scrollLeft: number }>
  scrollTop?: number
  activeSlide?: number
}

type Vars = Record<string, string | number>
type Options = { state?: WorkspaceOfficeViewState; translate?: (key: string, vars?: Vars) => string; openExternal?: (url: string) => void; copyText?: (text: string) => void }
function el<K extends keyof HTMLElementTagNameMap>(tag: K, parent: HTMLElement, cls?: string, text?: string) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  parent.append(n)
  return n
}
function paint(node: HTMLElement, bg?: string, color?: string) {
  if (bg) {
    node.style.backgroundColor = bg
    const m = /^#([a-f\d]{3}|[a-f\d]{6})$/i.exec(bg)
    if (!color && m) {
      const hex = m[1]!.length === 3 ? m[1]!.replace(/./g, '$&$&') : m[1]!
      const [r, g, b] = [0, 2, 4].map(i => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255
        return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4
      })
      color = .2126 * r! + .7152 * g! + .0722 * b! > .18 ? '#1a1c1f' : '#f9fafb'
    }
  }
  if (color) node.style.color = color
}
function column(index: number) {
  let result = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result
  return result
}
function image(parent: HTMLElement, src: string, alt = '') {
  const img = el('img', parent)
  if (/^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);base64,/i.test(src)) img.src = src
  img.alt = alt
  return img
}
function cols(table: HTMLTableElement, widths: number[], unit: string) {
  const group = el('colgroup', table)
  for (const width of widths) el('col', group).style.width = `${width}${unit}`
}

export function mountOfficeViewer(host: HTMLElement, payload: OfficePreviewPayload, options: Options = {}) {
  const state = options.state ?? {}
  const t = (suffix: string, vars: Vars = {}) => {
    const key = `office_preview_${suffix}` as keyof typeof officePreviewEn
    const translated = options.translate?.(key, vars)
    return (translated && translated !== key ? translated : officePreviewEn[key]).replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match))
  }
  const root = el('div', host, css.viewer)
  const empty = (key: string, vars?: Vars, parent = root) => el('div', parent, css.empty, t(key, vars))
  function runs(parent: HTMLElement, items: OfficeInlineRun[], slideWidth?: number) {
    for (const run of items) {
      if (run.br) { el('br', parent); continue }
      let node = el('span', parent)
      paint(node, run.highlight, run.color)
      if (slideWidth && run.fontSize) node.style.setProperty('--office-slide-fs', `${100 * run.fontSize / slideWidth}cqw`)
      else if (run.fontSize) node.style.fontSize = `${run.fontSize}pt`
      if (run.href && /^(?:https?:|mailto:)/i.test(run.href) && options.openExternal) {
        const link = el('a', node)
        const url = run.href
        link.href = url
        link.onclick = event => { event.preventDefault(); options.openExternal?.(url) }
        node = link
      }
      for (const [enabled, tag] of [[run.bold, 'strong'], [run.italic, 'em'], [run.underline, 'u'], [run.strike, 's'], [run.code, 'code'], [run.sup, 'sup'], [run.sub, 'sub']] as const) {
        if (enabled) node = el(tag, node)
      }
      node.textContent = run.text
    }
  }
  function blocks(parent: HTMLElement, items: OfficeDocBlock[]) {
    for (const block of items) {
      if (block.kind === 'hr') { el('hr', parent); continue }
      if (block.kind === 'paragraph') {
        const p = el(block.heading ? `h${block.heading}` : block.role === 'quote' ? 'blockquote' : 'p', parent,
          block.role === 'title' ? css.docTitle : block.role === 'subtitle' ? css.subtitle : undefined)
        paint(p, block.bg)
        if (block.align) p.style.textAlign = block.align
        p.style.marginInlineStart = `${(block.indentPt ?? 0) + 16 * (block.list?.level ?? 0)}pt`
        if (block.list) el('span', p, undefined, `${block.list.marker} `)
        runs(p, block.runs)
        for (const item of block.images ?? []) {
          const img = image(p, item.src, item.alt)
          if (item.widthPx) img.width = item.widthPx
          if (item.heightPx) img.height = item.heightPx
        }
        continue
      }
      const table = el('table', parent)
      if (block.colWidthsPct) cols(table, block.colWidthsPct, '%')
      let section: HTMLTableSectionElement | undefined
      for (const row of block.rows) {
        const tag = row.header ? 'THEAD' : 'TBODY'
        if (section?.tagName !== tag) section = el(row.header ? 'thead' : 'tbody', table)
        const tr = el('tr', section!)
        for (const cell of row.cells) {
          const td = el(row.header ? 'th' : 'td', tr)
          td.rowSpan = cell.rowSpan ?? 1
          td.colSpan = cell.colSpan ?? 1
          td.style.verticalAlign = cell.valign ?? 'top'
          paint(td, cell.bg)
          blocks(td, cell.blocks)
        }
      }
    }
  }
  function render(next: OfficePreviewPayload) {
    root.replaceChildren()
    if (next.kind === 'error') { empty(`error_${next.code}`, { limit: `${(next.maxBytes ?? 50 * 1024 ** 2) / 1024 ** 2} MB` }); return }
    if (next.kind === 'document') {
      if (!next.blocks.length && !next.footnotes?.length && !next.truncated) { empty('doc_empty'); return }
      const stage = el('div', root, css.document)
      const paper = el('article', stage, css.paper)
      if (next.truncated) el('div', paper, css.notice, t('doc_truncated'))
      blocks(paper, next.blocks)
      if (next.footnotes?.length) {
        el('h2', paper, undefined, t('doc_footnotes'))
        for (const note of next.footnotes) blocks(paper, note.blocks)
      }
      stage.scrollTop = state.scrollTop ?? 0
      stage.onscroll = () => { state.scrollTop = stage.scrollTop }
      return
    }
    if (next.kind === 'spreadsheet') {
      if (!next.sheets.length) { empty('sheet_empty'); return }
      const index = Math.max(0, Math.min(next.sheets.length - 1, state.activeSheet ?? next.activeSheet))
      state.activeSheet = index
      const sheet = next.sheets[index]!
      const saved = (state.sheetStates ??= {})[index] ??= { r: -1, c: -1, scrollTop: 0, scrollLeft: 0 }
      const bar = el('div', root, css.bar)
      const address = el('span', bar, css.address)
      address.setAttribute('aria-label', t('cell_box_aria'))
      el('span', bar, css.fx, 'fx')
      const formula = el('div', bar, css.formula)
      formula.setAttribute('aria-label', t('formula_bar_aria'))
      el('span', bar, css.dimensions, t('sheet_dimensions', { rows: sheet.totalRows, cols: sheet.totalCols }))
      if (sheet.renderedRows < sheet.totalRows || sheet.renderedCols < sheet.totalCols) el('div', root, css.notice, t('sheet_truncated', { renderedRows: sheet.renderedRows, renderedCols: sheet.renderedCols, totalRows: sheet.totalRows, totalCols: sheet.totalCols }))
      const stage = el('div', root, css.grid)
      stage.tabIndex = 0
      const rs = Array.from({ length: sheet.renderedRows }, (_, i) => i).filter(i => !sheet.hiddenRows?.includes(i))
      const cs = Array.from({ length: sheet.renderedCols }, (_, i) => i).filter(i => !sheet.hiddenCols?.includes(i))
      const key = (r: number, c: number) => r * sheet.renderedCols + c
      type Cell = typeof sheet.cells[number]
      type Slot = { td: HTMLTableCellElement; cell: Cell; r: number; c: number; endR: number; endC: number }
      const slots = new Map<number, Slot>()
      const masters = new Map<number, Cell>()
      for (const cell of sheet.cells) {
        const r = rs.find(i => i >= cell.r), c = cs.find(i => i >= cell.c)
        if (r !== undefined && c !== undefined && r < cell.r + (cell.rs ?? 1) && c < cell.c + (cell.cs ?? 1)) masters.set(key(r, c), cell)
      }
      const rowHeaders = new Map<number, HTMLElement>()
      const colHeaders = new Map<number, HTMLElement>()
      function markHeaders(slot: Slot, active: boolean) {
        for (let r = slot.r; r <= slot.endR; r++) rowHeaders.get(r)?.classList.toggle(css.activeHeader!, active)
        for (let c = slot.c; c <= slot.endC; c++) colHeaders.get(c)?.classList.toggle(css.activeHeader!, active)
      }
      let selected: Slot | undefined
      function select(slot?: Slot, reveal = false) {
        selected?.td.classList.remove(css.selected!)
        if (selected) markHeaders(selected, false)
        selected = slot
        formula.classList.toggle(css.formulaPlaceholder!, !slot)
        if (slot) {
          slot.td.classList.add(css.selected!)
          markHeaders(slot, true)
          saved.r = slot.r; saved.c = slot.c
          if (reveal) slot.td.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
        const cell = slot?.cell
        const a = cell ? `${column(cell.c)}${cell.r + 1}` : '—'
        address.textContent = cell && ((cell.rs ?? 1) > 1 || (cell.cs ?? 1) > 1) ? `${a}:${column(cell.c + (cell.cs ?? 1) - 1)}${cell.r + (cell.rs ?? 1)}` : a
        const f = cell?.f ? `=${cell.f.replace(/^=/, '')}` : ''
        formula.textContent = cell ? (f && cell.v && f !== cell.v && cell.f !== cell.v ? `${f}  →  ${cell.v}` : f || cell.v) : t('formula_placeholder')
      }
      if (!rs.length || !cs.length) empty('sheet_empty', undefined, stage)
      else {
        const table = el('table', stage)
        cols(table, [52, ...cs.map(c => Math.min(420, Math.max(56, sheet.colWidths?.[c] ?? 104)))], 'px')
        const header = el('tr', el('thead', table))
        el('th', header)
        for (const c of cs) {
          const th = el('th', header, undefined, column(c))
          th.scope = 'col'
          colHeaders.set(c, th)
        }
        const body = el('tbody', table)
        for (const r of rs) {
          const tr = el('tr', body)
          if (sheet.rowHeights?.[r]) tr.style.height = `${sheet.rowHeights[r]}px`
          const th = el('th', tr, undefined, String(r + 1))
          th.scope = 'row'
          rowHeaders.set(r, th)
          for (const c of cs) {
            if (slots.has(key(r, c))) continue
            const cell = masters.get(key(r, c)) ?? { r, c, v: '' }
            const td = el('td', tr, undefined, cell.v)
            const mergedRows = cell.rs ? rs.filter(i => i >= r && i < cell.r + cell.rs!) : [r]
            const mergedCols = cell.cs ? cs.filter(i => i >= c && i < cell.c + cell.cs!) : [c]
            td.rowSpan = mergedRows.length; td.colSpan = mergedCols.length
            const style = cell.s === undefined ? undefined : next.styles[cell.s]
            paint(td, style?.bg, style?.color)
            td.style.textAlign = style?.align ?? (cell.t === 'n' ? 'right' : 'left')
            td.style.verticalAlign = style?.valign ?? 'middle'
            if (style?.bold) td.style.fontWeight = 'var(--weight-semibold)'
            if (style?.italic) td.style.fontStyle = 'italic'
            td.style.textDecoration = [style?.underline && 'underline', style?.strike && 'line-through'].filter(Boolean).join(' ')
            if (style?.wrap || cell.v.includes('\n')) td.style.whiteSpace = 'pre-wrap'
            for (const edge of ['borderTop', 'borderRight', 'borderBottom', 'borderLeft'] as const) if (style?.[edge]) td.style[edge] = style[edge]
            const slot = { td, cell, r, c, endR: mergedRows.at(-1)!, endC: mergedCols.at(-1)! }
            for (const rr of mergedRows) for (const cc of mergedCols) slots.set(key(rr, cc), slot)
            td.onclick = () => { select(slot); stage.focus({ preventScroll: true }) }
          }
        }
      }
      select(saved.r < 0 || saved.c < 0 ? undefined : slots.get(key(saved.r, saved.c)))
      stage.scrollTop = saved.scrollTop; stage.scrollLeft = saved.scrollLeft
      const saveScroll = () => { saved.scrollTop = stage.scrollTop; saved.scrollLeft = stage.scrollLeft }
      stage.onscroll = saveScroll
      stage.onkeydown = event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c' && selected && !document.getSelection()?.toString()) {
          event.preventDefault()
          if (options.copyText) options.copyText(selected.cell.v)
          else void navigator.clipboard?.writeText(selected.cell.v).catch(() => {})
          return
        }
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault()
        const r = selected ? event.key === 'ArrowUp' ? rs[rs.indexOf(selected.r) - 1] : event.key === 'ArrowDown' ? rs[rs.indexOf(selected.endR) + 1] : selected.r : rs[0]
        const c = selected ? event.key === 'ArrowLeft' ? cs[cs.indexOf(selected.c) - 1] : event.key === 'ArrowRight' ? cs[cs.indexOf(selected.endC) + 1] : selected.c : cs[0]
        const slot = r === undefined || c === undefined ? undefined : slots.get(key(r, c))
        if (slot) { select(slot, true); saveScroll() }
      }
      const tabs = el('div', root, css.tabs)
      tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', t('sheet_tabs_aria'))
      next.sheets.forEach((item, i) => {
        const btn = el('button', tabs, undefined, item.name)
        btn.setAttribute('role', 'tab'); btn.setAttribute('aria-selected', String(i === index))
        if (item.hidden) el('span', btn, css.badge, t('sheet_hidden_badge'))
        btn.onclick = () => { saveScroll(); state.activeSheet = i; render(next); root.querySelectorAll('button')[i]?.focus() }
      })
      return
    }
    if (next.kind === 'pdf') {
      if (!next.pages.length && !next.truncated) { empty('pdf_empty'); return }
      const stage = el('div', root, css.document)
      for (const [index, page] of next.pages.entries()) {
        const paper = el('article', stage, css.paper)
        if (!index && next.truncated) el('div', paper, css.notice, t('doc_truncated'))
        el('div', paper, css.subtitle, t('pdf_page', { index: page.index }))
        blocks(paper, page.blocks)
      }
      stage.scrollTop = state.scrollTop ?? 0
      stage.onscroll = () => { state.scrollTop = stage.scrollTop }
      return
    }
    if (!next.slides.length) { empty('slides_empty'); return }
    const bar = el('div', root, css.bar)
    const prev = el('button', bar, undefined, '‹')
    prev.setAttribute('aria-label', t('slide_prev'))
    const counter = el('span', bar)
    const forward = el('button', bar, undefined, '›')
    forward.setAttribute('aria-label', t('slide_next'))
    if (next.truncated) el('div', root, css.notice, t('slides_truncated', { count: next.slides.length }))
    const deck = el('div', root, css.deck)
    deck.tabIndex = 0
    const w = next.widthPt || 720, h = next.heightPt || 405
    const paragraphs = (parent: HTMLElement, items: OfficeSlideParagraph[]) => {
      for (const item of items) {
        const p = el('p', parent)
        p.style.textAlign = item.align ?? 'left'
        if (item.level) p.style.marginInlineStart = `${item.level}em`
        if (item.marker) el('span', p, undefined, `${item.marker} `)
        runs(p, item.runs, w)
      }
    }
    const cards = next.slides.map(slide => {
      const card = el('article', deck, css.slide)
      const header = el('div', card, css.bar, t('slide_label', { index: slide.index }))
      if (slide.hidden) el('span', header, css.badge, t('slide_hidden_badge'))
      const canvas = el('div', card, css.canvas)
      canvas.style.aspectRatio = `${w} / ${h}`
      paint(canvas, slide.background ?? '#ffffff')
      if (slide.backgroundImage && /^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml);base64,[\w+/=]+$/i.test(slide.backgroundImage)) canvas.style.backgroundImage = `url("${slide.backgroundImage}")`
      for (const item of slide.elements) {
        const box = el('div', canvas, css.positioned)
        Object.assign(box.style, { left: `${item.x}%`, top: `${item.y}%`, width: `${item.w}%`, height: `${item.h}%` })
        box.style.setProperty('--office-slide-fs', `${1800 / w}cqw`)
        if (item.rotation) box.style.transform = `rotate(${item.rotation}deg)`
        if (item.kind === 'image') {
          const img = image(box, item.src, item.alt)
          Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'fill' })
          if (item.crop) {
            const { top, right, bottom, left } = item.crop
            const l = left / 100, r = right / 100, t = top / 100, b = bottom / 100
            const x = 1 - l - r, y = 1 - t - b
            if (x > 0 && y > 0) Object.assign(img.style, { position: 'absolute', width: `${100 / x}%`, height: `${100 / y}%`, left: `${-100 * l / x}%`, top: `${-100 * t / y}%` })
          }
        } else if (item.kind === 'shape') {
          paint(box, item.fill)
          if (item.stroke) box.style.border = `${100 * (item.strokeWidthPt ?? 1) / w}cqw solid ${item.stroke}`
          if (item.geom === 'ellipse') box.style.borderRadius = '50%'
          if (item.geom === 'roundRect') box.style.borderRadius = 'var(--radius-md)'
          box.style.display = 'flex'; box.style.flexDirection = 'column'
          box.style.justifyContent = item.valign === 'middle' ? 'center' : item.valign === 'bottom' ? 'end' : 'start'
          if (item.paddingPct) box.style.padding = [item.paddingPct.top, item.paddingPct.right, item.paddingPct.bottom, item.paddingPct.left].map(v => `${v}%`).join(' ')
          paragraphs(box, item.paragraphs)
        } else {
          const table = el('table', box)
          if (item.colWidthsPct) cols(table, item.colWidthsPct, '%')
          const body = el('tbody', table)
          for (const row of item.rows) {
            const tr = el('tr', body)
            for (const cell of row.cells) {
              const td = el('td', tr)
              td.rowSpan = cell.rowSpan ?? 1; td.colSpan = cell.colSpan ?? 1
              td.style.verticalAlign = cell.valign ?? 'top'
              paint(td, cell.bg)
              paragraphs(td, cell.paragraphs)
            }
          }
        }
      }
      if (slide.notes) {
        const notes = el('section', card, css.notes)
        el('strong', notes, undefined, t('slide_notes'))
        el('div', notes, undefined, slide.notes)
      }
      return card
    })
    let active = Math.max(0, Math.min(cards.length - 1, state.activeSlide ?? 0))
    let destination: number | undefined
    function set(index: number) {
      active = index; state.activeSlide = index
      counter.textContent = t('slide_counter', { current: index + 1, total: cards.length })
      prev.disabled = index === 0; forward.disabled = index === cards.length - 1
    }
    const top = (node: HTMLElement) => node.getBoundingClientRect().top - deck.getBoundingClientRect().top + deck.scrollTop - 16
    const go = (i: number) => {
      const index = Math.max(0, Math.min(cards.length - 1, i))
      destination = index
      set(index)
      deck.scrollTo({ top: top(cards[index]!), behavior: 'smooth' })
    }
    prev.onclick = () => go(active - 1)
    forward.onclick = () => go(active + 1)
    const keydown = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); go(active + (e.key === 'PageUp' ? -1 : 1)) }
    }
    deck.onkeydown = keydown; bar.onkeydown = keydown
    deck.onscrollend = () => { destination = undefined }
    deck.onwheel = () => { destination = undefined }
    deck.onpointerdown = () => { destination = undefined }
    deck.onscroll = () => {
      state.scrollTop = deck.scrollTop
      if (destination !== undefined) return
      let index = 0
      for (let i = 1; i < cards.length; i++) if (top(cards[i]!) <= deck.scrollTop + deck.clientHeight / 3) index = i
      if (deck.scrollTop > 0 && deck.scrollTop + deck.clientHeight >= deck.scrollHeight - 1) index = cards.length - 1
      set(index)
    }
    set(active)
    deck.scrollTop = state.scrollTop ?? top(cards[active]!)
  }
  render(payload)
  return { destroy: () => root.remove(), update: render }
}
