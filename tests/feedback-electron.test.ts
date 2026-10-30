import assert from 'node:assert/strict';
import { app, BrowserWindow, WebContentsView, View, nativeImage } from 'electron';
import { join } from 'node:path';
import { captureFeedbackWindow, createFeedbackWindowAdapter } from '../main/feedback/window';
import { Harness } from './harness';

const h = new Harness();
const data = (color: string): string => 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><body style="margin:0;background:' + color + ';height:100vh"></body>');
const pixel = (image: Electron.NativeImage, x: number, y: number): number[] => {
  const bytes = image.toBitmap({ scaleFactor: 1 }), index = (y * image.getSize().width + x) * 4;
  return [bytes[index + 2]!, bytes[index + 1]!, bytes[index]!, bytes[index + 3]!];
};
void (async () => {
  if (!process.env.KLAUS_FEEDBACK_FIXTURE_PROFILE) throw new Error('A fixture profile is required');
  app.setPath('userData', process.env.KLAUS_FEEDBACK_FIXTURE_PROFILE);
  await app.whenReady();
  const deadline = setTimeout(() => { process.stderr.write('Feedback fixture deadline exceeded\n'); app.exit(1); }, 30_000);
  const window = new BrowserWindow({ show: false, width: 160, height: 120, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const views: WebContentsView[] = [];
  try {
    await window.loadURL(data('rgb(0,0,255)'));
    await h.test('a never-shown window is refused without displaying or focusing it', async () => {
      await assert.rejects(captureFeedbackWindow(window), /Show the app window/);
      assert.equal(window.isVisible(), false); assert.equal(window.isFocused(), false);
    });
    await h.test('a visible app-only capture has real page pixels without acquiring focus', async () => {
      window.showInactive();
      await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const image = nativeImage.createFromBuffer(await captureFeedbackWindow(window));
      const [width, height] = window.getContentSize(); assert.deepEqual(image.getSize(), { width, height }); assert.deepEqual(pixel(image, 5, 5), [0, 0, 255, 255]);
      assert.equal(window.isVisible(), true); assert.equal(window.isFocused(), false);
    });
    await h.test('embedded pages are included while hidden siblings and parent-clipped pixels are excluded', async () => {
      const parent = new View(); window.contentView.addChildView(parent); parent.setBounds({ x: 20, y: 20, width: 50, height: 40 });
      const child = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } }); views.push(child); parent.addChildView(child);
      child.setBounds({ x: 0, y: 0, width: 80, height: 80 }); await child.webContents.loadURL(data('rgb(255,0,0)'));
      const hidden = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); views.push(hidden); window.contentView.addChildView(hidden);
      hidden.setBounds({ x: 0, y: 0, width: 160, height: 120 }); await hidden.webContents.loadURL(data('rgb(0,255,0)')); hidden.setVisible(false);
      window.showInactive();
      await child.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const image = nativeImage.createFromBuffer(await captureFeedbackWindow(window));
      assert.deepEqual(pixel(image, 25, 25), [255, 0, 0, 255]); assert.deepEqual(pixel(image, 80, 25), [0, 0, 255, 255]); assert.deepEqual(pixel(image, 5, 5), [0, 0, 255, 255]);
      parent.setVisible(false);
      assert.deepEqual(pixel(nativeImage.createFromBuffer(await captureFeedbackWindow(window)), 25, 25), [0, 0, 255, 255]);
      assert.equal(window.isFocused(), false); window.hide();
    });
    await h.test('the capture adapter rejects a foreign renderer and destroyed main window', async () => {
      const adapter = createFeedbackWindowAdapter(() => window);
      assert.throws(() => adapter.captureScreenshot(window.webContents.id + 1000), /No active window/);
      const sender = window.webContents.id; window.destroy();
      assert.throws(() => adapter.captureScreenshot(sender), /No active window/);
    });
  } finally { for (const view of views) if (!view.webContents.isDestroyed()) view.webContents.close(); if (!window.isDestroyed()) window.destroy(); }
  clearTimeout(deadline);
  const code = await h.finish(join(__dirname, 'feedback-electron-result.json'), 'feedback-electron'); app.exit(code);
})().catch(error => { process.stderr.write(String(error) + '\n'); app.exit(1); });
