import * as THREE from 'three'
import { Model3DViewport, type MeshPayload, type SerializedObject, type SerializedScene } from './viewport'

interface FixtureAsset { document: SerializedScene; meshes: Record<string, Record<string, any>>; source: string; sha256: string }
let view: Model3DViewport | undefined
let asset: FixtureAsset | undefined
const renderedPixels = new Map<string, Uint8ClampedArray>()

function payloadFor(objectName: string): MeshPayload {
  if (!asset) throw new Error('Fixture is not mounted')
  const item = asset.document.objects.find(item => item.name === objectName) as SerializedObject & { mesh: string }
  const mesh = asset.meshes[item.mesh]
  if (!mesh) throw new Error(`Fixture mesh is missing: ${objectName}`)
  const payload: MeshPayload = { name: objectName, geometry_key: item.geometry_key!, positions: new Float32Array(mesh.positions), normals: new Float32Array(mesh.normals), indices: new Uint32Array(mesh.indices) }
  for (const key of ['uvs', 'uvs1', 'tangents', 'colors', 'skinWeights'] as const) if (mesh[key]) payload[key] = new Float32Array(mesh[key])
  if (mesh.skinIndices) payload.skinIndices = new Uint32Array(mesh.skinIndices)
  if (mesh.groups) payload.groups = mesh.groups
  if (mesh.morphTargets) payload.morphTargets = mesh.morphTargets.map((target: any) => ({ name: target.name, positions: target.positions ? new Float32Array(target.positions) : undefined, normals: target.normals ? new Float32Array(target.normals) : undefined }))
  return payload
}

function geometryBounds(): THREE.Box3 {
  if (!view) throw new Error('Fixture is not mounted')
  view.scene.updateMatrixWorld(true)
  const box = new THREE.Box3(), p = new THREE.Vector3()
  view.scene.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh || !mesh.userData.modelName || mesh.userData.editorHelper || mesh.userData.placeholder) return
    for (let vertex = 0; vertex < mesh.geometry.getAttribute('position').count; vertex++) {
      mesh.getVertexPosition(vertex, p); p.applyMatrix4(mesh.matrixWorld); box.expandByPoint(p)
    }
  })
  return box
}

function object(name: string, type: string, extra: Partial<SerializedObject> = {}): SerializedObject {
  return { name, type, location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [1, 1, 1], visible: true, modifiers: [], ...extra }
}

