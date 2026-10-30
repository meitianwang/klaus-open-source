import type { DesktopRuntime } from '../main/app/runtime';
import type { DesktopNotice } from '../main/services/notifications';
import type { Json } from '../main/ipc/contract';
import { kvGet, kvSet } from '../main/services/settings';
import { assert, assertEqual, Harness, waitFor } from './harness';

export async function testNotificationsApp(h: Harness, desktop: DesktopRuntime,
  invoke: (channel: string, value?: Json) => Promise<unknown>, configRoot: string,
  fixture: { notices: DesktopNotice[]; focus(value: boolean): void }): Promise<void> {
  await h.test('notification settings use the real browser permission and accessible independent toggles', async () => {
    const permission = await desktop.window.webContents.executeJavaScript(`({ name: Notification.name, permission: Notification.permission })`) as { name: string; permission: string };
    assert(permission.name !== 'HostNotification', 'the retired WKWebView permission shim is absent');
    assert(['default', 'denied', 'granted'].includes(permission.permission), 'the renderer reports a real notification permission state');
    try {
      kvSet('notification.desktop', 'on', configRoot); kvSet('notification.sound', 'off', configRoot);
      await desktop.window.webContents.executeJavaScript(`window.openSettings('preferences'); true`);
      await waitFor(() => desktop.window.webContents.executeJavaScript(`Boolean(document.getElementById('pref-notify-desktop') && document.getElementById('pref-notify-sound'))`), 5000, 'notification settings rendered');
      const accessibility = await desktop.window.webContents.executeJavaScript(`['pref-notify-desktop', 'pref-notify-sound'].map(id => {
        const input = document.getElementById(id); return { id, labelledby: input?.getAttribute('aria-labelledby'), describedby: input?.getAttribute('aria-describedby') };
      })`) as Array<{ id: string; labelledby: string | null; describedby: string | null }>;
      assert(accessibility.every(row => row.labelledby === `${row.id}-label` && row.describedby === `${row.id}-desc`), 'both notification switches expose their visible label and description');
      await desktop.window.webContents.executeJavaScript(`document.getElementById('pref-notify-desktop').click()`);
      await waitFor(() => kvGet('notification.desktop', configRoot) === 'off', 5000, 'desktop notification switch persisted off');
      await waitFor(() => desktop.window.webContents.executeJavaScript(`Boolean(document.getElementById('pref-notify-sound'))`), 5000, 'preferences remounted after save');
      await desktop.window.webContents.executeJavaScript(`document.getElementById('pref-notify-sound').click()`);
      await waitFor(() => kvGet('notification.sound', configRoot) === 'on', 5000, 'sound notification switch persisted on');
      assertEqual(kvGet('notification.desktop', configRoot), 'off', 'the sound switch does not re-enable banners');
    } finally {
      await desktop.window.webContents.executeJavaScript(`window.closeSettings(); true`).catch(() => undefined);
      kvSet('notification.desktop', 'on', configRoot); kvSet('notification.sound', 'off', configRoot);
    }
  });
  await h.test('real engine outcomes drive notification preferences and the ordinary sound subscriber', async () => {
    const row = await invoke('session:new', { workdir: configRoot }) as { id: string };
    await invoke('session:rename', { sessionId: row.id, title: 'Notification fixture' });
    desktop.window.webContents.setAudioMuted(true);
    await desktop.window.webContents.executeJavaScript(`window.__notificationSounds = []; window.__notificationOff = window.klaus.on.notifySound(kind => window.__notificationSounds.push(kind)); void 0;`);
    fixture.notices.length = 0;
    const sounds = (): Promise<string[]> => desktop.window.webContents.executeJavaScript('window.__notificationSounds');
    const send = async (text: string): Promise<void> => {
      await invoke('chat:send', { sessionId: row.id, text: `PLAIN FIXTURE ${text}` });
      await waitFor(async () => !(await invoke('session:list') as Array<{ id: string; isWorking: boolean }>).find(item => item.id === row.id)?.isWorking, 15000, 'notification turn completed');
    };
    try {
      kvSet('notification.desktop', 'on', configRoot); kvSet('notification.sound', 'on', configRoot); fixture.focus(false);
      await send('notify');
      await waitFor(async () => fixture.notices.some(value => value.sessionId === row.id) && (await sounds()).includes('done'), 5000, 'live notification and sound');
      const notice = fixture.notices.find(value => value.sessionId === row.id)!;
      assertEqual(notice.title, 'Notification fixture', 'normal session title reaches the host notification'); assert(!!notice.body, 'actual final reply body');
      const count = fixture.notices.length, soundCount = (await sounds()).length;
      fixture.focus(true); await send('focused');
      assertEqual(fixture.notices.length, count, 'focused foreground turn is quiet'); assertEqual((await sounds()).length, soundCount, 'focused sound suppressed');
      fixture.focus(false); kvSet('notification.desktop', 'off', configRoot); await send('sound only');
      await waitFor(async () => (await sounds()).length === soundCount + 1, 5000, 'sound-only push');
      assertEqual(fixture.notices.length, count, 'desktop preference is independent');
    } finally {
      fixture.focus(false); kvSet('notification.desktop', 'on', configRoot); kvSet('notification.sound', 'off', configRoot);
      await desktop.window.webContents.executeJavaScript('window.__notificationOff?.(); delete window.__notificationOff; delete window.__notificationSounds;');
      desktop.window.webContents.setAudioMuted(false);
      await invoke('session:delete', { sessionId: row.id });
    }
  });
  await h.test('an actual owned-engine crash reaches the UI once and the next request starts a replacement', async () => {
    await desktop.window.webContents.executeJavaScript('window.__engineCrashes = []; window.__engineCrashOff = window.klaus.on.engineProcessCrashed(value => window.__engineCrashes.push(value)); void 0;');
    const before = desktop.engine.inspect(); assertEqual(before.length, 1, 'one owned engine before fault injection');
    assert(typeof before[0]?.pid === 'number', 'owned engine PID is available');
    try {
      process.kill(before[0]!.pid!, 'SIGKILL');
      await waitFor(() => desktop.window.webContents.executeJavaScript('window.__engineCrashes.length === 1'), 10000, 'crash push delivered');
      const result = await desktop.sessions.request('config/read', {}); assert(!!result, 'replacement engine responds');
      const after = desktop.engine.inspect(); assertEqual(after.length, 1, 'one replacement engine'); assert(after[0]?.generation !== before[0]?.generation, 'new generation');
      assertEqual(await desktop.window.webContents.executeJavaScript('window.__engineCrashes.length'), 1, 'single disconnect notification');
    } finally { await desktop.window.webContents.executeJavaScript('window.__engineCrashOff?.(); delete window.__engineCrashes; delete window.__engineCrashOff;'); }
  });
}
