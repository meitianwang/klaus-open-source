import { afterAll, beforeAll, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

let React: typeof import('react')
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let createPortal: typeof import('react-dom').createPortal
let islands: typeof import('./retained-island')
let queueModule: typeof import('./follow-up-queue')
let modelModule: typeof import('./model-select')
let permissionModule: typeof import('./permission-select')
let happy: any
const originals = new Map<string, PropertyDescriptor | undefined>()
beforeAll(async () => {
  happy = new Window({ url: 'http://localhost/' })
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    ;(globalThis as any)[key] = key === 'window' ? happy : key === 'IS_REACT_ACT_ENVIRONMENT' ? true
      : typeof happy[key] === 'function' && ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].includes(key) ? happy[key].bind(happy) : happy[key]
  }
  happy.currentLang = 'en'
  happy.tt = (key: string) => key
  happy.klaus = { session: { getPermissionMode: async () => ({ mode: 'bypassPermissions' }), setUltraMode: async () => ({ ok: true }), setPermissionMode: async () => ({ ok: true }) } }
  React = await import('react'); act = React.act
  createRoot = (await import('react-dom/client')).createRoot
  createPortal = (await import('react-dom')).createPortal
  islands = await import('./retained-island')
  queueModule = await import('./follow-up-queue')
  modelModule = await import('./model-select')
  permissionModule = await import('./permission-select')
})
afterAll(async () => {
  await happy.happyDOM.cancelAsync()
  happy.close()
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value)
    else delete (globalThis as any)[key]
  }
})
function container() { const element = document.createElement('div'); document.body.append(element); return element }
async function click(element: Element | null) {
  expect(element).not.toBeNull()
  await act(async () => { (element as HTMLElement).click() })
}

test('Activity preserves authored DOM state while hidden handlers and transient portals are suspended', async () => {
  let effects = 0
  function Probe() {
    const [count, setCount] = React.useState(0)
    const [open, setOpen] = islands.useRetainedOpenState()
    React.useEffect(() => {
      effects++
      const update = () => setCount(value => value + 1)
      document.addEventListener('probe-input', update)
      return () => { effects--; document.removeEventListener('probe-input', update) }
    }, [])
    return <><input defaultValue="Initial" /><span>{count}</span><button onClick={() => setOpen(true)}>Open</button>{open && createPortal(<section data-transient="true" />, document.body)}</>
  }
  const root = container()
  let api!: ReturnType<typeof islands.mountRetainedIsland>
  await act(async () => { api = islands.mountRetainedIsland(createRoot(root), () => <Probe />) })
  const input = root.querySelector('input')!
  input.value = 'New authored text'; input.setSelectionRange(2, 6)
  await act(async () => { document.dispatchEvent(new Event('probe-input')) })
  await click(root.querySelector('button'))
  expect(document.querySelector('[data-transient]')).not.toBeNull()
  await act(async () => { api.setVisible(false) })
  expect(effects).toBe(0)
  expect(document.querySelector('[data-transient]')).toBeNull()
  document.dispatchEvent(new Event('probe-input'))
  await act(async () => { api.setVisible(true) })
  expect(effects).toBe(1)
  expect(root.querySelector('span')!.textContent).toBe('1')
  expect(root.querySelector('input')).toBe(input)
  expect(input.value).toBe('New authored text')
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6])
  expect(document.querySelector('[data-transient]')).toBeNull()
  await act(async () => { api.dispose() })
  expect(effects).toBe(0)
  expect(root.childNodes.length).toBe(0)
  root.remove()
})

test('the real queue closes its body portal before deferring hidden work and retains its row on return', async () => {
  const root = container()
  let api!: NonNullable<ReturnType<typeof queueModule.mountFollowUpQueue>>
  await act(async () => {
    api = queueModule.mountFollowUpQueue(root, { onResume() {}, onDeliver() {}, onEdit() {}, onDelete() {}, onReorder() {}, onToggleQueueing() {} })!
    api.render([{ id: 'retained-row', preview: 'Retained input', summary: '', summaryOnly: false, paused: false, mutationPending: false, pausedTitle: '', pausedDetail: '', dispatching: false, thumbnail: null }], null, true, 'owner')
  })
  await click(root.querySelector('[data-follow-up-action="more"]'))
  expect(document.querySelector('[data-follow-up-action="edit"]')).not.toBeNull()
  await act(async () => { api.setVisible(false) })
  expect(document.querySelector('[data-follow-up-action="edit"]')).toBeNull()
  await act(async () => { api.setVisible(true) })
  expect(root.textContent).toContain('Retained input')
  expect(document.querySelector('[data-follow-up-action="edit"]')).toBeNull()
  await act(async () => { api.dispose() })
  expect(root.childNodes.length).toBe(0)
  root.remove()
})

test('model and permission confirmations cannot survive hiding or publish an old selection', async () => {
  const modelRoot = container(), permissionRoot = container()
  let writes = 0
  happy.klaus.session.setUltraMode = happy.klaus.session.setPermissionMode = async () => { writes++; return { ok: true } }
  let model!: NonNullable<ReturnType<typeof modelModule.mountModelSelect>>
  let permission!: NonNullable<ReturnType<typeof permissionModule.mountPermissionSelect>>
  await act(async () => {
    model = modelModule.mountModelSelect(modelRoot, { getSessionId: () => 'owner' })!
    model.setItems([{ value: 'custom:test', label: 'Retained model' }], { value: 'custom:test' })
    permission = permissionModule.mountPermissionSelect(permissionRoot, () => 'owner')!
    permission.setValue('default')
  })
  await click(modelRoot.querySelector('button[aria-haspopup="menu"]'))
  await click(modelRoot.querySelector('.kls-select-panel button[aria-haspopup="menu"]'))
  await click(modelRoot.querySelector('[data-ultra-row]'))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => { model.setVisible(false); model.setVisible(true) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(modelRoot.textContent).toContain('Retained model')
  await click(permissionRoot.querySelector('button[aria-haspopup="menu"]'))
  await click(permissionRoot.querySelector('[data-preset="bypassPermissions"]'))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => { permission.setVisible(false); permission.setVisible(true) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(writes).toBe(0)
  await act(async () => { model.dispose(); permission.dispose() })
  expect(modelRoot.childNodes.length + permissionRoot.childNodes.length).toBe(0)
  modelRoot.remove(); permissionRoot.remove()
})
