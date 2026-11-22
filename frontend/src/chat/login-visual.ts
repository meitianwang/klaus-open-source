// Right-column ink-sky canvas on the login screen: slowly drifting stars,
// a crescent moon with crescent-shaped bloom, and breathing contour lines.
//
// Constraints:
// - When `prefers-reduced-motion` is enabled, renders a single static frame
//   with no RAF loop.
// - Stops completely when `#login-screen` is hidden so the workbench pays zero
//   background animation cost.
// - DPR-aware and ResizeObserver-driven so scaling stays sharp.

interface Star {
  x: number
  y: number
  r: number
  phase: number
  speed: number
  drift: number
}

let raf = 0
let observer: ResizeObserver | null = null

function prefersReducedMotion(): boolean {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }
  if (typeof document !== 'undefined') {
    return document.documentElement?.getAttribute?.('data-reduced-motion') === 'true'
  }
  return false
}

/** Stop animation and observer when hiding `#login-screen`. */
export function stopLoginVisual(): void {
  if (raf && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(raf)
  }
  raf = 0
  observer?.disconnect()
  observer = null
}

/** Start (or render a static frame for) the right-column ink-sky visual. */
export function startLoginVisual(): void {
  if (typeof document === 'undefined') return
  const canvas = document.getElementById('login-visual-canvas') as HTMLCanvasElement | null
  const panel = canvas?.parentElement
  if (!canvas || !panel || typeof canvas.getContext !== 'function') return
  stopLoginVisual()

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  let width = 0
  let height = 0
  let stars: Star[] = []
  // Pre-rendered offscreen crescent moon sprite with crescent-shaped bloom:
  // first carve out an offset circle with `destination-out` so the dark half is
  // truly transparent, then stack progressively scaled, low-alpha copies of the
  // crescent itself so the glow emanates along the crescent arc rather than a
  // full circular disc. Rebuilt only on resize; blitted once per frame.
  let moonSprite: HTMLCanvasElement | null = null
  let moonR = 0
  let moonSpriteR = 0
  const BLOOM_LAYERS = 5
  const BLOOM_STEP = 0.09

  const buildMoonSprite = (dpr: number) => {
    if (typeof document.createElement !== 'function') {
      moonSprite = null
      return
    }
    moonR = Math.min(width, height) * 0.09
    moonSpriteR = moonR * 1.9
    const size = Math.ceil(moonSpriteR * 2 * dpr)

    const crescent = document.createElement('canvas')
    crescent.width = size
    crescent.height = size
    const cctx = crescent.getContext('2d')
    if (!cctx) {
      moonSprite = null
      return
    }
    cctx.scale(dpr, dpr)
    const c = moonSpriteR
    cctx.beginPath()
    cctx.arc(c, c, moonR, 0, Math.PI * 2)
    cctx.fillStyle = 'rgba(240, 240, 242, 0.88)'
    cctx.fill()
    const holeX = c - moonR * 0.34
    const holeY = c - moonR * 0.22
    const holeR = moonR * 0.92
    const hole = cctx.createRadialGradient(holeX, holeY, 0, holeX, holeY, holeR)
    hole.addColorStop(0, 'rgba(0, 0, 0, 1)')
    hole.addColorStop(0.96, 'rgba(0, 0, 0, 1)')
    hole.addColorStop(1, 'rgba(0, 0, 0, 0)')
    cctx.globalCompositeOperation = 'destination-out'
    cctx.fillStyle = hole
    cctx.beginPath()
    cctx.arc(holeX, holeY, holeR, 0, Math.PI * 2)
    cctx.fill()

    const sprite = document.createElement('canvas')
    sprite.width = size
    sprite.height = size
    const sctx = sprite.getContext('2d')
    if (!sctx) {
      moonSprite = null
      return
    }
    sctx.scale(dpr, dpr)
    for (let layer = BLOOM_LAYERS; layer >= 1; layer--) {
      const scale = 1 + BLOOM_STEP * layer
      sctx.globalAlpha = 0.05 * (1 - layer / (BLOOM_LAYERS + 1.5))
      sctx.drawImage(
        crescent,
        c - moonSpriteR * scale,
        c - moonSpriteR * scale,
        moonSpriteR * 2 * scale,
        moonSpriteR * 2 * scale,
      )
    }
    sctx.globalAlpha = 1
    sctx.drawImage(crescent, 0, 0, moonSpriteR * 2, moonSpriteR * 2)
    moonSprite = sprite
  }

  const seedStars = () => {
    const count = Math.min(90, Math.round((width * height) / 5200))
    stars = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.5 + Math.random() * 1.3,
      phase: Math.random() * Math.PI * 2,
      speed: 0.4 + Math.random() * 0.9,
      drift: 0.06 + Math.random() * 0.18,
    }))
  }

  const resize = () => {
    const rect = panel.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 2)
    width = rect.width
    height = rect.height
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    buildMoonSprite(dpr)
    seedStars()
  }

  const draw = (t: number) => {
    ctx.clearRect(0, 0, width, height)

    // Breathing contour lines: slow, low-opacity sine waves across the sky.
    for (let i = 0; i < 5; i++) {
      const baseY = height * (0.18 + i * 0.17)
      ctx.beginPath()
      for (let x = -10; x <= width + 10; x += 8) {
        const y =
          baseY +
          Math.sin(x / 130 + t / 9000 + i * 1.7) * 10 +
          Math.sin(x / 47 + t / 15000 + i * 4.1) * 4
        if (x === -10) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = `rgba(244, 244, 245, ${0.028 + i * 0.006})`
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // Crescent moon sprite with soft bloom.
    const moonX = width * 0.74
    const moonY = height * 0.2
    if (moonSprite) {
      ctx.drawImage(
        moonSprite,
        moonX - moonSpriteR,
        moonY - moonSpriteR,
        moonSpriteR * 2,
        moonSpriteR * 2,
      )
    }

    // Slowly drifting stars with phase-offset twinkle.
    for (const star of stars) {
      star.x += star.drift * 0.15
      if (star.x > width + 2) star.x = -2
      const tw = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(star.phase + (t / 1400) * star.speed))
      ctx.beginPath()
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(244, 244, 245, ${0.32 * tw})`
      ctx.fill()
    }
  }

  resize()
  if (width && height) {
    draw(0)
  }
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      resize()
      if (width && height) draw(0)
    })
    observer.observe(panel)
  }

  if (prefersReducedMotion() || typeof requestAnimationFrame !== 'function') {
    return
  }

  const loop = (t: number) => {
    const screen = document.getElementById('login-screen')
    if (!screen || screen.hidden || screen.style.display === 'none') {
      raf = 0
      return
    }
    if (!document.hidden) {
      if (!width || !height) resize()
      if (width && height) draw(t)
    }
    raf = requestAnimationFrame(loop)
  }

  raf = requestAnimationFrame(loop)
}
