import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  buildBrowserAnnotationText,
  createBrowserAnnotationSelection,
  finalizeBrowserAnnotation,
  normalizeRegion,
  pointerToViewportPoint,
  shouldCropBrowserAnnotationScreenshot,
  type BrowserAnnotationAnchor,
  type BrowserAnnotationSnapshot,
} from '../frontend/src/chat/browser-annotation-core'
import { BrowserAnnotationOverlay } from '../frontend/src/chat/browser-annotation-view'
import { browserAnnotationSaveRequest, type BrowserAnnotationHostSnapshot } from '../frontend/src/chat/browser-annotation-controller'
import type { BrowserAnnotationLabels } from '../frontend/src/chat/browser-annotation-core'

const labels: BrowserAnnotationLabels = { title: '批注页面', hint: '点击元素或拖拽选择区域', note: '备注', cancel: '取消', submit: '添加到对话', element: '元素', region: '区域' }
import {
  annotationCaptureRequest,
  normalizeAnnotationRegion,
  validateAnnotationScreenshotMetadata,
} from '../main/browser/annotation'

const snapshot: BrowserAnnotationSnapshot = {
  id: 'capture-1',
  tabId: 'tab-1',
  url: 'http://localhost:3000/checkout',
  title: 'Checkout',
  previewUrl: 'klaus-media://preview/capture-1.png',
  width: 800,
  height: 600,
  capturedAt: 1,
}

const element: BrowserAnnotationAnchor = {
  kind: 'element',
  selector: '#pay',
  tagName: 'button',
  selectedText: 'Pay now',
  rect: { x: 100, y: 120, width: 200, height: 40 },
}

const regionAnchor: BrowserAnnotationAnchor = {
  kind: 'region',
  rect: { x: 40, y: 50, width: 320, height: 180 },
  selectedText: 'Order summary',
}

describe('browser annotation geometry', () => {
  test('maps a rendered image point into capture CSS pixels', () => {
    expect(pointerToViewportPoint(300, 200, { x: 100, y: 50, width: 400, height: 300 }, snapshot))
      .toEqual({ x: 400, y: 300 })
  })

  test('normalizes a reverse drag and clamps it to the viewport', () => {
    expect(normalizeRegion({ x: 900, y: -10 }, { x: 100, y: 500 }, snapshot))
      .toEqual({ x: 100, y: 0, width: 700, height: 500 })
  })

  test('rejects a region below the minimum drag size', () => {
    expect(normalizeRegion({ x: 10, y: 10 }, { x: 15, y: 15 }, snapshot)).toBeNull()
  })

  test('cropping is limited to a pure region in necessary mode', () => {
    expect(shouldCropBrowserAnnotationScreenshot('always', regionAnchor)).toBe(false)
    expect(shouldCropBrowserAnnotationScreenshot('necessary', regionAnchor)).toBe(true)
    expect(shouldCropBrowserAnnotationScreenshot('necessary', element)).toBe(false)
    expect(shouldCropBrowserAnnotationScreenshot('necessary', regionAnchor, [element])).toBe(false)
  })
})

describe('browser annotation composer payload', () => {
  test('carries URL, title, anchor identity, selected text, region and note', () => {
    const text = buildBrowserAnnotationText({
      snapshot,
      anchor: element,
      note: 'This button is too low.',
    })
    expect(text).toContain('URL: http://localhost:3000/checkout')
    expect(text).toContain('Title: Checkout')
    expect(text).toContain('Element: #pay')
    expect(text).toContain('Selected text: "Pay now"')
    expect(text).toContain('This button is too low.')
  })

  test('sufficient mode crops only a pure region', () => {
    expect(createBrowserAnnotationSelection({ snapshot, anchor: regionAnchor, note: '', screenshotMode: 'necessary' }).cropScreenshot).toBe(true)
    expect(createBrowserAnnotationSelection({ snapshot, anchor: element, note: '', screenshotMode: 'necessary' }).cropScreenshot).toBe(false)
  })

  test('finalization uses the durable host path and preview only for display', () => {
    const selection = createBrowserAnnotationSelection({ snapshot, anchor: regionAnchor, note: 'Check spacing', screenshotMode: 'necessary' })
    const payload = finalizeBrowserAnnotation(selection, {
      path: '/content-addressed/screenshots/abc.png',
      name: 'checkout-annotation.png',
      mimeType: 'image/png',
      size: 2048,
      width: 320,
      height: 180,
      previewUrl: 'klaus-media://preview/abc.png',
    })
    expect(payload.attachment.uploadPath).toBe('/content-addressed/screenshots/abc.png')
    expect(payload.attachment.objectUrl).toBe('klaus-media://preview/abc.png')
    expect(payload.text).toContain('Region: 40,50 320x180')
    expect(payload.text).toContain('Check spacing')
    expect(JSON.stringify(payload)).not.toContain('data:image')
  })
})

