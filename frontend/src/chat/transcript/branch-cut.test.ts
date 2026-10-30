// The fork cut point for an assistant reply is the first persisted user row
// after it. The main transcript wraps every turn in its own container, so that
// user row opens the NEXT wrapper and is never a sibling of the clicked reply;
// a sibling-only walk found nothing and silently forked the whole conversation.
// These cases pin the document-order walk on both layouts: wrapped turns (main
// transcript) and the flat row list (static and side surfaces).
import { describe, expect, test } from 'bun:test'

// The stream store touches `window` at module scope, so the shim has to exist
// BEFORE anything that imports `TranscriptView`.
;(globalThis as any).window = { ...(globalThis as any).window, addEventListener: () => {}, currentLang: 'en' }
const { branchCutUuidAfter, persistedCutUuid } = await import('./TranscriptView')
const { chatStreamStore } = await import('../stream-store')

/** Minimal element tree: exactly the properties the cut-point walk reads. */
class El {
  classes = new Set<string>()
  attrs: Record<string, string> = {}
  parent: El | null = null
  children: El[] = []
  uuid = ''
  constructor(classes: string[] = [], attrs: Record<string, string> = {}) {
    classes.forEach(name => this.classes.add(name))
    this.attrs = attrs
  }
  append(...kids: El[]) {
    kids.forEach(kid => { kid.parent = this; this.children.push(kid) })
    return this
  }
  get classList() { return { contains: (name: string) => this.classes.has(name) } }
  get dataset() { return this.uuid ? { uuid: this.uuid } : {} }
  // Explicit return types: the getters reference each other through `parent`,
  // and bare inference then circles back to an implicit any (TS7023).
  get firstElementChild(): El | null { return this.children[0] ?? null }
  get parentElement(): El | null { return this.parent }
  get nextElementSibling(): El | null {
    if (!this.parent) return null
    const index = this.parent.children.indexOf(this)
    return this.parent.children[index + 1] ?? null
  }
  closest(selector: string): El | null {
    const attr = selector.match(/^\[(.+)\]$/)?.[1]
    let node: El | null = this
    while (node) {
      if (attr && node.attrs[attr] !== undefined) return node
      node = node.parent
    }
    return null
  }
  contains(other: El | null) {
    let node = other
    while (node) {
      if (node === this) return true
      node = node.parent
    }
    return false
  }
}
const userRow = (uuid = '') => { const row = new El(['msg-group', 'user']); row.uuid = uuid; return row }
const assistantRow = () => new El(['msg-group', 'assistant'])
const turnWrapper = () => new El([], { 'data-klaus-transcript-turn': '' })
const asHtml = (el: El) => el as unknown as HTMLElement

describe('the fork cut point after an assistant reply', () => {
  test('crosses the turn wrapper to the user row that opens the next turn', () => {
    // THE regression: the main transcript puts each turn in its own container,
    // so the next user row is the first child of the NEXT sibling wrapper.
    const root = new El()
    const u1 = userRow('u1'), a1 = assistantRow()
    const u2 = userRow('u2'), a2 = assistantRow()
    root.append(turnWrapper().append(u1, a1), turnWrapper().append(u2, a2))
    expect(branchCutUuidAfter(asHtml(a1))).toBe('u2')
  })

  test('the last reply has no cut point, so the fork inherits everything', () => {
    const root = new El()
    const u1 = userRow('u1'), a1 = assistantRow()
    root.append(turnWrapper().append(u1, a1))
    expect(branchCutUuidAfter(asHtml(a1))).toBe('')
  })

  test('rows between the reply and the next turn do not stop the walk', () => {
    // A finished turn appends its changed-files and media blocks after the
    // reply inside the same wrapper; the walk must pass through them.
    const root = new El()
    const u1 = userRow('u1'), a1 = assistantRow(), changes = new El(['turn-changes'])
    const u2 = userRow('u2')
    root.append(turnWrapper().append(u1, a1, changes), turnWrapper().append(u2))
    expect(branchCutUuidAfter(asHtml(a1))).toBe('u2')
  })

  test('a user row without a persisted uuid is skipped, not taken as the cut', () => {
    // Positional fallback keys are not message identities; cutting at one
    // would fail loudly on the engine instead of forking.
    const root = new El()
    const u1 = userRow('u1'), a1 = assistantRow()
    const ghost = userRow(''), u3 = userRow('u3')
    root.append(turnWrapper().append(u1, a1), turnWrapper().append(ghost), turnWrapper().append(u3))
    expect(branchCutUuidAfter(asHtml(a1))).toBe('u3')
  })

  test('the flat layout still cuts at the next sibling user row', () => {
    // Static and side surfaces render rows as plain siblings of one container.
    const root = new El()
    const u1 = userRow('u1'), a1 = assistantRow(), u2 = userRow('u2')
    root.append(u1, a1, u2)
    expect(branchCutUuidAfter(asHtml(a1))).toBe('u2')
  })
})

describe('the persisted uuid behind a live optimistic row', () => {
  // A stopped turn keeps its optimistic bubble on screen with a client-only
  // `submission:` id; the fork cut point must be the uuid the engine stored.
  const elWith = (dataset: Record<string, string>) => ({ dataset }) as unknown as HTMLElement
  const seed = (history: any[], liveUnits: any[] = []) => {
    chatStreamStore.setState({ sessions: { sess: { history, liveUnits } } } as any)
  }

  test('a persisted uuid passes through untouched', () => {
    expect(persistedCutUuid('sess', null, 'u1')).toBe('u1')
  })

  test('the row saved edit handle wins over the display id', () => {
    expect(persistedCutUuid('sess', elWith({ editUuid: 'p1', uuid: 'submission:x' }), 'submission:x')).toBe('p1')
  })

  test('a stopped turn resolves through its turn id against saved history', () => {
    seed([{ uuid: 'p1', turnId: 't1', role: 'user' }])
    expect(persistedCutUuid('sess', elWith({ editTurn: 't1', uuid: 'submission:x' }), 'submission:x')).toBe('p1')
  })

  test('compaction and subagent rows of the same turn are not cut points', () => {
    seed([
      { uuid: 'b1', turnId: 't1', role: 'user', kind: 'compaction' },
      { uuid: 'm1', turnId: 't1', role: 'user', kind: 'agent-message' },
      { uuid: 'p1', turnId: 't1', role: 'user' },
    ])
    expect(persistedCutUuid('sess', elWith({ editTurn: 't1', uuid: 'submission:x' }), 'submission:x')).toBe('p1')
  })

  test('an unresolvable display id is returned for the caller to refuse', () => {
    seed([])
    expect(persistedCutUuid('sess', elWith({ uuid: 'submission:x' }), 'submission:x')).toBe('submission:x')
  })

  test('the walk after an assistant reply resolves an optimistic next user row', () => {
    seed([{ uuid: 'p2', turnId: 't2', role: 'user' }], [{ msg: { uuid: 'submission:x' }, turnId: 't2' }])
    const root = new El()
    const u1 = userRow('u1'), a1 = assistantRow()
    root.append(turnWrapper().append(u1, a1), turnWrapper().append(userRow('submission:x')))
    expect(branchCutUuidAfter(asHtml(a1), 'sess')).toBe('p2')
  })
})
