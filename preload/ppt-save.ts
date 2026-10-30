// The shell calls this only for an export registered in its own download queue.
export function installPresentationSave(): void {
  const page = globalThis as unknown as {
    location: { origin: string };
    __klausPresentationToolExport?: string;
    klausPresentationNativeSave?: (file: { filename: string; bytes: ArrayBuffer; request: string }) => Promise<{ ok: boolean; error?: string }>;
    postMessage(value: unknown, origin: string, transfer?: ArrayBuffer[]): void;
    addEventListener(name: string, callback: (event: { source: unknown; origin: string; data: { __klausPptSaved?: boolean; id?: string; result?: { ok: boolean; error?: string } } }) => void): void;
  };
  const pending = new Map<string, { resolve(value: { ok: boolean; error?: string }): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0;
  page.addEventListener('message', event => {
    if (event.source !== page || event.origin !== page.location.origin || event.data?.__klausPptSaved !== true || typeof event.data.id !== 'string') return;
    const wait = pending.get(event.data.id);
    if (!wait) return;
    pending.delete(event.data.id); clearTimeout(wait.timer);
    wait.resolve(event.data.result ?? { ok: false, error: 'The file save was not confirmed.' });
  });
  Object.defineProperty(page, 'klausPresentationNativeSave', { configurable: false, writable: false, value: (file: { filename: string; bytes: ArrayBuffer; request: string }) => new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    if (!(file.bytes instanceof ArrayBuffer) || !file.bytes.byteLength || file.bytes.byteLength > 200 * 1024 * 1024) { reject(new Error('Invalid presentation export bytes.')); return; }
    const id = `save${++sequence}`, bytes = file.bytes.slice(0);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The file save was not confirmed.')); }, 120_000);
    pending.set(id, { resolve, reject, timer });
    try { page.postMessage({ __klausPptSave: true, id, filename: file.filename, bytes, request: file.request, tool: page.__klausPresentationToolExport }, page.location.origin, [bytes]); }
    catch (error) { pending.delete(id); clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); }
  }) });
}
