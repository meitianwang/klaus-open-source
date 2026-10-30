import { dialog, nativeImage, WebContentsView, type BrowserWindow, type Rectangle, type View } from 'electron';

interface Layer { view: WebContentsView; rect: Rectangle; clip: Rectangle }
function intersection(a: Rectangle, b: Rectangle): Rectangle {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}
function layers(window: BrowserWindow, bounds: Rectangle): Layer[] {
  const result: Layer[] = [];
  const visit = (parent: View, offset: { x: number; y: number }, clip: Rectangle): void => {
    for (const view of parent.children) {
      if (!view.getVisible()) continue;
      const box = view.getBounds(), rect = { ...box, x: offset.x + box.x, y: offset.y + box.y }, visible = intersection(clip, rect);
      if (!visible.width || !visible.height) continue;
      if (view instanceof WebContentsView && view.webContents !== window.webContents && !view.webContents.isDestroyed()) result.push({ view, rect, clip: visible });
      visit(view, rect, visible);
    }
  };
  visit(window.contentView, { x: 0, y: 0 }, bounds); return result;
}
const signature = (rows: Layer[]): string => JSON.stringify(rows.map(row => ({ id: row.view.webContents.id, rect: row.rect, clip: row.clip })));
/** Capture only this app's content views, including embedded pages; never request a desktop source. */
export async function captureFeedbackWindow(window: BrowserWindow): Promise<Buffer> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) throw new Error('No active window to capture');
  if (!window.isVisible() || window.isMinimized()) throw new Error('Show the app window before taking a screenshot');
  const [width, height] = window.getContentSize();
  if (!width || !height || width * height > 16_000_000) throw new Error('Invalid feedback window size');
  const bounds = { x: 0, y: 0, width, height };
  const views = layers(window, bounds), before = signature(views);
  const image = await window.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty()) throw new Error('screenshot_capture_failed');
  const bitmap = image.resize({ width, height }).toBitmap({ scaleFactor: 1 });
  if (bitmap.length !== width * height * 4) throw new Error('Invalid feedback capture bitmap');
  for (const { view, rect, clip } of views) {
    if (window.isDestroyed() || view.webContents.isDestroyed()) throw new Error('The capture window closed');
    const child = await view.webContents.capturePage(undefined, { stayHidden: true });
    if (child.isEmpty()) throw new Error('An embedded view could not be captured');
    const bytes = child.resize({ width: rect.width, height: rect.height }).toBitmap({ scaleFactor: 1 });
    if (bytes.length !== rect.width * rect.height * 4) throw new Error('Invalid embedded capture bitmap');
    for (let y = clip.y; y < clip.y + clip.height; y++) for (let x = clip.x; x < clip.x + clip.width; x++) {
      const source = ((y - rect.y) * rect.width + x - rect.x) * 4, target = (y * width + x) * 4, alpha = bytes[source + 3]! / 255;
      for (let channel = 0; channel < 3; channel++) bitmap[target + channel] = Math.round(bytes[source + channel]! + bitmap[target + channel]! * (1 - alpha));
      bitmap[target + 3] = Math.round(bytes[source + 3]! + bitmap[target + 3]! * (1 - alpha));
    }
  }
  if (window.isDestroyed() || window.getContentSize()[0] !== width || window.getContentSize()[1] !== height || signature(layers(window, bounds)) !== before) throw new Error('Window layout changed during capture; try again');
  return nativeImage.createFromBitmap(bitmap, { width, height, scaleFactor: 1 }).toPNG();
}
/** The host resolver must return only the authorized main window for this sender. */
export function createFeedbackWindowAdapter(resolveWindow: (senderId: number) => BrowserWindow | undefined): {
  pickAttachments(senderId: number): Promise<string[] | undefined>;
  captureScreenshot(senderId: number): Promise<Buffer>;
} {
  const owned = (senderId: number): BrowserWindow => {
    const window = resolveWindow(senderId);
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.id !== senderId) throw new Error('No active window to capture');
    return window;
  };
  return {
    pickAttachments: async senderId => {
      const window = owned(senderId), result = await dialog.showOpenDialog(window, { title: 'Select attachments', properties: ['openFile', 'multiSelections'] });
      if (window.isDestroyed()) return undefined; return result.canceled ? undefined : result.filePaths;
    },
    captureScreenshot: senderId => captureFeedbackWindow(owned(senderId)),
  };
}
