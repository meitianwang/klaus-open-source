import { fileIconName } from './file-icon-name'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { I18N } from '../i18n/messages'
import { mountOfficeViewer } from './workspace-office-viewer'

class Element {
  parent?: Element
  children: Element[] = []
  classes = new Set<string>()
  private rawClassName = ''
  get className() { return this.rawClassName }
  set className(val: string) {
    this.rawClassName = val
    this.classes = new Set(String(val || '').split(/\s+/).filter(Boolean))
  }
  classList = {
    add: (key: string) => this.classes.add(key),
    remove: (key: string) => this.classes.delete(key),
    toggle: (key: string, active: boolean) => active ? this.classes.add(key) : this.classes.delete(key),
  }
  style: Record<string, unknown> = { setProperty: (key: string, value: string) => { this.style[key] = value } }
  attributes: Record<string, string> = {}
  src = ''
  value = ''
  type = ''
  placeholder = ''
  disabled = false
  contentEditable = ''
  rowSpan = 1
  colSpan = 1
  scope = ''
  tabIndex = -1
  scrollTop = 0
  scrollLeft = 0
  onclick?: (event: { preventDefault(): void; stopPropagation(): void; target?: unknown }) => void
  ondblclick?: (event: { preventDefault(): void; stopPropagation(): void }) => void
  oninput?: (event: { preventDefault(): void }) => void
  onblur?: () => void
  onkeydown?: (event: { key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; preventDefault(): void; stopPropagation(): void; target?: unknown }) => void
  onpaste?: (event: { clipboardData?: { getData(type: string): string }; preventDefault(): void }) => void
  onmousedown?: (event: unknown) => void
  onmousemove?: (event: unknown) => void
  onmouseup?: (event: unknown) => void
  onmouseleave?: (event: unknown) => void
  onwheel?: (event: unknown) => void
  onscroll?: () => void
  get tagName() { return this.tag.toUpperCase() }
  constructor(readonly tag: string, public textContent = '') {}
  append(child: Element) { child.parent = this; this.children.push(child) }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this)
  }
  replaceChildren() { for (const c of this.children) c.parent = undefined; this.children = [] }
  setAttribute(key: string, value: string) { this.attributes[key] = value }
  addEventListener() {}
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap(child => child.all(selector.toLowerCase()))
  }
  focus() {}
  select() {}
  blur() { this.onblur?.() }
  scrollIntoView() {}
  scrollTo() {}
  getBoundingClientRect() { return { top: 0 } }
  click() { this.onclick?.({ preventDefault() {}, stopPropagation() {}, target: this }) }
  dblclick() { this.ondblclick?.({ preventDefault() {}, stopPropagation() {} }) }
  all(tag?: string): Element[] { return [...(!tag || this.tag === tag ? [this] : []), ...this.children.flatMap(child => child.all(tag))] }
}
const descriptors = ['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
beforeAll(() => {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: (tag: string) => new Element(tag),
      createElementNS: (_ns: string, tag: string) => new Element(tag),
    },
  })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
})
afterAll(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})
const container = (host: Element) => host as unknown as HTMLElement

test('language dictionaries contain the same keys and placeholders', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map(m => m[0]).sort()
  expect(Object.keys(I18N.en).sort()).toEqual(Object.keys(I18N.zh).sort())
  for (const [key, text] of Object.entries(I18N.en)) expect(placeholders(text)).toEqual(placeholders(I18N.zh[key]!))
})

test('spreadsheet selection tracks merged headers, formulas and worksheet tabs', () => {
  const host = new Element('host')
  const sheet = { totalRows: 2, totalCols: 4, renderedRows: 2, renderedCols: 4 }
  mountOfficeViewer(container(host), { kind: 'spreadsheet', activeSheet: 0, styles: [], sheets: [
    { ...sheet, name: 'First', cells: [{ r: 0, c: 0, rs: 2, cs: 4, v: 'Merged' }] },
    { ...sheet, name: 'Second', cells: [{ r: 0, c: 0, cs: 4, v: '848,000', f: '54000*12+200000', t: 'n' }] },
  ] })
  expect(host.all('th').filter(e => e.scope === 'col').map(e => e.textContent)).toEqual(['A', 'B', 'C', 'D'])
  const merged = host.all('td')[0]!
  expect([merged.rowSpan, merged.colSpan]).toEqual([2, 4])
  merged.click()
  expect(host.all('th').filter(e => e.classes.size)).toHaveLength(6)
  host.all('button')[1]!.click()
  const value = host.all('td')[0]!
  expect(value.style.textAlign).toBe('right')
  value.click()
  const label = (label: string) => host.all().find(e => e.attributes['aria-label'] === label)?.textContent
  expect(label('Selected cell address')).toBe('A1:D1')
  expect(label('Selected cell value or formula')).toBe('=54000*12+200000  →  848,000')
  host.all('button')[0]!.click()
  expect(label('Selected cell address')).toBe('A1:D2')
  expect(host.all('th').filter(e => e.classes.size)).toHaveLength(6)
})

