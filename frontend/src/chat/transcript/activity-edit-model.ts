import type { ActivityToolData } from './activity-tool-model'

export type EditFileKind = 'add' | 'update' | 'delete'
export type EditLineKind = 'added' | 'removed' | 'context' | 'hunk' | 'notice'

export interface EditDiffLine {
  kind: EditLineKind
  text: string
  oldLine?: number
  newLine?: number
}

export interface EditActivityFile {
  key: string
  path: string
  movePath?: string
  kind: EditFileKind
  lines: EditDiffLine[]
  diff: string
  added?: number
  removed?: number
  requested: boolean
  exact?: boolean
}

export interface EditActivityPresentation {
  files: EditActivityFile[]
  input: string
  result: string
  cwd: string
}

type ObjectValue = Record<string, unknown>

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch { return value }
}

function field(value: ObjectValue | null, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof value?.[key] === 'string') return value[key] as string
  return undefined
}

function number(value: ObjectValue | null, ...keys: string[]): number | undefined {
  for (const key of keys) if (typeof value?.[key] === 'number' && Number.isFinite(value[key]) && (value[key] as number) >= 0) return value[key] as number
  return undefined
}

function pathField(value: ObjectValue | null): string {
  return field(value, 'path', 'file_path', 'filePath', 'filename', 'notebook_path') ?? ''
}

function fileKind(value: unknown, fallback: EditFileKind = 'update'): EditFileKind {
  if (['add', 'create', 'created', 'added'].includes(String(value))) return 'add'
  if (['delete', 'remove', 'deleted', 'removed'].includes(String(value))) return 'delete'
  return fallback
}

