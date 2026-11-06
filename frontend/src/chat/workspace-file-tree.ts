import { FileTree, prepareFileTreeInput } from '@pierre/trees'
import { icon } from '../icons/registry'
import { tt } from '../app/i18n'
import type { WorkspaceNode } from './workspace-panel'

interface SearchHit { rel: string; name: string; isDir: boolean }
interface DirectoryResult { tree?: WorkspaceNode[]; truncated?: boolean; error?: string }
interface TreeOptions {
  host: HTMLElement
  sessionId: string
  root: string
  roots: string[]
  nodes: WorkspaceNode[]
  expanded: Set<string>
  selected: string
  list(path: string): Promise<DirectoryResult | null>
  search(query: string): Promise<{ hits?: SearchHit[]; truncated?: boolean; error?: string } | null>
  select(node: WorkspaceNode, preview: boolean): void
  context(event: MouseEvent, node: WorkspaceNode, row: HTMLElement): void
  rename(node: WorkspaceNode, name: string): Promise<void>
}

const TREE_CSS = `
:host {
  --trees-bg-override: var(--bg);
  --trees-bg-muted-override: color-mix(in srgb, var(--fg) 5%, transparent);
  --trees-fg-override: var(--fg);
  --trees-fg-muted-override: var(--fg-quaternary);
  --trees-font-family-override: var(--font);
  --trees-font-size-override: 13px;
  --trees-focus-ring-color-override: var(--input-focus);
  --trees-selected-bg-override: color-mix(in srgb, var(--fg) 8%, var(--bg));
  --trees-selected-fg-override: var(--fg);
  --trees-item-padding-x-override: 3px;
  --trees-item-margin-x-override: 0px;
  --trees-item-row-gap-override: 5px;
  --trees-level-gap-override: 0px;
  --trees-padding-inline-override: 0px;
  --trees-scrollbar-gutter-override: 0px;
  --trees-scrollbar-gutter-measured: 0px;
}
[data-item-section='spacing']:not(:empty) { margin-right: calc((1px - var(--trees-icon-width)) / 4); }
[data-item-section='spacing-item'] + [data-item-section='spacing-item'] { margin-left: calc(var(--trees-item-row-gap) + (var(--trees-icon-width) - 1px) / 4); }
[data-item-type='file'] > [data-item-section='spacing']:not(:empty) { margin-right: 0; }
[data-file-tree-sticky-overlay-content='true'], [data-file-tree-sticky-row='true'] { background-color: var(--bg); }
[data-file-tree-virtualized-scroll='true'] { scrollbar-gutter: auto; }
[role='treeitem'] { cursor: default; }
[data-item-type='folder'] [data-item-section='icon'] svg { width: 10px; height: 10px; }
`
const STORAGE_KEY = 'klaus.workspace-file-tree.v1'
interface SavedState { expanded: string[]; scrollTop: number }
function readState(sessionId: string): SavedState | undefined {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')[sessionId] } catch { return undefined }
}

/** A path-based virtual tree. Directory I/O stays on the existing workspace API. */
export class WorkspaceFileTree {
  private model?: FileTree
  private modelIsSearch = false
  private unsubscribe?: () => void
  private byKey = new Map<string, WorkspaceNode>()
  private keyByPath = new Map<string, string>()
  private loading = new Set<string>()
  private searchCache = new Map<string, { nodes: WorkspaceNode[]; truncated: boolean; created: number }>()
  private sequence = 0
  private query = ''
  private timer?: ReturnType<typeof setTimeout>
  private saveTimer?: ReturnType<typeof setTimeout>
  private disposed = false
  private readonly onScroll = () => this.scheduleSave()
  private resetting = false
  private scrollTop = 0
  private viewport = document.createElement('div')
  private status = document.createElement('div')
  private input = document.createElement('input')
  private clear = document.createElement('button')
  private normalNodes: WorkspaceNode[]

