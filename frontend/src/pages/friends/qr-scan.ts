// Client-side QR decoding for the friends scan dialog. jsQR runs on pixels
// drawn into a canvas — camera frames and picked image files alike — so a
// scanned code never leaves this machine.
import jsQR from 'jsqr'
import { parseFriendInvite } from '../../../../shared/friends'
import { desktopDistribution } from '../../app/distribution'

function decodeCanvas(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx || !canvas.width || !canvas.height) return null
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const found = jsQR(pixels.data, pixels.width, pixels.height)
  if (!found?.data) return null
  return parseFriendInvite(found.data, desktopDistribution().protocol)?.email ?? null
}

/** One camera frame, downscaled: full-HD frames decode no better and cost more. */
export function decodeVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): string | null {
  const sourceWidth = video.videoWidth, sourceHeight = video.videoHeight
  if (!sourceWidth || !sourceHeight) return null
  const scale = Math.min(1, 480 / sourceWidth)
  canvas.width = Math.max(1, Math.round(sourceWidth * scale))
  canvas.height = Math.max(1, Math.round(sourceHeight * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return decodeCanvas(canvas)
}

export async function decodeImageFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1200 / bitmap.width)
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return decodeCanvas(canvas)
  } finally {
    try { bitmap.close() } catch { /* already closed */ }
  }
}
