import { parseDiffFromFile, parsePatchFiles, processFile, type FileDiffMetadata } from '@pierre/diffs'
import type { DiffFile, DiffHunk, DiffDetail } from './store'

export interface ReviewFilters { hideWhitespace: boolean; hideImports: boolean }

/** Preserve patch coordinates and newline notes without trusting paths as patch syntax. */
export function patchForHunks(hunks: readonly DiffHunk[]): string {
  return '--- before\n+++ after\n' + hunks.map(hunk =>
    `@@ -${hunk.oldStart ?? 0},${hunk.oldLines ?? 0} +${hunk.newStart ?? 0},${hunk.newLines ?? 0} @@\n${(hunk.lines ?? []).join('\n')}\n`,
  ).join('')
}

/** Hide whole context-preserving hunks only when all their edits match the filter. */
export function visibleHunks(hunks: readonly DiffHunk[], filters: ReviewFilters): DiffHunk[] {
  return hunks.filter(hunk => {
    const lines = hunk.lines ?? []
    const removed = lines.filter(line => line.startsWith('-'))
    const added = lines.filter(line => line.startsWith('+'))
    if (filters.hideWhitespace && removed.length === added.length && removed.length > 0
      && removed.every((line, index) => line.slice(1).replace(/\s/g, '') === added[index].slice(1).replace(/\s/g, ''))) return false
    return true
  })
}

/** Syntax ranges prevent strings, comments and function-local imports being hidden. */
export async function importHunks(path: string, hunks: readonly DiffHunk[], before: string, after: string): Promise<Set<number>> {
  const hidden = new Set<number>()
  if (before.length > 1_000_000 || after.length > 1_000_000) return hidden
  if (!/\.(?:[cm]?[jt]sx?|java|py|rs|go)$/i.test(path)) return hidden
  const { languages } = await import('@codemirror/language-data')
  const { LanguageDescription } = await import('@codemirror/language')
  const language = LanguageDescription.matchFilename(languages, path)
  if (!language) return hidden
  const support = await language.load()
  const importLines = (text: string) => {
    const tree = support.language.parser.parse(text)
    const ranges: Array<[number, number]> = []
    tree.iterate({ enter(node) {
      if (!/^(?:ImportDeclaration|ImportStatement|UseDeclaration|ExternCrateDeclaration|ImportDecl)$/.test(node.name)) return
      if (node.node.parent?.from !== 0 || node.node.parent?.to !== text.length) return false
      if (/^pub\b/.test(text.slice(node.from, node.to))) return false
      ranges.push([node.from, node.to]); return false
    } })
    const lines = new Set<number>()
    let offset = 0
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim() || ranges.some(([start, end]) => {
        const a = Math.max(offset, start), b = Math.min(offset + line.length, end)
        return a <= b && !text.slice(offset, a).trim() && !text.slice(b, offset + line.length).trim()
      })) lines.add(index + 1)
      offset += line.length + 1
    }
    return lines
  }
  const oldImports = importLines(before), newImports = importLines(after)
  for (const [index, hunk] of hunks.entries()) {
    let old = hunk.oldStart ?? 0, next = hunk.newStart ?? 0, changed = false, imports = true
    for (const line of hunk.lines ?? []) {
      if (line.startsWith('-')) { changed = true; if (!oldImports.has(old++)) imports = false }
      else if (line.startsWith('+')) { changed = true; if (!newImports.has(next++)) imports = false }
      else if (line.startsWith(' ')) { old++; next++ }
    }
    if (changed && imports) hidden.add(index)
  }
  return hidden
}

export function reviewMetadata(file: DiffFile, hunks: readonly DiffHunk[], detail: DiffDetail | undefined,
  filters: ReviewFilters, identity: string): FileDiffMetadata | null {
  const selected = visibleHunks(hunks, filters)
  let original: FileDiffMetadata | undefined
  try { if (detail?.patch) original = parsePatchFiles(detail.patch, identity + ':patch', true)[0]?.files[0] } catch {}
  if (!selected.length && (hunks.length || original?.hunks.length)) return null
  const oldFile = detail?.oldContent !== undefined ? { name: file.previousPath ?? file.path, contents: detail.oldContent } : undefined
  const newFile = detail?.newContent !== undefined ? { name: file.path, contents: detail.newContent } : undefined
  let model: FileDiffMetadata | undefined
  if (oldFile && newFile) {
    model = filters.hideImports && selected.length
      ? processFile(patchForHunks(selected), { oldFile, newFile, throwOnError: true })
      : parseDiffFromFile(original?.type === 'new' ? null : oldFile, original?.type === 'deleted' ? null : newFile,
        { ignoreWhitespace: filters.hideWhitespace })
  } else if (selected.length) model = filters.hideWhitespace || filters.hideImports
    ? parsePatchFiles(patchForHunks(selected), identity, true)[0]?.files[0]
    : original ?? parsePatchFiles(patchForHunks(selected), identity, true)[0]?.files[0]
  else model = original
  if (!model) return null
  model.name = file.path
  if (original) {
    model.type = original.type
    model.mode = original.mode
    model.prevMode = original.prevMode
  }
  if (file.previousPath) { model.prevName = file.previousPath; model.type = model.hunks.length ? 'rename-changed' : 'rename-pure' }
  model.cacheKey = identity
  return model
}

export interface FileTreeNode {
  key: string
  label: string
  children?: FileTreeNode[]
  file?: DiffFile
}

/** Compress a directory chain while keeping repository and entry identities distinct. */
export function fileTree(files: readonly DiffFile[], keyFor: (file: DiffFile) => string,
  repositories: readonly { root: string; name: string }[] = []): FileTreeNode[] {
  const multi = new Set(files.map(file => file.repositoryRoot ?? '')).size > 1
  const roots: FileTreeNode[] = []
  for (const file of files) {
    let list = roots
    let parent = ''
    const parts = file.path.split('/').filter(Boolean)
    if (multi) parts.unshift(repositories.find(repo => repo.root === file.repositoryRoot)?.name ?? file.repositoryRoot ?? '')
    for (const [index, label] of parts.entries()) {
      parent += '/' + label
      if (index === parts.length - 1) { list.push({ key: keyFor(file), label, file }); break }
      const key = `${file.repositoryRoot ?? ''}:${parent}`
      let directory = list.find(node => node.key === key && node.children)
      if (!directory) { directory = { key, label, children: [] }; list.push(directory) }
      list = directory.children!
    }
  }
  const compress = (nodes: FileTreeNode[]): FileTreeNode[] => nodes.sort((a, b) =>
    Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.label.localeCompare(b.label),
  ).map(node => {
    if (!node.children) return node
    let current = { ...node, children: compress(node.children) }
    while (current.children.length === 1 && current.children[0].children) {
      const child = current.children[0]
      current = { ...child, label: current.label + '/' + child.label, children: child.children! }
    }
    return current
  })
  return compress(roots)
}