  constructor(private options: TreeOptions) {
    this.normalNodes = options.nodes
    const saved = readState(options.sessionId)
    if (!options.expanded.size) for (const path of saved?.expanded || []) options.expanded.add(path)
    this.scrollTop = saved?.scrollTop || 0
    options.host.replaceChildren()
    options.host.classList.add('workspace-tree-host')
    const filter = document.createElement('div')
    filter.className = 'workspace-tree-filter'
    const searchIcon = document.createElement('span')
    searchIcon.innerHTML = icon('titlebar-search')
    searchIcon.setAttribute('aria-hidden', 'true')
    this.input.type = 'search'
    this.input.placeholder = tt('workspace_filter_files')
    this.input.setAttribute('aria-label', tt('workspace_filter_files'))
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.clear.type = 'button'
    this.clear.hidden = true
    this.clear.innerHTML = icon('chat-workspace-close')
    this.clear.setAttribute('aria-label', tt('workspace_filter_clear'))
    this.clear.addEventListener('click', () => { this.input.value = ''; this.filter(''); this.input.focus() })
    this.input.addEventListener('input', () => this.filter(this.input.value))
    this.input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (this.input.value) { this.input.value = ''; this.filter('') }
        else this.model?.focusFirstItem()
      } else if (event.key === 'ArrowDown') { event.preventDefault(); this.model?.focusFirstItem() }
    })
    filter.append(searchIcon, this.input, this.clear)
    this.viewport.className = 'workspace-tree-viewport'
    this.status.className = 'workspace-tree-status'
    this.status.setAttribute('role', 'status')
    this.status.setAttribute('aria-live', 'polite')
    this.status.hidden = true
    options.host.append(filter, this.viewport, this.status)
    if (!options.selected) requestAnimationFrame(() => { if (!this.disposed) this.input.focus({ preventScroll: true }) })
    this.viewport.addEventListener('dblclick', event => {
      const row = event.composedPath().find(target => target instanceof HTMLElement && target.hasAttribute('data-item-path')) as HTMLElement | undefined
      const node = row && this.byKey.get(row.dataset.itemPath || '')
      if (node && !node.isDir) options.select(node, false)
    })
    this.render(this.normalNodes)
  }

  private index(nodes: WorkspaceNode[], prefix = ''): string[] {
    const paths: string[] = []
    const counts = new Map<string, number>()
    for (const node of nodes) if (node.name) counts.set(node.name, (counts.get(node.name) || 0) + 1)
    for (const node of nodes) {
      const name = node.name || node.path.split(/[\\/]/).pop() || node.path
      const suffix = (counts.get(name) || 0) > 1 ? ` (${node.path.replaceAll('\\', '/').split('/').slice(0, -1).filter(Boolean).join(' › ')})` : ''
      const key = prefix + name + suffix
      this.byKey.set(key, node)
      this.keyByPath.set(node.path, key)
      paths.push(key + (node.isDir ? '/' : ''))
      if (node.children?.length) paths.push(...this.index(node.children, key + '/'))
    }
    return paths
  }

  private render(nodes: WorkspaceNode[]): void {
    if (this.disposed) return
    this.resetting = true
    this.byKey.clear(); this.keyByPath.clear()
    const paths = this.index(nodes)
    const expanded = this.query ? [...this.byKey].filter(([, node]) => node.isDir).map(([key]) => key)
      : [...this.options.expanded].map(path => this.keyByPath.get(path)).filter((key): key is string => !!key)
    const preparedInput = prepareFileTreeInput(paths, { flattenEmptyDirectories: !!this.query })
    this.unsubscribe?.()
    if (this.model && this.modelIsSearch === !!this.query) {
      this.model.resetPaths({ preparedInput, initialExpandedPaths: expanded })
    } else {
      this.model?.cleanUp(); this.viewport.replaceChildren()
      this.modelIsSearch = !!this.query
      this.model = new FileTree({
        preparedInput,
        flattenEmptyDirectories: !!this.query,
        initialExpandedPaths: expanded,
        initialSelectedPaths: this.keyByPath.has(this.options.selected) ? [this.keyByPath.get(this.options.selected)!] : [],
        icons: { set: 'complete', colored: true },
        itemHeight: 28,
        stickyFolders: true,
        unsafeCSS: TREE_CSS,
        onSelectionChange: selected => {
          if (this.resetting) return
          const node = this.byKey.get(selected[selected.length - 1] || '')
          if (node && !node.isDir) this.options.select(node, true)
        },
        renaming: {
          onRename: event => {
            const node = this.byKey.get(event.sourcePath.replace(/\/$/, ''))
            if (node) void this.options.rename(node, event.destinationPath.replace(/\/$/, '').split('/').pop() || '')
          },
          onError: message => this.message(message),
        },
        composition: { contextMenu: {
          enabled: true, triggerMode: 'right-click',
          onOpen: (item, context) => {
            const node = this.byKey.get(item.path.replace(/\/$/, ''))
            if (node) this.options.context(new MouseEvent('contextmenu', { clientX: context.anchorRect.x, clientY: context.anchorRect.y }), node, context.anchorElement)
            context.close({ restoreFocus: false })
          },
        } },
      })
      this.model.render({ containerWrapper: this.viewport })
    }
    const container = this.model.getFileTreeContainer()
    container?.setAttribute('aria-label', tt('artifacts_section_outputs'))
    requestAnimationFrame(() => {
      if (this.disposed) return
      const scroller = this.scroller()
      if (scroller && !this.query) scroller.scrollTop = this.scrollTop
      scroller?.addEventListener('scroll', this.onScroll, { passive: true })
    })
    this.unsubscribe = this.model.subscribe(() => this.changed())
    this.resetting = false
    if (!paths.length) this.message(tt(this.query ? 'workspace_filter_no_results' : 'workspace_tree_empty_title'))
    else this.message('')
    this.changed()
  }

  private scroller(): HTMLElement | null {
    return this.model?.getFileTreeContainer()?.shadowRoot?.querySelector('[data-file-tree-virtualized-scroll="true"]') || null
  }

  private changed(): void {
    if (this.resetting || this.query || this.disposed) return
    for (const [key, node] of this.byKey) {
      if (!node.isDir) continue
      const item = this.model?.getItem(key)
      if (!item || !('isExpanded' in item)) continue
      if (item.isExpanded()) {
        this.options.expanded.add(node.path)
        if (node.childrenLoaded === false && !this.loading.has(node.path)) void this.load(node)
      } else this.options.expanded.delete(node.path)
    }
    this.scheduleSave()
  }

  private async load(node: WorkspaceNode): Promise<void> {
    this.loading.add(node.path)
    this.message(tt('loading'))
    try {
      const data = await this.options.list(node.path)
      if (this.disposed) return
      if (!data || data.error || !Array.isArray(data.tree)) throw new Error(data?.error || tt('workspace_tree_error_title'))
      const currentNode = this.findNormalNode(node.path)
      if (!currentNode) return
      this.retainChildren(data.tree, currentNode.children || [])
      currentNode.children = data.tree; currentNode.childrenLoaded = true; currentNode.truncated = data.truncated
      if (!this.query) { this.captureScroll(); this.render(this.normalNodes) }
      if (data.truncated) this.message(tt('workspace_directory_limited'))
    } catch (error) {
      if (!this.disposed) {
        this.message(`${node.name}: ${String(error instanceof Error ? error.message : error)}`)
        const retry = document.createElement('button')
        retry.type = 'button'; retry.textContent = tt('workspace_tree_retry')
        retry.addEventListener('click', () => void this.load(node))
        this.status.append(retry)
      }
    } finally { this.loading.delete(node.path) }
  }

  private message(value: string): void { this.status.textContent = value; this.status.hidden = !value }

  private findNormalNode(path: string, nodes = this.normalNodes): WorkspaceNode | undefined {
    for (const node of nodes) {
      if (node.path === path) return node
      const found = node.children && this.findNormalNode(path, node.children)
      if (found) return found
    }
  }

  private retainChildren(next: WorkspaceNode[], previous: WorkspaceNode[]): void {
    const byPath = new Map(previous.map(node => [node.path, node]))
    for (const node of next) {
      const old = byPath.get(node.path)
      if (node.isDir && node.childrenLoaded === false && old?.children?.length) node.children = old.children
    }
  }

  private filter(value: string): void {
    if (!this.query) this.captureScroll()
    this.query = value.trim(); this.clear.hidden = !value
    const sequence = ++this.sequence
    clearTimeout(this.timer)
    if (!this.query) { this.viewport.removeAttribute('aria-busy'); this.render(this.normalNodes); return }
    const query = this.query
    const cached = this.searchCache.get(query)
    if (cached && Date.now() - cached.created < 1000) {
      this.render(cached.nodes)
      if (cached.truncated) this.message(tt('workspace_filter_limited'))
      return
    }
    this.viewport.setAttribute('aria-busy', 'true')
    this.message(tt('loading'))
    this.timer = setTimeout(async () => {
      try {
        const result = await this.options.search(query)
        if (this.disposed || sequence !== this.sequence) return
        if (!result || result.error || !Array.isArray(result.hits)) throw new Error(result?.error || tt('workspace_tree_error_title'))
        const nodes = searchNodes(result.hits, this.options.root, this.options.roots)
        this.searchCache.set(query, { nodes, truncated: !!result.truncated, created: Date.now() })
        if (this.searchCache.size > 32) this.searchCache.delete(this.searchCache.keys().next().value!)
        this.render(nodes)
        if (result.truncated) this.message(tt('workspace_filter_limited'))
      } catch (error) {
        if (!this.disposed && sequence === this.sequence) {
          this.model?.cleanUp(); this.model = undefined; this.viewport.replaceChildren()
          this.message(`${tt('workspace_tree_error_title')}: ${String(error instanceof Error ? error.message : error)}`)
        }
      } finally { if (sequence === this.sequence) this.viewport.removeAttribute('aria-busy') }
    }, 120)
  }

  select(path: string): void {
    this.options.selected = path
    const key = this.keyByPath.get(path)
    if (!key) return
    const selectedPaths = this.model?.getSelectedPaths() || []
    if (selectedPaths.length === 1 && selectedPaths[0] === key) return
    this.resetting = true
    for (const selected of selectedPaths) if (selected !== key) this.model?.getItem(selected)?.deselect()
    this.model?.getItem(key)?.select()
    this.resetting = false
  }

  rename(path: string): void {
    const key = this.keyByPath.get(path)
    if (!key) return
    this.resetting = true
    try { this.model?.startRenaming(key) }
    finally { this.resetting = false }
  }

  update(nodes: WorkspaceNode[], truncated = false): void {
    this.retainChildren(nodes, this.normalNodes)
    this.captureScroll(); this.normalNodes = nodes; this.searchCache.clear()
    if (this.query) { this.filter(this.query); return }
    this.render(nodes)
    if (truncated) this.message(tt('workspace_directory_limited'))
  }

  private captureScroll(): void { if (!this.query) this.scrollTop = this.scroller()?.scrollTop ?? this.scrollTop }
  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), 100)
  }
  private save(): void {
    this.captureScroll()
    try {
      const states = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
      delete states[this.options.sessionId]
      states[this.options.sessionId] = { expanded: [...this.options.expanded], scrollTop: this.scrollTop }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(states).slice(-100))))
    } catch { /* Storage availability does not block browsing. */ }
  }
  dispose(): void {
    this.save(); this.disposed = true; this.sequence++
    clearTimeout(this.timer); clearTimeout(this.saveTimer)
    this.unsubscribe?.(); this.model?.cleanUp()
  }
}