function linesOf(text: string): string[] {
  if (!text) return []
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function complete(file: EditActivityFile): EditActivityFile {
  return {
    ...file,
    added: file.added ?? (file.lines.length ? file.lines.filter(line => line.kind === 'added').length : undefined),
    removed: file.removed ?? (file.lines.length ? file.lines.filter(line => line.kind === 'removed').length : undefined),
  }
}

function createFile(path: string, kind: EditFileKind, requested: boolean): EditActivityFile {
  return { key: path, path, kind, lines: [], diff: '', requested }
}

/** Parse both named patch operations and standard unified hunks without inventing missing line positions. */
export function parseActivityPatch(patch: string, fallbackPath = '', requested = true): EditActivityFile[] {
  const result: EditActivityFile[] = []
  let current: EditActivityFile | undefined
  let raw: string[] = []
  let oldLine: number | undefined, newLine: number | undefined, inHunk = false
  let oldRemaining = 0, newRemaining = 0
  const finish = () => {
    if (current) result.push(complete({ ...current, diff: raw.join('\n') }))
    current = undefined
    raw = []
    oldLine = undefined
    newLine = undefined
    inHunk = false
    oldRemaining = 0
    newRemaining = 0
  }
  for (const line of linesOf(patch)) {
    if (/^\*\*\* (?:Begin|End) Patch$/.test(line)) continue
    const operation = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line)
    const gitFile = /^diff --git (?:"a\/(.*?)"|a\/(\S+)) (?:"b\/(.*?)"|b\/(\S+))$/.exec(line)
    if (operation || gitFile) {
      finish()
      current = createFile(operation?.[2] ?? gitFile?.[3] ?? gitFile?.[4] ?? fallbackPath, operation ? fileKind(operation[1].toLowerCase()) : 'update', requested)
      if (current.kind === 'add') newLine = 1
      raw.push(line)
      continue
    }
    if (line.startsWith('--- ') && inHunk && oldRemaining === 0 && newRemaining === 0) finish()
    if (!current) current = createFile(fallbackPath, 'update', requested)
    raw.push(line)
    if (line.startsWith('*** Move to: ')) { current.movePath = line.slice(13); continue }
    if (!inHunk && line.startsWith('--- ')) {
      if (line === '--- /dev/null') current.kind = 'add'
      else if (!current.path) current.path = line.slice(4).replace(/^a\//, '').split('\t')[0]
      continue
    }
    if (!inHunk && line.startsWith('+++ ')) {
      if (line === '+++ /dev/null') current.kind = 'delete'
      else current.path = line.slice(4).replace(/^b\//, '').split('\t')[0]
      continue
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (line.startsWith('@@')) {
      oldLine = hunk ? Number(hunk[1]) : undefined
      newLine = hunk ? Number(hunk[3]) : undefined
      oldRemaining = hunk ? Number(hunk[2] ?? 1) : -1
      newRemaining = hunk ? Number(hunk[4] ?? 1) : -1
      current.lines.push({ kind: 'hunk', text: line })
      inHunk = true
    } else if (line.startsWith('+')) {
      current.lines.push({ kind: 'added', text: line.slice(1), newLine })
      if (newLine !== undefined) newLine++
      newRemaining--
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'removed', text: line.slice(1), oldLine })
      if (oldLine !== undefined) oldLine++
      oldRemaining--
    } else if (line.startsWith(' ')) {
      current.lines.push({ kind: 'context', text: line.slice(1), oldLine, newLine })
      if (oldLine !== undefined) oldLine++
      if (newLine !== undefined) newLine++
      oldRemaining--
      newRemaining--
    } else if (line.startsWith('\\ No newline') || line === '*** End of File') current.lines.push({ kind: 'notice', text: line })
    else if (!/^(?:index |new file mode |deleted file mode |old mode |new mode |similarity index |rename (?:from|to) )/.test(line)) current.lines.push({ kind: 'notice', text: line })
  }
  finish()
  return result.filter(file => file.path || file.lines.length).map(file => ({ ...file, key: file.key || file.path }))
}

/** Hirschberg keeps exact line matching while avoiding a quadratic allocation for large replacements. */
function commonLinePairs(before: string[], after: string[]): Array<[number, number]> {
  const matches: Array<[number, number]> = []
  const lengths = (left: string[], right: string[]) => {
    const row = new Uint32Array(right.length + 1)
    for (const value of left) {
      let diagonal = 0
      for (let index = 0; index < right.length; index++) {
        const previous = row[index + 1]
        row[index + 1] = value === right[index] ? diagonal + 1 : Math.max(row[index], previous)
        diagonal = previous
      }
    }
    return row
  }
  const match = (a: string[], b: string[], offsetA: number, offsetB: number) => {
    if (!a.length || !b.length) return
    if (a.length === 1) {
      const index = b.indexOf(a[0])
      if (index >= 0) matches.push([offsetA, offsetB + index])
      return
    }
    const middle = Math.floor(a.length / 2)
    const forward = lengths(a.slice(0, middle), b)
    const reverse = lengths(a.slice(middle).reverse(), b.slice().reverse())
    let split = 0, score = -1
    for (let index = 0; index <= b.length; index++) {
      const candidate = forward[index] + reverse[b.length - index]
      if (candidate > score) { score = candidate; split = index }
    }
    match(a.slice(0, middle), b.slice(0, split), offsetA, offsetB)
    match(a.slice(middle), b.slice(split), offsetA + middle, offsetB + split)
  }
  match(before, after, 0, 0)
  return matches
}

export function replacementDiff(beforeText: string, afterText: string): EditDiffLine[] {
  const before = linesOf(beforeText), after = linesOf(afterText)
  const pairs = commonLinePairs(before, after)
  const lines: EditDiffLine[] = []
  let oldIndex = 0, newIndex = 0
  for (const [oldMatch, newMatch] of [...pairs, [before.length, after.length]]) {
    while (oldIndex < oldMatch) lines.push({ kind: 'removed', text: before[oldIndex++] })
    while (newIndex < newMatch) lines.push({ kind: 'added', text: after[newIndex++] })
    if (oldMatch < before.length) { lines.push({ kind: 'context', text: before[oldIndex++] }); newIndex++ }
  }
  if (beforeText && afterText && beforeText.endsWith('\n') !== afterText.endsWith('\n')) {
    const trailing = lines.at(-1)
    if (trailing?.kind === 'context') {
      lines.pop()
      lines.push({ kind: 'removed', text: trailing.text })
      if (!beforeText.endsWith('\n')) lines.push({ kind: 'notice', text: '\\ No newline at end of file' })
      lines.push({ kind: 'added', text: trailing.text })
      if (!afterText.endsWith('\n')) lines.push({ kind: 'notice', text: '\\ No newline at end of file' })
    } else {
      const side = beforeText.endsWith('\n') ? 'added' : 'removed'
      let position = lines.length - 1
      while (position >= 0 && lines[position].kind !== side) position--
      if (position >= 0) lines.splice(position + 1, 0, { kind: 'notice', text: '\\ No newline at end of file' })
    }
  }
  return lines
}

function textualDiff(path: string, lines: EditDiffLine[]): string {
  return [`--- a/${path}`, `+++ b/${path}`, '@@', ...lines.map(line => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : line.kind === 'context' ? ' ' : ''}${line.text}`)].join('\n')
}

function changeFile(path: string, value: ObjectValue, requested: boolean, fallbackKind: EditFileKind = 'update'): EditActivityFile {
  let kind = fileKind(value.kind ?? value.type, fallbackKind)
  const patch = field(value, 'unified_diff', 'unifiedDiff', 'diff', 'patch')
  let file = patch ? parseActivityPatch(patch, path, requested)[0] : undefined
  if (file && value.kind === undefined && value.type === undefined) kind = file.kind
  file ??= createFile(path, kind, requested)
  const before = field(value, 'oldString', 'old_string', 'oldText', 'old_text', 'before')
  const after = field(value, 'newString', 'new_string', 'newText', 'new_text', 'after')
  const content = field(value, 'content', 'new_source', 'source')
  if (!patch && before !== undefined && after !== undefined) {
    file.lines = replacementDiff(before, after)
    file.diff = textualDiff(path, file.lines)
  } else if (!patch && content !== undefined) {
    file.lines = linesOf(content).map((text, index) => kind === 'add' ? { kind: 'added', text, newLine: index + 1 } : kind === 'delete' ? { kind: 'removed', text, oldLine: index + 1 } : { kind: 'context', text })
    file.diff = kind === 'update' ? content : textualDiff(path, file.lines)
  }
  const result = complete({ ...file, path: path || file.path, kind, movePath: field(value, 'movePath', 'move_path', 'move_to') ?? file.movePath, added: number(value, 'added', 'linesAdded', 'additions') ?? file.added, removed: number(value, 'removed', 'deleted', 'linesRemoved', 'deletions') ?? file.removed, exact: typeof value.exact === 'boolean' ? value.exact : undefined })
  if (!patch && before === undefined && content !== undefined && kind === 'update') {
    result.added = number(value, 'added', 'linesAdded', 'additions')
    result.removed = number(value, 'removed', 'deleted', 'linesRemoved', 'deletions')
  }
  return result
}

function inspectChanges(value: unknown, requested: boolean, fallbackPath = '', fallbackKind: EditFileKind = 'update'): EditActivityFile[] {
  const data = object(decode(value))
  if (!data) return typeof value === 'string' && /^(?:\*\*\* Begin Patch|diff --git|--- |@@)/m.test(value) ? parseActivityPatch(value, fallbackPath, requested) : []
  const patch = field(data, 'patch', 'unified_diff', 'unifiedDiff', 'diff')
  if (patch) return parseActivityPatch(patch, pathField(data) || fallbackPath, requested)
  if (Array.isArray(data.files)) return data.files.flatMap(value => { const file = object(value); return file && pathField(file) ? [changeFile(pathField(file), file, requested)] : [] })
  const changes = object(data.changes)
  if (changes) return Object.entries(changes).flatMap(([path, value]) => { const change = object(value); return change ? [changeFile(path, change, requested)] : [] })
  const path = pathField(data) || fallbackPath
  if (Array.isArray(data.edits)) return data.edits.flatMap(value => { const edit = object(value); return edit ? [changeFile(pathField(edit) || path, edit, requested)] : [] })
  if (path) return [changeFile(path, data, requested, fallbackKind)]
  return []
}

function inputText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

export function editActivityPresentation(tool: ActivityToolData): EditActivityPresentation {
  const args = decode(tool.args), data = object(args)
  const parsedResult = decode(tool.output ?? '')
  const output = object(parsedResult)
  const structured = object(output?.output) ?? object(output?.structuredContent) ?? output
  const directPath = pathField(data)
  const declaredKind = fileKind(structured?.kind)
  const requested = inspectChanges(args, true, directPath, declaredKind)
  const files: EditActivityFile[] = []
  for (const file of requested) {
    const previous = files.find(value => value.path === file.path)
    if (!previous) files.push(file)
    else {
      previous.lines.push({ kind: 'hunk', text: '@@' }, ...file.lines)
      previous.diff += `\n${file.diff}`
      previous.added = (previous.added ?? 0) + (file.added ?? 0)
      previous.removed = (previous.removed ?? 0) + (file.removed ?? 0)
    }
  }
  for (const actual of inspectChanges(structured, false, directPath, declaredKind)) {
    const candidates = files.filter(file => file.path === actual.path || actual.path.endsWith(`/${file.path}`))
    const previous = candidates.length === 1 ? candidates[0] : undefined
    if (!previous) files.push(actual)
    else {
      const index = files.indexOf(previous)
      files[index] = {
        ...previous,
        ...actual,
        key: previous.key,
        lines: actual.lines.length ? actual.lines : previous.lines,
        diff: actual.diff || previous.diff,
        requested: !actual.diff && previous.requested,
        added: actual.added ?? previous.added,
        removed: actual.removed ?? previous.removed,
        movePath: actual.movePath ?? previous.movePath,
      }
    }
  }
  return { files, input: inputText(tool.args), result: tool.output ?? '', cwd: field(data, 'cwd', 'workdir', 'working_directory') ?? '' }
}
