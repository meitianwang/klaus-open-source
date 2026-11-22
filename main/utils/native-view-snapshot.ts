// Still-frame capture for native child WebContentsViews before they step aside
// for a renderer overlay, so transparent or translucent overlays never expose
// a blank empty panel while the native view is hidden.

export interface CapturableNativeView {
  getVisible?: () => boolean;
  webContents?: {
    isDestroyed?: () => boolean;
    capturePage?: () => Promise<{
      isEmpty(): boolean;
      toJPEG(quality: number): Buffer;
    }>;
  };
}

export function canCaptureNativeViewSnapshot(view: CapturableNativeView | undefined): boolean {
  return Boolean(
    view
    && view.getVisible?.() !== false
    && !view.webContents?.isDestroyed?.()
    && typeof view.webContents?.capturePage === 'function',
  );
}

export async function captureNativeViewSnapshot(
  view: CapturableNativeView | undefined,
  quality = 82,
  timeoutMs = 180,
): Promise<string | undefined> {
  const capture = view?.webContents?.capturePage;
  if (!canCaptureNativeViewSnapshot(view) || typeof capture !== 'function') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const image = await Promise.race([
      capture.call(view!.webContents),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
    if (!image || image.isEmpty()) return undefined;
    return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
