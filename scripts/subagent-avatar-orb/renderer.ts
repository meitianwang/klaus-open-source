import effectSource from './effect.wgsl?raw'

// One device and one offscreen canvas serve every avatar. A row therefore costs
// a 2D canvas and a draw call, rather than a WebGPU context of its own.
const RENDER_SIZE = 96
const UNIFORM_FLOATS = 136
const COLOR_OFFSET = 40

type GpuDevice = any
type GpuContext = any

export interface OrbGpuRenderer {
  render(avatarId: number, time: number, destination: HTMLCanvasElement): boolean
  destroy(): void
}

const PALETTE_STOPS = [
  '#F7FBFF', '#EFF6FD', '#E0EEF9', '#D4E6F7', '#BBD5F3', '#A6C7F0',
  '#87B0EB', '#6F9EE8', '#6F9EE8', '#6F9EE8', '#6F9EE8', '#6F9EE8',
]

const VERTEX_AND_FRAGMENT = `
struct VOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(3.0, -1.0), vec2<f32>(-1.0, 3.0),
  );
  var out: VOut;
  out.pos = vec4<f32>(p[i], 0.0, 1.0);
  let uv01 = (p[i] + vec2<f32>(1.0)) * 0.5;
  out.uv = vec2<f32>(uv01.x, 1.0 - uv01.y);
  return out;
}
@fragment
fn fs_main(in: VOut) -> @location(0) vec4<f32> {
  let c = orbGlassLiquidAnim(in.uv);
  let fc = vec2<f32>(in.uv.x, 1.0 - in.uv.y) * u.size;
  let uv = (2.0 * fc - u.size) / max(min(u.size.x, u.size.y), 1.0);
  let rad = max(u.radius, 0.05);
  let t = u.time * u.speed;
  let contourRad = rad * glsContourScale(uv, t, u.contourDeform);
  let q = (2.0 * fc - u.size) / u.size;
  let fitFeather = 2.0 / max(min(u.size.x, u.size.y), 1.0);
  let fitStart = min(mix(contourRad, 1.0, 0.5), 1.0 - fitFeather);
  let fit = 1.0 - smoothstep(fitStart, 1.0, max(abs(q.x), abs(q.y)));
  return vec4<f32>(c.rgb * fit, c.a * fit);
}
`

function mixIdentity(value: number): number {
  let x = value >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

function rgb(hex: string): [number, number, number, number] {
  const value = hex.slice(1)
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
    1,
  ]
}

function hsl(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360 / 360
  const s = saturation / 100
  const l = lightness / 100
  if (s === 0) {
    const channel = Math.round(l * 255).toString(16).padStart(2, '0')
    return `#${channel}${channel}${channel}`
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (offset: number) => {
    let t = h + offset
    if (t < 0) t += 1
    if (t > 1) t -= 1
    const value = t < 1 / 6 ? p + (q - p) * 6 * t
      : t < 1 / 2 ? q
        : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p
    return Math.round(value * 255).toString(16).padStart(2, '0')
  }
  return `#${channel(1 / 3)}${channel(0)}${channel(-1 / 3)}`
}

function colorsFor(avatarId: number): string[] {
  const hues = [210, 265, 330, 15, 35, 150, 190, 240, 290, 0, 95, 170]
  const hue = hues[(mixIdentity(avatarId) >>> 8) % hues.length]
  return [
    hsl(hue, 38, 9),             // Deep fluid shadow.
    hsl(hue, 33, 50),            // Body colour.
    hsl(hue + 8, 66, 79),        // Refracted filaments.
    hsl(hue + 12, 72, 94),       // Pale inner light.
    '#FFFFFF',                   // Highlight.
    hsl(hue + 10, 80, 97),       // Inner shell.
    hsl(hue + 6, 70, 86),        // Mid shell.
    hsl(hue - 5, 48, 70),        // Outer shell.
    '#FFFFFF',                   // Sheen.
    hsl(hue + 12, 65, 91),       // Specular light.
    '#050208',                   // Interior backdrop.
    hsl(hue + 8, 70, 78),        // Edge glow.
    ...PALETTE_STOPS,
  ]
}

function writeUniforms(target: Float32Array, avatarId: number, time: number): void {
  target.fill(0)
  target[0] = RENDER_SIZE
  target[1] = RENDER_SIZE
  target[2] = time
  // Scalar controls mirror the shader's uniform layout. These values describe
  // a slowly deforming liquid body under a refractive glass shell.
  target.set([
    0.76,  // speed
    0.86,  // radius
    0.46,  // zoom
    3.65,  // warp
    0.58,  // ridge amount
    2.7,   // sharpness
    0.14,  // shade
    0.14,  // sheen
    0.52,  // gloss
    0.42,  // shell mid alpha
    0.2,   // shell edge alpha
    1.2,   // exposure
    23,    // refractive flow program
    0.005, // edge softness
    0,     // edge glow
    0,     // palette count
    1,     // glass enabled
    0.82,  // glass opacity
    0.16,  // contour deformation
    2, 0.42, 0.77, 0.23, 65, 0, 0, 1, 0.22, 0.25,
    0.72, 5, 0.42, 1.25, 0.55, 0.3, 1.2, 0.7,
  ], 3)
  colorsFor(avatarId).forEach((hex, index) => target.set(rgb(hex), COLOR_OFFSET + index * 4))
}

export async function createOrbGpuRenderer(): Promise<OrbGpuRenderer | null> {
  const gpu = (navigator as Navigator & { gpu?: any }).gpu
  if (!gpu) return null
  const adapter = await gpu.requestAdapter()
  if (!adapter) return null
  const device: GpuDevice = await adapter.requestDevice()
  const canvas = document.createElement('canvas')
  canvas.width = RENDER_SIZE
  canvas.height = RENDER_SIZE
  const context = canvas.getContext('webgpu') as GpuContext | null
  if (!context) {
    device.destroy()
    return null
  }
  const format = gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'premultiplied' })
  const shader = device.createShaderModule({ code: effectSource + VERTEX_AND_FRAGMENT })
  const compilation = await shader.getCompilationInfo()
  const errors = compilation.messages.filter((message: any) => message.type === 'error')
  if (errors.length) {
    device.destroy()
    throw new Error(errors.map((message: any) => `${message.lineNum}:${message.linePos} ${message.message}`).join('\n'))
  }
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: shader, entryPoint: 'vs_main' },
    fragment: {
      module: shader,
      entryPoint: 'fs_main',
      targets: [{
        format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        },
      }],
    },
    primitive: { topology: 'triangle-list' },
  })
  const values = new Float32Array(UNIFORM_FLOATS)
  const uniformBuffer = device.createBuffer({ size: values.byteLength, usage: 0x40 | 0x08 })
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  })
  let destroyed = false
  let failed = false
  device.lost.then(() => { failed = true })

  return {
    render(avatarId, time, destination) {
      if (destroyed || failed) return false
      const context2d = destination.getContext('2d')
      if (!context2d) return false
      writeUniforms(values, avatarId, time)
      device.queue.writeBuffer(uniformBuffer, 0, values)
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        }],
      })
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.draw(3, 1, 0, 0)
      pass.end()
      device.queue.submit([encoder.finish()])
      context2d.clearRect(0, 0, destination.width, destination.height)
      context2d.imageSmoothingEnabled = true
      context2d.imageSmoothingQuality = 'high'
      context2d.drawImage(canvas, 0, 0, destination.width, destination.height)
      return true
    },
    destroy() {
      destroyed = true
      device.destroy()
    },
  }
}
