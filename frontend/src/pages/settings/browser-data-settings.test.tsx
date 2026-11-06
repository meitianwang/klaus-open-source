import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Window } from 'happy-dom'

let React: any
let act: any
let createRoot: any
let BrowserDataSettings: any
let happyWindow: any
const roots = new Set<any>()
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function labels() {
  return {
    credentials: {
      title: 'Passwords and autofill',
      description: 'Saved locally and protected by the operating system.',
      passwordsTitle: 'Passwords',
      addressesTitle: 'Addresses',
      contactsTitle: 'Contacts',
      originLabel: 'Site',
      usernameLabel: 'Username',
      passwordLabel: 'Password',
      labelLabel: 'Label',
      saveButton: 'Save',
      revealButton: 'Reveal',
      copyButton: 'Copy',
      deleteButton: 'Delete',
      emptyPasswords: 'No saved passwords',
      emptyProfiles: 'No saved profiles',
      importButton: 'Import',
      fullNameLabel: 'Full name',
      companyLabel: 'Company',
      addressLine1Label: 'Address line 1',
      addressLine2Label: 'Address line 2',
      cityLabel: 'City',
      stateLabel: 'State',
      postalCodeLabel: 'Postal code',
      countryLabel: 'Country',
      phoneLabel: 'Phone',
      emailLabel: 'Email',
      contactNameLabel: 'Name',
      cancelButton: 'Cancel',
      errorLabel: 'Error',
      copySucceeded: 'Password copied',
    },
    extensionsTitle: 'Browser extensions',
    extensionsDescription: 'Install and manage extensions for the built-in browser.',
    extensionPathLabel: 'Extension folder',
    installExtension: 'Install extension',
    refreshExtensions: 'Refresh',
    emptyExtensions: 'No extensions installed',
    enabledLabel: 'Enabled',
    disabledLabel: 'Disabled',
    loadedLabel: 'Loaded',
    notLoadedLabel: 'Not loaded',
    permissionsLabel: 'Permissions',
    enableAction: 'Enable',
    disableAction: 'Disable',
    removeAction: 'Remove',
    installFailed: 'Could not install extension',
    extensionActionFailed: 'Could not update extension',
  }
}

function makeApi(options: { choose?: () => Promise<any>; list?: () => Promise<any> } = {}) {
  let extensions = [{
    id: 'extension-one',
    name: 'Test Extension',
    version: '1.2.3',
    enabled: false,
    loaded: false,
    path: '/tmp/extension-one',
    permissions: ['storage', 'tabs'],
  }]
  const installs: any[] = []
  const toggles: any[] = []
  const removes: string[] = []
  const copies: string[] = []
  let installFailure = ''
  let listCalls = 0
  let chooseCalls = 0
  const apiExtensions: any = {
    list: async () => {
      listCalls += 1
      return options.list ? options.list() : { items: extensions }
    },
    install: async (input: any) => {
      installs.push(input)
      if (installFailure) throw new Error(installFailure)
      extensions = [...extensions, {
        id: 'extension-two', name: 'Second Extension', version: '2.0.0',
        enabled: true, loaded: true, path: input.path, permissions: [],
      }]
      return extensions.at(-1)
    },
    setEnabled: async (id: string, enabled: boolean) => {
      toggles.push({ id, enabled })
      extensions = extensions.map(item => item.id === id ? { ...item, enabled, loaded: enabled } : item)
      return extensions.find(item => item.id === id)
    },
    remove: async (id: string) => {
      removes.push(id)
      extensions = extensions.filter(item => item.id !== id)
    },
  }
  if (options.choose) {
    apiExtensions.choose = async () => {
      chooseCalls += 1
      return options.choose!()
    }
  }
  return {
    get installs() { return installs },
    get toggles() { return toggles },
    get removes() { return removes },
    get copies() { return copies },
    get listCalls() { return listCalls },
    get chooseCalls() { return chooseCalls },
    setInstallFailure(value: string) { installFailure = value },
    addExtension(item: any) { extensions = [...extensions, item] },
    api: {
      extensions: apiExtensions,
      credentials: {
        listPasswords: async () => [{
          id: 'password-one', originUrl: 'https://example.test', username: 'alice',
          createdAt: 1, updatedAt: 2,
        }],
        savePassword: async (input: any) => ({ id: 'password-one', ...input, createdAt: 1, updatedAt: 2 }),
        revealPassword: async () => 'secret',
        copyPassword: async (id: string) => { copies.push(id) },
        deletePassword: async () => {},
        importPasswords: async () => ({ total: 0, imported: 0, updated: 0, skipped: 0, failed: 0, items: [] }),
        listAutofillProfiles: async () => [],
        getAutofillProfile: async () => null,
        saveAutofillProfile: async () => ({ id: 'profile-one', kind: 'address', label: 'Home', createdAt: 1, updatedAt: 1 }),
        updateAutofillProfile: async () => ({ id: 'profile-one', kind: 'address', label: 'Home', createdAt: 1, updatedAt: 1 }),
        deleteAutofillProfile: async () => {},
      },
    },
  }
}