test('documents display headings, merged cells, safe images and external links', () => {
  const host = new Element('host'), links: string[] = []
  mountOfficeViewer(container(host), { kind: 'document', blocks: [
    { kind: 'paragraph', heading: 1, runs: [{ text: 'Heading', href: 'https://example.com/' }] },
    { kind: 'paragraph', list: { ordered: false, marker: '•', level: 0 }, runs: [{ text: 'List item' }] },
    { kind: 'paragraph', runs: [], images: ['data:image/png;base64,AAAA', 'javascript:alert(1)', 'https://example.com/a.png'].map(src => ({ src })) },
    { kind: 'table', rows: [{ cells: [{ rowSpan: 2, colSpan: 3, blocks: [] }] }] },
  ] }, { openExternal: url => links.push(url) })
  expect(host.all('h1')).toHaveLength(1)
  expect(host.all('span').map(e => e.textContent)).toContain('• ')
  expect(host.all('td').map(e => [e.rowSpan, e.colSpan])).toEqual([[2, 3]])
  expect(host.all('img').map(e => e.src)).toEqual(['data:image/png;base64,AAAA', '', ''])
  host.all('a')[0]!.click()
  expect(links).toEqual(['https://example.com/'])
})

test('presentation positions and crops elements in percentages and navigates slides', () => {
  const host = new Element('host')
  mountOfficeViewer(container(host), { kind: 'presentation', widthPt: 960, heightPt: 540, slides: [
    { index: 1, notes: 'Note text', elements: [{ kind: 'image', x: 10, y: 20, w: 30, h: 40, src: 'data:image/png;base64,AAAA', crop: { left: 25, right: 25, top: 0, bottom: 0 } }] },
    { index: 2, elements: [] },
  ] })
  const has = (text: string) => host.all().some(e => e.textContent === text)
  expect(has('Slide 1')).toBe(true)
  expect(host.all().find(e => e.style.left === '10%')?.style.width).toBe('30%')
  expect(host.all('img')[0]!.style.width).toBe('200%')
  expect(has('Note text')).toBe(true)
  expect(has('1 / 2')).toBe(true)
  host.all('button')[1]!.click()
  expect(has('2 / 2')).toBe(true)
  host.all('button')[0]!.click()
  expect(has('1 / 2')).toBe(true)
})

test('Office errors show localized fallback messages', () => {
  for (const code of ['encrypted', 'too_large', 'corrupted', 'empty', 'unsupported'] as const) {
    const host = new Element('host')
    mountOfficeViewer(container(host), { kind: 'error', family: 'document', code })
    expect(host.all().map(e => e.textContent)).toContain(I18N.en[`office_preview_error_${code}`]!.replace('{limit}', '50 MB'))
  }
})


test('PDF previews show page text, empty state, and localized errors', () => {
  const host = new Element('host')
  mountOfficeViewer(container(host), { kind: 'pdf', pageCount: 2, pages: [1, 2].map(index => ({ index, blocks: [{ kind: 'paragraph', runs: [{ text: `Text ${index}` }] }] })) })
  const texts = () => host.all().map(node => node.textContent)
  for (const value of ['Page 1', 'Text 1', 'Page 2', 'Text 2']) expect(texts()).toContain(value)
  mountOfficeViewer(container(host), { kind: 'pdf', pageCount: 0, pages: [] })
  expect(texts()).toContain(I18N.en.office_preview_pdf_empty)
  for (const code of ['empty', 'corrupted', 'encrypted', 'too_large'] as const) {
    mountOfficeViewer(container(host), { kind: 'error', family: 'pdf', code })
    expect(texts()).toContain(I18N.en[`office_preview_error_${code}`]!.replace('{limit}', '50 MB'))
  }
})

test('PDF and Office extensions select their file icons', () => {
  expect(['a.PDF', 'b.xlsx', 'c.docx', 'd.pptx'].map(fileIconName)).toEqual(['resource-file-pdf', 'resource-file-excel', 'resource-file-word', 'resource-file-powerpoint'])
  expect(['data.csv', 'data.tsv', 'budget.et', 'tpl.ett', 'tpl.xlt'].map(fileIconName)).toEqual([
    'resource-file-spreadsheet', 'resource-file-spreadsheet', 'resource-file-excel', 'resource-file-excel', 'resource-file-excel',
  ])
  expect(['note.wps', 'tpl.wpt', 'legacy.dot'].map(fileIconName)).toEqual([
    'resource-file-word', 'resource-file-word', 'resource-file-word',
  ])
  expect(['deck.dps', 'tpl.dpt', 'tpl.pot', 'show.ppsm'].map(fileIconName)).toEqual([
    'resource-file-powerpoint', 'resource-file-powerpoint', 'resource-file-powerpoint', 'resource-file-powerpoint',
  ])
  expect(['map.xmind', 'doc.mdown', 'doc.mkd', 'page.html', 'page.xhtml'].map(fileIconName)).toEqual([
    'resource-file-document', 'chat-file', 'chat-file', 'resource-file-html', 'resource-file-html',
  ])
})