/** Reconstruct ancestors without exposing absolute machine paths as tree labels. */
export function searchNodes(hits: SearchHit[], root: string, roots: string[]): WorkspaceNode[] {
  const nodes: WorkspaceNode[] = []
  const byPath = new Map<string, WorkspaceNode>()
  for (const hit of hits) {
    const absolute = /^(?:[\\/]|[A-Za-z]:[\\/])/.test(hit.rel)
    const path = absolute ? hit.rel.replaceAll('\\', '/') : root.replaceAll('\\', '/').replace(/\/$/, '') + '/' + hit.rel.replaceAll('\\', '/')
    const owner = [root, ...roots].map(value => value.replaceAll('\\', '/').replace(/\/$/, '')).sort((a, b) => b.length - a.length).find(value => path === value || path.startsWith(value + '/'))
    if (owner === undefined) continue
    const relative = path.slice(owner.length + 1)
    const parts = relative.split('/').filter(Boolean)
    if (parts.includes('..') || parts.includes('.')) continue
    let children = nodes
    let prefix = owner
    if (owner !== root.replaceAll('\\', '/').replace(/\/$/, '')) {
      let parent = byPath.get(owner)
      if (!parent) { parent = { path: owner, name: owner.split('/').pop(), isDir: true, children: [], childrenLoaded: true }; byPath.set(owner, parent); nodes.push(parent) }
      children = parent.children!
    }
    parts.forEach((name, index) => {
      prefix += '/' + name
      let node = byPath.get(prefix)
      if (!node) {
        const isDir = index < parts.length - 1 || hit.isDir
        node = { path: prefix, name, isDir, children: isDir ? [] : undefined, childrenLoaded: true }
        byPath.set(prefix, node); children.push(node)
      }
      children = node.children || []
    })
  }
  return nodes
}