function buttonByText(text: string) {
  return Array.from(happyWindow.document.querySelectorAll('button')).find(
    (node: any) => node.textContent?.trim() === text,
  ) as any
}

async function click(node: any) {
  await act(async () => {
    node.dispatchEvent(new happyWindow.MouseEvent('click', { bubbles: true }))
  })
}

async function setInputValue(input: any, value: string) {
  await act(async () => {
    input.focus?.()
    input.dispatchEvent(new happyWindow.Event('focusin', { bubbles: true }))
    input.dispatchEvent(new happyWindow.KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    const setter = Object.getOwnPropertyDescriptor(happyWindow.HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(input, value)
    else input.value = value
    input.dispatchEvent(new happyWindow.InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
    input.dispatchEvent(new happyWindow.Event('change', { bubbles: true }))
    input.dispatchEvent(new happyWindow.KeyboardEvent('keyup', { key: 'a', bubbles: true }))
  })
}

async function mount(api: any, l: any) {
  const container = happyWindow.document.createElement('div')
  happyWindow.document.body.appendChild(container)
  const root = createRoot(container)
  roots.add(root)
  await act(async () => {
    root.render(React.createElement(BrowserDataSettings, { api, labels: l }))
  })
  return { container, root }
}

async function unmount(root: any) {
  roots.delete(root)
  await act(async () => { root.unmount() })
}

beforeAll(async () => {
  happyWindow = new Window({ url: 'http://localhost/' })
  const host = globalThis as any
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
  }
  host.window = happyWindow
  host.document = happyWindow.document
  host.navigator = happyWindow.navigator
  host.HTMLElement = happyWindow.HTMLElement
  host.Node = happyWindow.Node
  host.Event = happyWindow.Event
  host.MouseEvent = happyWindow.MouseEvent
  host.CustomEvent = happyWindow.CustomEvent
  host.MutationObserver = happyWindow.MutationObserver
  host.getComputedStyle = happyWindow.getComputedStyle.bind(happyWindow)
  host.requestAnimationFrame = (callback: any) => setTimeout(() => callback(Date.now()), 0)
  host.cancelAnimationFrame = (id: any) => clearTimeout(id)
  host.IS_REACT_ACT_ENVIRONMENT = true
  React = await import('react')
  act = React.act
  createRoot = (await import('react-dom/client')).createRoot
  BrowserDataSettings = (await import('./browser-data-settings')).BrowserDataSettings
})

afterEach(() => {
  for (const root of roots) {
    roots.delete(root)
    try { root.unmount() } catch {}
  }
  happyWindow.document.body.innerHTML = ''
})

afterAll(() => {
  happyWindow.close?.()
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete (globalThis as any)[key]
  }
  savedGlobals.clear()
})

describe('browser data settings', () => {
  test('renders extension and credential data with injected labels and no tooltips', async () => {
    const fake = makeApi()
    const { container, root } = await mount(fake.api, labels())
    expect(container.textContent).toContain('Browser extensions')
    expect(container.textContent).toContain('Test Extension')
    expect(container.textContent).toContain('https://example.test')
    expect(container.querySelector('[title]')).toBeNull()
    expect(container.querySelector('[data-klaus-tip]')).toBeNull()
    await unmount(root)
  })

  test('install uses the injected path API and refreshes the real list', async () => {
    const fake = makeApi()
    const { container, root } = await mount(fake.api, labels())
    const input = container.querySelector('input') as any
    await setInputValue(input, '/tmp/second-extension')
    await click(buttonByText('Install extension'))
    expect(fake.installs).toEqual([{ path: '/tmp/second-extension' }])
    expect(container.textContent).toContain('Second Extension')
    await unmount(root)
  })

  test('choose uses the production picker without calling install again', async () => {
    let fake: any
    const chosen = {
      id: 'extension-chosen',
      name: 'Chosen Extension',
      version: '3.0.0',
      enabled: true,
      loaded: true,
      path: '/tmp/chosen-extension',
      permissions: [],
    }
    fake = makeApi({
      choose: async () => {
        fake.addExtension(chosen)
        return { item: chosen }
      },
    })
    const { container, root } = await mount(fake.api, labels())
    expect(container.textContent).not.toContain('Extension folder')
    await click(buttonByText('Install extension'))
    expect(fake.chooseCalls).toBe(1)
    expect(fake.installs).toEqual([])
    expect(fake.listCalls).toBe(2)
    expect(container.textContent).toContain('Chosen Extension')
    await unmount(root)
  })

  test('a cancelled choose does not install or refresh the list', async () => {
    const fake = makeApi({ choose: async () => ({ cancelled: true }) })
    const { root } = await mount(fake.api, labels())
    await click(buttonByText('Install extension'))
    expect(fake.chooseCalls).toBe(1)
    expect(fake.installs).toEqual([])
    expect(fake.listCalls).toBe(1)
    await unmount(root)
  })

  test('a stale list response cannot overwrite the latest list', async () => {
    const base = {
      id: 'extension-one',
      name: 'Test Extension',
      version: '1.2.3',
      enabled: false,
      loaded: false,
      path: '/tmp/extension-one',
      permissions: [],
    }
    const enabled = { ...base, enabled: true, loaded: true }
    const stale = deferred<any>()
    const fresh = deferred<any>()
    let listCall = 0
    const fake = makeApi({
      list: () => {
        listCall += 1
        if (listCall === 1) return Promise.resolve({ items: [base] })
        if (listCall === 2) return stale.promise
        if (listCall === 3) return fresh.promise
        return Promise.resolve({ items: [enabled] })
      },
    })
    const { container, root } = await mount(fake.api, labels())
    await click(buttonByText('Refresh'))
    await click(buttonByText('Enable'))
    await act(async () => { fresh.resolve({ items: [enabled] }) })
    await act(async () => { stale.resolve({ items: [base] }) })
    expect(container.textContent).toContain('Enabled · Loaded')
    expect(container.textContent).not.toContain('Disabled · Not loaded')
    await unmount(root)
  })

  test('enable, disable and remove stay on the injected API and surface failures', async () => {
    const fake = makeApi()
    const { container, root } = await mount(fake.api, labels())
    await click(buttonByText('Enable'))
    expect(fake.toggles).toEqual([{ id: 'extension-one', enabled: true }])
    await click(buttonByText('Disable'))
    expect(fake.toggles.at(-1)).toEqual({ id: 'extension-one', enabled: false })
    await click(buttonByText('Remove'))
    expect(fake.removes).toEqual(['extension-one'])
    expect(container.textContent).toContain('No extensions installed')

    fake.setInstallFailure('manifest is invalid')
    const input = container.querySelector('input') as any
    await setInputValue(input, '/tmp/bad-extension')
    await click(buttonByText('Install extension'))
    expect(container.textContent).toContain('Could not install extension: manifest is invalid')
    expect(container.textContent).not.toContain('Second Extension')
    await unmount(root)
  })

  test('copy delegates the secret to the host API', async () => {
    const fake = makeApi()
    const { root } = await mount(fake.api, labels())
    await click(buttonByText('Copy'))
    expect(fake.copies).toEqual(['password-one'])
    expect(happyWindow.document.body.textContent).not.toContain('secret')
    await unmount(root)
  })
})
