import { describe, expect, test } from 'bun:test'

// The embedded browser reports the intrinsic width of a horizontally
// overflowing page; the panel widens to exactly that width (capped by what the
// window can give it) and never shrinks a document that already fits. These
// cases drive the state machine through one module instance in sequence,
// because the lock/unlock rules are inherently sequential.
describe('browser panel auto width', () => {
  test('widens to overflowing content, caps by window, yields to manual drags', async () => {
    const names = ['window', 'document', 'requestAnimationFrame', 'ResizeObserver', 'getComputedStyle'] as const
    const previous = names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)

    let appWidth = 1000
    let maximized = false
    const styleProps: Record<string, string> = {}
    const documentElement = {
      style: {
        setProperty: (key: string, value: string) => { styleProps[key] = value },
        getPropertyValue: (key: string) => styleProps[key] || '',
      },
    }
    const panel = { getAttribute: () => 'browser', classList: { contains: () => false } }
    const host = {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 460, height: 600 }),
      classList: { contains: () => false, toggle: () => {} },
    }
    const resizerAttrs: Record<string, string> = {}
    const values = {
      window: {
        innerWidth: 1000,
        currentSessionId: 'session-a',
        addEventListener: () => {},
        klaus: { on: {}, browserUse: {} },
      },
      document: {
        hidden: false,
        documentElement,
        body: { classList: { contains: (name: string) => name === 'artifacts-maximized' && maximized } },
        querySelector: () => null,
        getElementById: (id: string) => {
          if (id === 'artifacts-panel') return panel
          if (id === 'browser-panel-host') return host
          if (id === 'app') return { getBoundingClientRect: () => ({ width: appWidth }) }
          if (id === 'sidebar') return { classList: { contains: () => false }, getBoundingClientRect: () => ({ width: 300 }) }
          if (id === 'artifacts-panel-resizer') return { setAttribute: (key: string, value: string) => { resizerAttrs[key] = value } }
          return null
        },
      },
      requestAnimationFrame: (callback: FrameRequestCallback) => { void callback; return 1 },
      ResizeObserver: class { observe() {} },
      getComputedStyle: () => ({
        getPropertyValue: (key: string) => styleProps[key] || '460px',
      }),
    }

    const widthNow = () => parseFloat(styleProps['--artifacts-panel-width'] || '460')
    const push = (surface: any, patch: Record<string, unknown>) => surface.syncBrowserAutoWidth({
      tabId: 'tab-1', url: 'http://127.0.0.1:8765/report.html',
      loading: false, ...patch,
    }, true)

    let surface: any = null
    try {
      for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: values[name] })
      surface = await import('./browser-auto-width')

      // cap = min(1400, 1000 - 300 - 420) = 280: a 2000px page gets the cap.
      push(surface, { contentRevision: 1, contentWidth: 2000 })
      expect(widthNow()).toBe(280)
      expect(resizerAttrs['aria-valuenow']).toBe('280')

      // A later "fits" reading of the SAME document must not shrink it back.
      push(surface, { contentRevision: 2, contentWidth: 0 })
      expect(widthNow()).toBe(280)

      // Maximized panel owns the whole row: measurements stay out of it.
      maximized = true
      push(surface, { contentRevision: 3, contentWidth: 3000 })
      expect(widthNow()).toBe(280)
      maximized = false

      // A reload restores the user's own width before re-measuring.
      push(surface, { loading: true, contentRevision: 3, contentWidth: 3000 })
      expect(widthNow()).toBe(460)
      push(surface, { contentRevision: 4, contentWidth: 900 })
      expect(widthNow()).toBe(280)

      // A wider window lifts the cap: 900px of content asks for 916.
      appWidth = 2000
      values.window.innerWidth = 2000
      push(surface, { contentRevision: 5, contentWidth: 900 })
      expect(widthNow()).toBe(916)

      // A manual drag wins for the rest of the document…
      surface.noteBrowserPanelManualResize()
      push(surface, { contentRevision: 6, contentWidth: 2000 })
      expect(widthNow()).toBe(916)
      // …and a reload lifts that deference again.
      push(surface, { loading: true, contentRevision: 6, contentWidth: 2000 })
      push(surface, { contentRevision: 7, contentWidth: 2000 })
      expect(widthNow()).toBe(Math.min(1400, 2000 - 300 - 420))
    } finally {
      surface?.resetBrowserAutoWidth?.()
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    }
  })
})
