// Receiving-computer settings row: the picker moved from the friends page to
// the Settings profile card, so these tests pin (1) the controller's runtime
// read/write behaviour, (2) the row's signed-out/empty rendering, and (3) the
// relocation itself at source level so the row cannot drift back into the
// friends page.
import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18N } from '../../i18n/messages'
import type { FriendsRuntimeSnapshot } from '../../../../shared/friends'

const installWindow = (friends: unknown) => {
  (globalThis as any).window = {
    currentLang: 'zh',
    tt: (key: string) => I18N.zh[key] ?? key,
    addEventListener: () => {},
    removeEventListener: () => {},
    klaus: { friends },
  }
}

const snapshot = (selected: string | null, signedIn = true): FriendsRuntimeSnapshot => ({
  signedIn,
  currentDeviceId: 'd1',
  receiver: {
    selectedDeviceId: selected,
    devices: [
      { id: 'd1', name: 'Primary Test Computer', platform: 'macOS', online: true, supportsFriendsMessaging: true, isCurrent: true },
      { id: 'd2', name: 'Secondary Test Computer', platform: 'Windows', online: false, supportsFriendsMessaging: true, isCurrent: false },
    ],
  },
  tasks: [], outgoing: [],
  templates: [], defaultGrant: { deviceId: 'local', mode: 'manual', computerUse: false, apps: [], directories: [], remember: false, network: false, policy: 'approve' },
  friendFilesRoot: '/tmp/klaus-friends',
  executionTargets: { projects: [], workspaces: [] },
})

const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

installWindow({ runtime: async () => snapshot('d1'), setReceiver: async () => snapshot('d2') })
const { createReceiverController, ReceiverSettings } = await import('./ReceiverSettings')

describe('receiving computer settings', () => {
  beforeEach(() => installWindow({ runtime: async () => snapshot('d1'), setReceiver: async () => snapshot('d2') }))

  test('refresh loads the runtime snapshot and setReceiver swaps the selection', async () => {
    const calls: string[] = []
    const controller = createReceiverController({
      runtime: async () => { calls.push('runtime'); return snapshot('d1') },
      setReceiver: async args => { calls.push(`set:${args.deviceId}`); return snapshot(args.deviceId) },
    })
    expect(controller.getSnapshot().runtime).toBeNull()
    await controller.refresh()
    expect(controller.getSnapshot().runtime?.receiver?.selectedDeviceId).toBe('d1')
    expect(controller.getSnapshot().loading).toBe(false)
    const ok = await controller.setReceiver('d2')
    expect(ok).toBe(true)
    expect(controller.getSnapshot().runtime?.receiver?.selectedDeviceId).toBe('d2')
    expect(controller.getSnapshot().busy).toBeNull()
    expect(calls).toEqual(['runtime', 'set:d2'])
    controller.dispose()
  })

  test('a failed receiver write surfaces the host error and clears busy', async () => {
    const controller = createReceiverController({
      runtime: async () => snapshot('d1'),
      setReceiver: async () => { throw new Error('relay offline') },
    })
    await controller.refresh()
    const ok = await controller.setReceiver('d2')
    expect(ok).toBe(false)
    expect(controller.getSnapshot().error).toBe('relay offline')
    expect(controller.getSnapshot().busy).toBeNull()
    expect(controller.getSnapshot().runtime?.receiver?.selectedDeviceId).toBe('d1')
    controller.dispose()
  })

  test('the row renders the empty selection with a disabled change control before runtime resolves', () => {
    installWindow({ runtime: async () => snapshot('d1'), setReceiver: async () => snapshot('d2') })
    const markup = renderToStaticMarkup(<ReceiverSettings />)
    expect(markup).toContain('接收电脑')
    expect(markup).toContain('全部在线电脑（默认）')
    expect(markup).toContain('更改')
    expect(markup).toContain('disabled=""')
    // The picker dialog only exists while choosing; the row itself must not
    // pre-render the device list.
    expect(markup).not.toContain('Primary Test Computer')
  })

  test('the row lives in its own settings tab, not on the friends page or the profile card', () => {
    const friendsPage = source('./FriendsPage.tsx')
    expect(friendsPage).not.toContain('setChoosingReceiver')
    expect(friendsPage).not.toContain('styles.receiver')
    expect(friendsPage).not.toContain('deviceOption')
    const friendsTab = source('../settings/friends-tab.tsx')
    expect(friendsTab).toContain('<ReceiverSettings />')
    expect(friendsTab).toContain('<SettingsPage')
    expect(source('../settings/profile-tab.tsx')).not.toContain('ReceiverSettings')
    expect(source('../settings/settings-nav-entries.ts')).toContain("stab: 'friends'")
    expect(source('../settings/shell.ts')).toContain("case 'friends': w().loadFriendsSettingsTab(content); break")
    expect(source('../settings/index.tsx')).toContain('loadFriendsSettingsTab')
  })
})
