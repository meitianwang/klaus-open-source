// Diagram export helpers: render SVG in the WebView, then hand bytes to the Rust host.

const MIN_EXPORT_SCALE = 0.1
const MAX_EXPORT_SCALE = 4
const MAX_CANVAS_EDGE = 32_767
const MAX_CANVAS_PIXELS = 64 * 1024 * 1024

export function exportScaleFromPercent(percent: number): number {
  const scale = percent / 100
  if (!Number.isFinite(scale) || scale < MIN_EXPORT_SCALE || scale > MAX_EXPORT_SCALE) {
    throw new Error('digram export: scale must be between 10% and 400%')
  }
  return scale
}

export function rasterDimensions(svg: string, scale: number): { width: number; height: number } {
  if (!Number.isFinite(scale) || scale < MIN_EXPORT_SCALE || scale > MAX_EXPORT_SCALE) {
    throw new Error('digram export: invalid scale')
  }
  const intrinsic = svgIntrinsicSize(svg)
  const width = Math.max(1, Math.round(intrinsic.width * scale))
  const height = Math.max(1, Math.round(intrinsic.height * scale))
  if (width > MAX_CANVAS_EDGE || height > MAX_CANVAS_EDGE || width * height > MAX_CANVAS_PIXELS) {
    throw new Error('digram export: output is too large')
  }
  return { width, height }
}

export function scaleSvgDimensions(svg: string, scale: number): string {
  if (!Number.isFinite(scale) || scale < MIN_EXPORT_SCALE || scale > MAX_EXPORT_SCALE) {
    throw new Error('digram export: invalid scale')
  }
  if (scale === 1) return svg
  const intrinsic = svgIntrinsicSize(svg)
  const width = Number((intrinsic.width * scale).toFixed(3))
  const height = Number((intrinsic.height * scale).toFixed(3))
  return svg
    .replace(/(<svg\b[^>]*\bwidth=")[\d.]+(")/, `$1${width}$2`)
    .replace(/(<svg\b[^>]*\bheight=")[\d.]+(")/, `$1${height}$2`)
}

/** Rasterize the rendered SVG at the requested resolution scale. */
export async function rasterize(
  svg: string,
  format: 'png' | 'jpg',
  scale: number,
): Promise<Uint8Array> {
  const { width, height } = rasterDimensions(svg, scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('digram export: no 2d context')
  // JPG 没有 alpha：不铺底就会得到黑背景。PNG 保留透明。
  if (format === 'jpg') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  const image = await decodeSvg(svg)
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, format === 'jpg' ? 'image/jpeg' : 'image/png', format === 'jpg' ? 0.92 : undefined),
  )
  if (!blob) throw new Error('digram export: canvas produced no blob')
  return new Uint8Array(await blob.arrayBuffer())
}

/** SVG 文本 → 已解码的 Image，走 data URL。encodeURIComponent + unescape 处理非 ASCII
 *  （中文标签），btoa 直接吞 UTF-8 会抛。 */
function decodeSvg(svg: string): Promise<HTMLImageElement> {
  const encoded = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)))
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('digram export: svg failed to decode'))
    image.src = encoded
  })
}

/** 从 SVG 头里读固有宽高。render.ts 一定写了 width/height 属性（像素整数）。 */
function svgIntrinsicSize(svg: string): { width: number; height: number } {
  const width = Number(svg.match(/<svg[^>]*\bwidth="([\d.]+)"/)?.[1])
  const height = Number(svg.match(/<svg[^>]*\bheight="([\d.]+)"/)?.[1])
  return {
    width: Number.isFinite(width) && width > 0 ? width : 800,
    height: Number.isFinite(height) && height > 0 ? height : 600,
  }
}

/** base64（无 data 前缀）编码字节，交给 Rust 的 `digram:export` 落盘。分块避免大图
 *  在 `String.fromCharCode(...bytes)` 上炸栈。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}