describe('main annotation helper', () => {
  test('requests a crop only for necessary pure region selections', () => {
    expect(annotationCaptureRequest('necessary', regionAnchor, [], snapshot)).toEqual({
      format: 'png',
      clip: { x: 40, y: 50, width: 320, height: 180, scale: 1 },
      captureBeyondViewport: false,
    })
    expect(annotationCaptureRequest('necessary', element, [], snapshot).clip).toBeUndefined()
    expect(annotationCaptureRequest('always', regionAnchor, [], snapshot).clip).toBeUndefined()
    expect(annotationCaptureRequest('necessary', regionAnchor, [element], snapshot).clip).toBeUndefined()
  })

  test('normalizes crops with the same viewport bounds', () => {
    expect(normalizeAnnotationRegion({ x: 700, y: 500, width: 300, height: 300 }, snapshot))
      .toEqual({ x: 700, y: 500, width: 100, height: 100 })
  })

  test('rejects data URLs as durable annotation paths', () => {
    expect(() => validateAnnotationScreenshotMetadata({
      path: 'data:image/png;base64,AAAA',
      name: 'annotation.png',
      mimeType: 'image/png',
      size: 10,
      width: 10,
      height: 10,
    })).toThrow(/durable host path/)
  })
})

describe('BrowserAnnotationOverlay structure', () => {
  test('renders a static image, note field and explicit cancel/submit controls', () => {
    const html = renderToStaticMarkup(
      <BrowserAnnotationOverlay
        snapshot={snapshot}
        screenshotMode="necessary"
        labels={labels}
        onCancel={() => {}}
        onSubmit={() => {}}
        onAnchorAt={() => element}
      />,
    )
    expect(html).toContain('data-browser-annotation-overlay="true"')
    expect(html).toContain('src="klaus-media://preview/capture-1.png"')
    expect(html).toContain('<textarea')
    expect(html).toContain('取消')
    expect(html).toContain('添加到对话')
    expect(html).toContain('Checkout')
    expect(html).not.toContain('window.klaus')
  })
})


const hostSnapshot: BrowserAnnotationHostSnapshot = {
  snapshotId: 'snap-1', sessionId: 'session-1', tabId: 'tab-1', focusRevision: 7,
  url: 'http://localhost:3000', title: 'Synthetic', previewUrl: 'data:image/png;base64,AA==',
  width: 800, height: 600, capturedAt: 1,
}

describe('controller mode consumption', () => {
  test('crop is present only for a necessary pure region', () => {
    const region = createBrowserAnnotationSelection({ snapshot, anchor: regionAnchor, note: '', screenshotMode: 'necessary' })
    expect(browserAnnotationSaveRequest(region, hostSnapshot).crop).toEqual(regionAnchor.rect)
    const elementSelection = createBrowserAnnotationSelection({ snapshot, anchor: element, note: '', screenshotMode: 'necessary' })
    expect(browserAnnotationSaveRequest(elementSelection, hostSnapshot).crop).toBeUndefined()
    const always = createBrowserAnnotationSelection({ snapshot, anchor: regionAnchor, note: '', screenshotMode: 'always' })
    expect(browserAnnotationSaveRequest(always, hostSnapshot).crop).toBeUndefined()
  })
})