async function mount(name: string, palette = false): Promise<Record<string, unknown>> {
  const reuse = !!view && asset?.document.id === name
  if (!reuse) { view?.dispose(); view = undefined }
  asset = await (await fetch(`./${name}.json`)).json() as FixtureAsset
  const document = asset.document
  if (palette) for (const [index, material] of document.materials.entries()) {
    material.baseColor = [0, 0, 0, 1]; material.metallic = 0; material.roughness = 1; material.emissiveColor = index % 2 ? [0, 0, 1] : [1, 0, 0]; material.emissiveStrength = 1; delete material.normalTexture
  }
  document.id = name
  document.scene = { ...(document.scene ?? {}), frameStart: 1, frameEnd: 11, currentFrame: 1, fps: 10, background: [0.025, 0.035, 0.05, 1] }
  const clip = Object.keys(document.clips ?? {})[0] ?? null
  if (clip) document.scene.activeClip = clip
  document.objects.push(object('SmokeCamera', 'CAMERA', { camera: { active: true, lens: 50, clipStart: 0.01, clipEnd: 10000 } }))
  document.scene.activeCamera = 'SmokeCamera'
  document.objects.push(object('SmokeSun', 'LIGHT', { rotation_euler: [0.3, -0.4, 0.1], light: { type: 'SUN', energy: palette ? 0 : 2.5, color: [1, 0.95, 0.85] } }))
  view ??= new Model3DViewport({ container: documentHost(), loadMesh: async name => payloadFor(name) })
  view.update(document)
  await view.whenReady()
  view.setFrame(1, clip)
  const union = geometryBounds()
  if (clip) { view.setFrame(11, clip); union.union(geometryBounds()); view.setFrame(1, clip) }
  if (union.isEmpty()) throw new Error('Imported asset has no visible geometry')
  const centerWorld = union.getCenter(new THREE.Vector3()), size = union.getSize(new THREE.Vector3()).length(), docRotationInverse = new THREE.Matrix4().makeRotationX(Math.PI / 2)
  const center = centerWorld.applyMatrix4(docRotationInverse), position = center.clone().add(new THREE.Vector3(0.8, -1, 0.65).normalize().multiplyScalar(Math.max(size, 1) * 1.9))
  const camera = new THREE.PerspectiveCamera(); camera.up.set(0, 0, 1); camera.position.copy(position); camera.lookAt(center)
  const cameraItem = document.objects.find(item => item.name === 'SmokeCamera')!
  cameraItem.location = position.toArray(); cameraItem.rotationQuaternion = camera.quaternion.toArray()
  document.objects.push(object('SmokePoint', 'LIGHT', { location: center.clone().add(new THREE.Vector3(-2, -3, 4).multiplyScalar(Math.max(size / 6, 1))).toArray(), light: { type: 'POINT', energy: palette ? 0 : Math.max(size * size, 1) * 20, color: [0.75, 0.85, 1] } }))
  view.update(document); await view.whenReady(); view.fitAll(); view.play(false)
  const context = view.renderer.getContext(), debug = context.getExtension('WEBGL_debug_renderer_info')
  return { source: asset.source, sourceSha256: asset.sha256, meshes: Object.keys(asset.meshes).length, objectCount: document.objects.length, joints: document.objects.filter(o => o.joint).length, textures: Object.keys(document.textures ?? {}).length, clips: Object.keys(document.clips ?? {}), framingBounds: { min: union.min.toArray(), max: union.max.toArray() }, cameraDocPosition: position.toArray(), glVersion: context.getParameter(context.VERSION), glRenderer: debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER), floatTargets: view.renderer.extensions.has('EXT_color_buffer_float') }
}

function documentHost(): HTMLElement {
  const host = window.document.getElementById('viewport')
  if (!host) throw new Error('Fixture viewport DOM is missing')
  return host
}

async function render(engine: 'raster' | 'pathtrace', frame: number, key: string, compareKey?: string): Promise<Record<string, unknown>> {
  if (!view || !asset) throw new Error('Fixture is not mounted')
  const clip = Object.keys(asset.document.clips ?? {})[0] ?? null
  view.setFrame(frame, clip)
  const box = geometryBounds()
  const bytes = await view.renderOffscreen({ width: 256, height: 256, format: 'png', camera: 'SmokeCamera', engine, samples: 4, bounces: 2, frame, clip })
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' })), canvas = window.document.createElement('canvas')
  canvas.width = bitmap.width; canvas.height = bitmap.height
  const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close()
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
  let min = 255, max = 0, sum = 0, squared = 0, alpha = 0, changed = 0, difference = 0
  let redPixels = 0, redY = 0, bluePixels = 0, blueY = 0, greenPixels = 0
  const previous = compareKey ? renderedPixels.get(compareKey) : undefined
  for (let i = 0; i < pixels.length; i += 4) {
    const luminance = (pixels[i] + pixels[i + 1] + pixels[i + 2]) / 3
    min = Math.min(min, luminance); max = Math.max(max, luminance); sum += luminance; squared += luminance * luminance; alpha += pixels[i + 3]
    if (pixels[i] > pixels[i + 1] * 1.5 && pixels[i] > pixels[i + 2] * 1.5) { redPixels++; redY += Math.floor(i / 4 / canvas.width) }
    if (pixels[i + 2] > pixels[i] * 1.5 && pixels[i + 2] > pixels[i + 1] * 1.5) { bluePixels++; blueY += Math.floor(i / 4 / canvas.width) }
    if (pixels[i + 1] > pixels[i] * 1.5 && pixels[i + 1] > pixels[i + 2] * 1.5) greenPixels++
    if (previous) { const delta = Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2]); if (delta > 15) changed++; difference += delta / 3 }
  }
  const count = pixels.length / 4, mean = sum / count, variance = squared / count - mean * mean
  if (max - min < 8 || variance < 0.1 || alpha === 0) throw new Error(`${engine} output is blank or undecodable`)
  renderedPixels.set(key, new Uint8ClampedArray(pixels))
  let binary = ''; for (const value of bytes) binary += String.fromCharCode(value)
  return { engine, frame, width: canvas.width, height: canvas.height, pngBytes: bytes.length, base64: btoa(binary), stats: { min, max, mean, variance, changedPixels: previous ? changed : null, meanAbsoluteDifference: previous ? difference / count : null, redPixels, redMeanY: redPixels ? redY / redPixels : null, bluePixels, blueMeanY: bluePixels ? blueY / bluePixels : null, greenPixels }, worldBounds: { min: box.min.toArray(), max: box.max.toArray() }, sourceSha256: asset.sha256 }
}

