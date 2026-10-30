import { powerSaveRequest, type PowerSaveRequest, type PowerSaveSnapshot } from '../../../contracts/power-save';

export interface PowerSaveBridge {
  snapshot(): Promise<PowerSaveSnapshot>;
  subscribe(listener: (snapshot: PowerSaveSnapshot) => void): () => void;
  setRequest(request: PowerSaveRequest): Promise<unknown>;
}

/** One mounted policy observer per trusted main renderer. */
export function mountPowerSavePolicy(bridge: PowerSaveBridge, report: (error: unknown) => void): () => Promise<void> {
  let disposed = false, revision = -1, latest = 0, signature = '';
  let pending: Promise<void> = Promise.resolve();
  const reportActive = (error: unknown): void => {
    const code = (error as { data?: { error?: { code?: string } } } | null)?.data?.error?.code;
    // Shutdown refuses IPC before the window unloads; its final release is best effort.
    if (!disposed && code !== 'APP_CLOSING') report(error);
  };
  const send = (request: PowerSaveRequest): void => {
    const next = JSON.stringify(request);
    if (signature === next) return;
    signature = next;
    const sequence = ++latest;
    pending = pending.then(async () => {
      if (sequence !== latest) return;
      try { await bridge.setRequest(request); }
      catch (error) {
        if (sequence !== latest) return;
        signature = '';
        reportActive(error);
      }
    });
  };
  const observe = (snapshot: PowerSaveSnapshot): void => {
    if (disposed || snapshot.revision < revision) return;
    revision = snapshot.revision;
    send(powerSaveRequest(snapshot.preferences, snapshot.context));
  };
  const unsubscribe = bridge.subscribe(observe);
  void bridge.snapshot().then(observe, reportActive);
  return async () => {
    if (disposed) return pending;
    disposed = true;
    unsubscribe();
    send({ shouldBlock: false, keepRemoteControlAwakeWhilePluggedIn: false, preventDisplaySleep: false });
    await pending;
  };
}

export function bootPowerSavePolicy(): void {
  const api = (window as any).klaus;
  const dispose = mountPowerSavePolicy(api.powerSave, error => {
    console.error('Power policy update failed', error);
    (window as any).showToast?.((window as any).tt?.('power_update_failed') || 'Could not update sleep prevention');
  });
  window.addEventListener('pagehide', () => { void dispose(); }, { once: true });
}
