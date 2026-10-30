import * as THREE from 'three'
import { clone } from 'three/addons/utils/SkeletonUtils.js'

export interface PathTraceOptions {
  samples: number
  bounces: number
  maxTimeMs?: number
  onProgress?(samples: number, target: number): void
}

/** Trace an immutable pose snapshot into the existing renderer's canvas. */
export async function renderPathTraced(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, options: PathTraceOptions): Promise<void> {
  if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 1024) throw new Error('Path tracing samples must be an integer from 1 to 1024.')
  if (!Number.isInteger(options.bounces) || options.bounces < 1 || options.bounces > 32) throw new Error('Path tracing bounces must be an integer from 1 to 32.')
  if (!renderer.extensions.has('EXT_color_buffer_float')) throw new Error('Path tracing requires WebGL2 floating-point render targets on this device.')
  const { WebGLPathTracer } = await import('three-gpu-pathtracer')
  const snapshot = clone(scene) as THREE.Scene
  const editorObjects: THREE.Object3D[] = []
  snapshot.traverse(object => {
    if (object.userData.editorHelper || object.type === 'GridHelper' || object.type === 'TransformControlsRoot') editorObjects.push(object)
  })
  for (const object of editorObjects) object.removeFromParent()
  const materials = new Set<THREE.Material>()
  const geometries = new Set<THREE.BufferGeometry>()
  const textures = new Set<THREE.Texture>()
  snapshot.traverse(object => {
    const mesh = object as THREE.Mesh
    if (mesh.isMesh) {
      const copies = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map(material => { const copied = material.clone(); materials.add(copied); return copied })
      mesh.material = Array.isArray(mesh.material) ? copies : copies[0]
    }
  })
  // The scene generator assigns one material to each input geometry. Normalize
  // multi-slot meshes into separate pieces without changing the live scene.
  const split: THREE.Mesh[] = []
  snapshot.traverse(object => { if ((object as THREE.Mesh).isMesh && Array.isArray((object as THREE.Mesh).material)) split.push(object as THREE.Mesh) })
  for (const source of split) {
    const slots = source.material as THREE.Material[]
    if (!source.geometry.groups.length) throw new Error('Path tracing needs triangle groups for a multi-material mesh.')
    const container = new THREE.Group()
    container.name = source.name
    container.position.copy(source.position); container.quaternion.copy(source.quaternion); container.scale.copy(source.scale)
    container.matrix.copy(source.matrix); container.matrixAutoUpdate = source.matrixAutoUpdate; container.visible = source.visible
    source.parent?.add(container)
    for (const group of source.geometry.groups) {
      const slot = slots[group.materialIndex ?? 0]
      if (!slot) throw new Error('A path-traced material group references a missing slot.')
      const material = slot.clone(); materials.add(material)
      const geometry = source.geometry.clone()
      const indices = source.geometry.index ? Array.from(source.geometry.index.array) : Array.from({ length: source.geometry.getAttribute('position').count }, (_, index) => index)
      geometry.setIndex(indices.slice(group.start, group.start + group.count)); geometry.clearGroups(); geometry.setDrawRange(0, Infinity)
      geometries.add(geometry)
      let piece: THREE.Mesh
      if ((source as THREE.SkinnedMesh).isSkinnedMesh) {
        const skinned = source as THREE.SkinnedMesh, child = new THREE.SkinnedMesh(geometry, material)
        child.bindMode = skinned.bindMode; child.bind(skinned.skeleton, skinned.bindMatrix.clone()); piece = child
      } else piece = new THREE.Mesh(geometry, material)
      if (source.morphTargetInfluences) piece.morphTargetInfluences = source.morphTargetInfluences.slice()
      if (source.morphTargetDictionary) piece.morphTargetDictionary = { ...source.morphTargetDictionary }
      container.add(piece)
    }
    for (const child of [...source.children]) container.add(child)
    source.removeFromParent()
  }
  snapshot.traverse(object => {
    const mesh = object as THREE.Mesh
    if (!mesh.isMesh) return
    const material = mesh.material as THREE.MeshStandardMaterial
    const maps = ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap'] as const
    const channels = new Set(maps.map(name => material[name]?.channel).filter((value): value is number => value !== undefined))
    if (channels.size > 1) throw new Error('Path tracing currently requires one consistent UV channel per material; raster rendering and GLB preserve mixed UV channels.')
    if (channels.has(1)) {
      const uv = mesh.geometry.getAttribute('uv1')
      if (!uv) throw new Error('A traced material requests UV1 but its geometry has no UV1 coordinates.')
      if (!geometries.has(mesh.geometry)) { mesh.geometry = mesh.geometry.clone(); geometries.add(mesh.geometry) }
      mesh.geometry.setAttribute('uv', uv.clone())
      if (material.normalMap && mesh.geometry.index && mesh.geometry.getAttribute('normal')) mesh.geometry.computeTangents()
      for (const name of maps) { const map = material[name]; if (map) { const copy = map.clone(); copy.channel = 0; material[name] = copy; textures.add(copy) } }
    }
  })
  snapshot.updateMatrixWorld(true)
  const renderCamera = camera.clone()
  const tracer = new WebGLPathTracer(renderer)
  tracer.bounces = options.bounces
  tracer.multipleImportanceSampling = true
  tracer.renderDelay = 0
  tracer.minSamples = 1
  tracer.fadeDuration = 0
  tracer.dynamicLowRes = false
  tracer.rasterizeScene = false
  tracer.renderToCanvas = true
  tracer.tiles.set(1, 1)
  const deadline = performance.now() + Math.min(110_000, Math.max(1000, options.maxTimeMs ?? 90_000))
  try {
    tracer.setScene(snapshot, renderCamera)
    tracer.reset()
    while (tracer.samples < options.samples) {
      if (performance.now() > deadline) throw new Error(`Path tracing timed out after ${Math.floor(tracer.samples)} of ${options.samples} samples.`)
      tracer.renderSample()
      options.onProgress?.(Math.floor(tracer.samples), options.samples)
      // Yield during shader compilation and progressive sampling so cancellation
      // and the rest of the application remain responsive.
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  } finally {
    tracer.dispose()
    for (const material of materials) material.dispose()
    for (const geometry of geometries) geometry.dispose()
    for (const texture of textures) texture.dispose()
    snapshot.clear()
  }
}