/** Distinct source UVs make a wrongly sampled channel visibly green. */
async function useUV1Diagnostic(): Promise<Record<string, unknown>> {
  if (!asset || !view) throw new Error('Fixture is not mounted')
  const canvas = window.document.createElement('canvas'); canvas.width = 2; canvas.height = 2
  const context = canvas.getContext('2d')!
  for (const [x, y, color] of [[0, 0, '#ff0000'], [1, 0, '#00ff00'], [0, 1, '#0000ff'], [1, 1, '#ffff00']] as const) { context.fillStyle = color; context.fillRect(x, y, 1, 1) }
  asset.document.textures = { UVChecker: { name: 'UVChecker', mimeType: 'image/png', dataBase64: canvas.toDataURL('image/png').split(',')[1], sampler: { minFilter: 9728, magFilter: 9728, wrapS: 33071, wrapT: 33071 } } }
  asset.document.materials = [{ name: 'UVPaint', baseColor: [0, 0, 0, 1], metallic: 0, roughness: 1, emissiveColor: [1, 1, 1], emissiveStrength: 1, alpha: 1, alphaMode: 'OPAQUE', doubleSided: true, emissiveTexture: { texture: 'UVChecker', texCoord: 1 } }]
  for (const mesh of Object.values(asset.meshes)) {
    const vertices = mesh.positions.length / 3
    mesh.uvs = Array.from({ length: vertices }, () => [0.75, 0.25]).flat()
    mesh.uvs1 = Array.from({ length: vertices }, () => [0.25, 0.25]).flat()
    mesh.groups = mesh.groups.map((group: any) => ({ ...group, materialIndex: 0 })); mesh.materials = ['UVPaint']
  }
  for (const item of asset.document.objects) {
    if (item.type === 'MESH') { item.geometry_key += ':uv1-diagnostic'; item.material = 'UVPaint'; item.materials = ['UVPaint'] }
    if (item.light) item.light.energy = 0
  }
  view.update(asset.document); await view.whenReady()
  return { override: 'Two-by-two native PNG, UV0 green and UV1 red, repeated groups share one material slot', textures: 1, uvChannel: 1 }
}

async function mixedUVError(): Promise<string> {
  if (!asset || !view) throw new Error('Fixture is not mounted')
  asset.document.materials[0].baseColorTexture = { texture: 'UVChecker', texCoord: 0 }
  view.update(asset.document); await view.whenReady()
  try { await view.renderOffscreen({ width: 256, height: 256, format: 'png', camera: 'SmokeCamera', engine: 'pathtrace', samples: 4, bounces: 2 }); return '' }
  catch (error) { return String((error as Error)?.message ?? error) }
}

declare global { interface Window { model3dRendererSmoke: { mount: typeof mount; render: typeof render; useUV1Diagnostic: typeof useUV1Diagnostic; mixedUVError: typeof mixedUVError; close(): void } } }
window.model3dRendererSmoke = { mount, render, useUV1Diagnostic, mixedUVError, close: () => { view?.dispose(); view = undefined } }