test('editable spreadsheet recalculates formulas, mutates rows and columns, and triggers Save / Save As without hover titles', async () => {
  const host = new Element('host')
  let savedCount = 0
  let saveAsCount = 0
  const handle = mountOfficeViewer(container(host), {
    kind: 'spreadsheet',
    activeSheet: 0,
    styles: [],
    sheets: [{
      name: 'Revenue',
      totalRows: 3,
      totalCols: 2,
      renderedRows: 3,
      renderedCols: 2,
      cells: [
        { r: 0, c: 0, v: '10', t: 'n' },
        { r: 1, c: 0, v: '25', t: 'n' },
        { r: 2, c: 0, v: '35', f: 'SUM(A1:A2)', t: 'n' },
      ],
    }],
  }, {
    editable: true,
    canSaveInPlace: true,
    onSave: async () => { savedCount += 1; return { ok: true } },
    onSaveAs: async () => { saveAsCount += 1; return { ok: true } },
  })
  // Right-side panel discipline: zero title attributes on any viewer element.
  expect(host.all().filter(node => 'title' in node.attributes)).toHaveLength(0)

  // Select A1 and edit via formula input -> A3 (=SUM(A1:A2)) recalculates live!
  host.all('td')[0]!.click()
  const formulaInput = host.all('input').find(node => node.attributes['aria-label'] === 'Selected cell value or formula')!
  formulaInput.value = '100'
  formulaInput.oninput?.({ preventDefault() {} })
  formulaInput.onkeydown?.({ key: 'Enter', preventDefault() {}, stopPropagation() {} })
  const updated = handle.getPayload()
  expect(updated.kind).toBe('spreadsheet')
  if (updated.kind === 'spreadsheet') {
    expect(updated.sheets[0]!.cells.find(c => c.r === 2 && c.c === 0)?.v).toBe('125')
  }

  // Undo restores A3 to 35; Redo restores 125.
  const btnByText = (t: string) => host.all('button').find(b => b.textContent === t)!
  btnByText('Undo').click()
  const undone = handle.getPayload()
  if (undone.kind === 'spreadsheet') {
    expect(undone.sheets[0]!.cells.find(c => c.r === 2 && c.c === 0)?.v).toBe('35')
  }
  btnByText('Redo').click()
  btnByText('+ Row').click()
  btnByText('+ Column').click()
  await handle.save()
  await handle.saveAs()
  expect([savedCount, saveAsCount]).toEqual([1, 1])
})

test('editable document, presentation, and XMind mindmap editors mutate structure and save cleanly', async () => {
  // 1. Document editor
  const docHost = new Element('host')
  const docHandle = mountOfficeViewer(container(docHost), {
    kind: 'document',
    blocks: [{ kind: 'paragraph', runs: [{ text: 'Initial paragraph' }] }],
  }, { editable: true, canSaveInPlace: true, onSave: async () => ({ ok: true }) })
  docHost.all('button').find(b => b.textContent === 'H1')!.click()
  docHost.all('button').find(b => b.textContent === '+ Table')!.click()
  const nextDoc = docHandle.getPayload()
  expect(nextDoc.kind).toBe('document')
  if (nextDoc.kind === 'document') {
    expect(nextDoc.blocks).toHaveLength(2)
    expect(nextDoc.blocks[0]!.kind === 'paragraph' && nextDoc.blocks[0]!.heading).toBe(1)
    expect(nextDoc.blocks[1]!.kind).toBe('table')
  }

  // 2. Presentation editor
  const pptHost = new Element('host')
  const pptHandle = mountOfficeViewer(container(pptHost), {
    kind: 'presentation',
    widthPt: 960,
    heightPt: 540,
    slides: [{ index: 1, elements: [] }],
  }, { editable: true, canSaveInPlace: true, onSave: async () => ({ ok: true }) })
  pptHost.all('button').find(b => b.textContent === '+ Text box')!.click()
  pptHost.all('button').find(b => b.textContent === '+ Slide')!.click()
  const nextPpt = pptHandle.getPayload()
  expect(nextPpt.kind).toBe('presentation')
  if (nextPpt.kind === 'presentation') {
    expect(nextPpt.slides).toHaveLength(2)
    expect(nextPpt.slides[0]!.elements).toHaveLength(1)
  }

  // 3. MindMap editor (.xmind)
  const mindHost = new Element('host')
  let savedMind = false
  const mindHandle = mountOfficeViewer(container(mindHost), {
    kind: 'mindmap',
    activeSheet: 0,
    sheets: [{
      id: 's1',
      title: 'Product Map',
      rootTopic: {
        id: 'root',
        title: 'Central Idea',
        children: [{ id: 'c1', title: 'Branch A', children: [] }],
      },
    }],
  }, { editable: true, canSaveInPlace: true, onSave: async () => { savedMind = true; return { ok: true } } })
  expect(mindHost.all('svg').length).toBeGreaterThan(0)
  mindHost.all('button').find(b => b.textContent === '+ Subtopic')!.click()
  const nextMind = mindHandle.getPayload()
  expect(nextMind.kind).toBe('mindmap')
  if (nextMind.kind === 'mindmap') {
    expect(nextMind.sheets[0]!.rootTopic.children).toHaveLength(2)
  }
  await mindHandle.save()
  expect(savedMind).toBe(true)
})
