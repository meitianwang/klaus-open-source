import { expect, test } from 'bun:test'

test('Canvas opens after late layout and never presents an invalidated queued activation', async () => {
  const names = ['window','document','requestAnimationFrame','ResizeObserver'] as const
  const previous = names.map(name => [name,Object.getOwnPropertyDescriptor(globalThis,name)] as const)
  let mode = '', shows = 0, resized = 0, width = 500, observe!: () => void
  let releaseHide: (() => void) | undefined, holdHide = false
  const shown: string[] = []
  const frames: FrameRequestCallback[] = []
  const panel = { getAttribute:()=>mode, classList:{contains:()=>false} }
  const host = { getBoundingClientRect:()=>({left:10,top:20,width,height:600}) }
  const api = {
    panelShow:async(path:string)=>{ shows++; shown.push(path); return {ok:true} }, panelSetBounds:async()=>{ resized++; return {ok:true} },
    panelHide:async()=>{ if(holdHide) await new Promise<void>(resolve=>{releaseHide=resolve});return {ok:true} }, panelClose:async()=>({ok:true}), onOpenPanel:()=>{}, openResult:async()=>({ok:true}),
  }
  const values = {
    window:{klaus:{canvas:api},openArtifactsPanel:()=>{mode='canvas'},addEventListener:()=>{}},
    document:{getElementById:(id:string)=>id==='artifacts-panel'?panel:host},
    requestAnimationFrame:(callback:FrameRequestCallback)=>{frames.push(callback);return frames.length},
    ResizeObserver:class { constructor(callback:()=>void){observe=callback} observe(){} },
  }
  try {
    for (const name of names) Object.defineProperty(globalThis,name,{configurable:true,value:values[name]})
    const surface = await import('./canvas-panel')
    surface.initCanvasPanel()
    const opening = surface.activateCanvasPanel({path:'/fixture/first.canvas.tsx'})
    observe()
    for (const callback of frames.splice(0)) callback(0)
    // A native bounds reply can finish before the second layout frame.
    for (let index=0;index<10;index++) await Promise.resolve()
    for (const callback of frames.splice(0)) callback(16)
    expect(await opening).toBe(true)
    expect(shows).toBe(1)
    expect(resized).toBe(0)
    const frame = async () => {
      for (const callback of frames.splice(0)) callback(32)
      for (let index=0;index<30;index++) await Promise.resolve()
    }
    await surface.closeCanvasPanel()
    width = 0
    const late = surface.activateCanvasPanel({path:'/fixture/late.canvas.tsx'})
    await frame(); await frame(); expect(await late).toBe(false)
    expect(shows).toBe(1)
    width = 500; observe(); await frame()
    expect(shows).toBe(2)
    expect(shown.at(-1)).toBe('/fixture/late.canvas.tsx')
    expect(resized).toBe(0)
    width = 550; observe(); await frame()
    expect(resized).toBe(1)
    holdHide = true
    const hidden = surface.hideCanvasPanel()
    for (let index=0;index<10;index++) await Promise.resolve()
    const invalidated = surface.activateCanvasPanel({path:'/fixture/closed.canvas.tsx'})
    await frame(); await frame()
    const closed = surface.closeCanvasPanel()
    const current = surface.activateCanvasPanel({path:'/fixture/current.canvas.tsx'})
    await frame(); await frame()
    releaseHide!(); holdHide = false
    await Promise.all([hidden, invalidated, closed, current])
    expect(shown).not.toContain('/fixture/closed.canvas.tsx')
    expect(shown.at(-1)).toBe('/fixture/current.canvas.tsx')
    await surface.closeCanvasPanel()

    // Nested overlays (a menu opened from inside the image preview) suspend
    // twice; the inner one closing first must not bring the native view back.
    width = 500
    const activated = surface.activateCanvasPanel({ path: '/fixture/nested.canvas.tsx' })
    await frame(); await frame()
    expect(await activated).toBe(true)
    const suspend = (globalThis as any).window.klausSuspendCanvasForOverlay as () => Promise<void>
    const resume = (globalThis as any).window.klausResumeCanvasAfterOverlay as () => Promise<void>
    await suspend(); await suspend()
    await frame()
    await resume()
    await frame(); await frame()
    expect(shown.at(-1)).toBe('/fixture/nested.canvas.tsx')
    expect(shows).toBe(4)
    void resume()
    await frame(); await frame()
    expect(shows).toBe(5)
    expect(shown.at(-1)).toBe('/fixture/nested.canvas.tsx')
    await surface.closeCanvasPanel()
  } finally {
    for (const [name,descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis,name,descriptor)
      else Reflect.deleteProperty(globalThis,name)
    }
  }
})
