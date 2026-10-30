// The 3D viewport: a three.js scene built from the host kernel's serialization.
//
// Two coordinate facts drive everything here:
//
//   - The document model is right-handed Z-up (matching the CAD kernel and the
//     way a modeller thinks about "up"); three.js is right-handed Y-up. Mesh
//     vertices arrive in document space, so the ROOT object is rotated -90°
//     about X and the geometry is left alone. Rotating the data instead would
//     break the round-trip: a drag must write back values the kernel can use
//     as-is.
//   - Rotation is applied from the object's own Euler triplet rather than a
//     baked matrix, because the document stores transforms as location /
//     rotation / scale datablocks and a drag edits exactly those fields.
//
// Geometry arrives as typed arrays over Electron IPC (structured-cloned, no
// base64) and is cached by the kernel's `geometry_key` content hash, so a scene
// refresh re-uploads only the meshes that actually changed. That matters: a
// 24 k-vertex subdivision result is ~300 KB of buffers, and a panel refresh on
// every agent edit would otherwise re-upload all of them.

import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js'

export interface SerializedObject {
  name: string
  type: string
  location: number[]
  rotation_euler: number[]
  scale: number[]
  visible: boolean
  modifiers: Array<{ id: string; type: string; label: string; enabled: boolean }>
  geometry_key?: string
  /** The object's mesh first material slot, resolved host-side. */
  material?: string | null
  camera?: { active: boolean; lens: number; clipStart: number; clipEnd: number } | null
  light?: { type: string; energy: number; color: number[] } | null
  rigid_body?: string | null
  cloth?: { preset: string; collider: string | null } | null
  animated?: string[]
  parent?: string | null
  joint?: boolean
  skin?: string | null
  materials?: string[]
  matrix?: number[] | null
  rotationQuaternion?: number[] | null
  rotation_quaternion?: number[] | null
  morphInfluences?: number[] | null
  morph_influences?: number[] | null
  animation?: Record<string, Array<{ frame: number; value: number[] }>>
}

export interface TextureSlot {
  texture: string
  texCoord?: number
  scale?: number
  strength?: number
  transform?: { offset: number[]; scale: number[]; rotation: number; texCoord?: number }
}
export interface SerializedTexture {
  name: string
  mimeType: 'image/png' | 'image/jpeg'
  dataBase64: string
  sampler?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }
}
export interface SerializedSkin { name: string; joints: string[]; inverseBindMatrices: number[]; skeleton?: string }
export interface SerializedTrack { object: string; path: 'translation' | 'rotation' | 'scale' | 'weights'; times: number[]; values: number[]; interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE' }
export interface SerializedClip { name: string; tracks: SerializedTrack[] }

export interface SerializedMaterial {
  name: string
  baseColor?: number[]
  metallic?: number
  roughness?: number
  alpha?: number
  emissiveColor?: number[]
  emissiveStrength?: number
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND'
  alphaCutoff?: number
  doubleSided?: boolean
  baseColorTexture?: TextureSlot
  metallicRoughnessTexture?: TextureSlot
  normalTexture?: TextureSlot
  occlusionTexture?: TextureSlot
  emissiveTexture?: TextureSlot
}

export interface SerializedScene {
  id?: string
  title?: string
  version?: number
  objects: SerializedObject[]
  materials: SerializedMaterial[]
  scene?: { resolutionX?: number; resolutionY?: number; activeCamera?: string; fps?: number; frameStart?: number; frameEnd?: number; currentFrame?: number; activeClip?: string; background?: number[] }
  textures?: Record<string, SerializedTexture>
  skins?: Record<string, SerializedSkin>
  clips?: Record<string, SerializedClip>
  summary?: Record<string, unknown>
}

/**
 * Evaluated geometry for one object.
 *
 * Typed arrays, not base64: this crosses Electron IPC, which structured-clones
 * ArrayBuffer-backed views by reference semantics into the renderer, so there is
 * no encode/decode step and no 33% size inflation.
 */
export interface MeshPayload {
  name: string
  geometry_key: string
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  uvs?: Float32Array
  uvs1?: Float32Array
  tangents?: Float32Array
  colors?: Float32Array
  skinIndices?: Uint16Array | Uint32Array
  skinWeights?: Float32Array
  groups?: Array<{ start: number; count: number; materialIndex: number }>
  morphTargets?: Array<{ name?: string; positions?: Float32Array; normals?: Float32Array }>
}

export interface ViewportOptions {
  container: HTMLElement
  /** Fetch one object's evaluated geometry on demand (host IPC). */
  loadMesh(name: string): Promise<MeshPayload>
  /** Called after a drag finishes, with the object's new local transform. */
  onTransform?(name: string, next: { location: number[]; rotation_euler: number[]; scale: number[] }): Promise<void>
  onSelect?(name: string | null): void
  onHover?(name: string | null): void
  onFrame?(frame: number, playing: boolean): void
}
export interface RenderOptions { width: number; height: number; format: 'png' | 'jpg'; camera?: string | null; lens?: number; engine?: 'raster' | 'pathtrace'; samples?: number; bounces?: number; frame?: number; clip?: string | null }

interface Entry {
  object: THREE.Object3D
  name: string
  kind: string
  geometryKey?: string
  placeholder?: boolean
  /** Bumped per rebuild, so a slow mesh fetch cannot overwrite a newer scene. */
  generation: number
  item: SerializedObject
}

const EMPTY_MATERIAL = new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.65, metalness: 0.05 })
const SELECTED_EMISSIVE = 0x2f6fed
const HOVER_EMISSIVE = 0x1b3a7a

/**
 * Build a three.js BufferGeometry from the kernel's typed buffers.
 *
 * The buffers are COPIED into the geometry rather than aliased: three.js
 * uploads them to the GPU and may retain the reference, while the host reuses
 * its cache across documents. Copying costs one memcpy per changed mesh and
 * removes any chance of a stale document mutating a live GPU buffer.
 */
export function geometryFrom(payload: MeshPayload): THREE.BufferGeometry {
  const positions = new Float32Array(payload.positions)
  const normals = new Float32Array(payload.normals)
  const indices = new Uint32Array(payload.indices)
  const geometry = new THREE.BufferGeometry()
  if (!positions.length || positions.length % 3 || !positions.every(Number.isFinite) || !indices.length || indices.length % 3 || indices.some(i => i >= positions.length / 3)) throw new Error('Invalid evaluated triangle mesh')
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  if (normals.length === positions.length) { if (!normals.every(Number.isFinite)) throw new Error('Invalid evaluated normal attribute'); geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3)) }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  const attributes: Array<[string, ArrayLike<number> | undefined, number]> = [['uv', payload.uvs, 2], ['uv1', payload.uvs1, 2], ['tangent', payload.tangents, 4], ['color', payload.colors, payload.colors?.length === positions.length / 3 * 4 ? 4 : 3], ['skinWeight', payload.skinWeights, 4]]
  for (const [name, values, width] of attributes) if (values !== undefined) {
    const array = new Float32Array(values)
    if (array.length !== positions.length / 3 * width || !array.every(Number.isFinite)) throw new Error(`Invalid evaluated ${name} attribute`)
    geometry.setAttribute(name, new THREE.BufferAttribute(array, width))
  }
  if (payload.skinIndices) {
    if (payload.skinIndices.some(index => index > 65535)) throw new Error('Skin joint indices exceed the supported unsigned-short range')
    // WebGL skinning takes a float vec4. Uint32 attributes select an integer
    // vertex input in the renderer, so joints use the glTF unsigned-short form.
    const array = new Uint16Array(payload.skinIndices)
    if (array.length !== positions.length / 3 * 4 || !payload.skinWeights) throw new Error('Invalid evaluated skin attributes')
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(array, 4))
  } else if (payload.skinWeights) throw new Error('Skin weights require joint indices')
  for (const group of payload.groups ?? []) {
    if (![group.start, group.count, group.materialIndex].every(Number.isInteger) || group.start < 0 || group.count < 0 || group.start % 3 || group.count % 3 || group.start + group.count > indices.length || group.materialIndex < 0) throw new Error('Invalid evaluated material group')
    geometry.addGroup(group.start, group.count, group.materialIndex)
  }
  if (payload.morphTargets?.length) {
    geometry.morphTargetsRelative = true
    for (const [channel, field] of [['position', 'positions'], ['normal', 'normals']] as const) if (payload.morphTargets.some(t => t[field])) {
      geometry.morphAttributes[channel] = payload.morphTargets.map(target => {
        const array = target[field] ? new Float32Array(target[field]!) : new Float32Array(positions.length)
        if (array.length !== positions.length || !array.every(Number.isFinite)) throw new Error('Invalid evaluated morph target')
        const attribute = new THREE.BufferAttribute(array, 3); attribute.name = target.name ?? ''; return attribute
      })
    }
  }
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  geometry.computeBoundingSphere()
  return geometry
}

export class Model3DViewport {
  // Fields are declared WITHOUT initializers and assigned in the constructor on
  // purpose. A class-field initializer downlevels (target: safari15) to a shared
  // `_defineProperty` runtime helper; if this module defines that helper, the
  // bundler may co-locate it into the three.js chunk, and a startup module that
  // also uses class fields then statically imports the helper from there — pulling
  // the whole WebGL stack onto the startup path even though this panel is lazy.
  // Plain constructor assignments generate no helper, so three stays lazy.
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  private readonly orbit: OrbitControls
  private readonly transform: TransformControls
  private readonly raycaster: THREE.Raycaster
  private readonly pointer: THREE.Vector2
  /** Document-space root: rotating this converts Z-up to three.js Y-up. */
  private readonly root: THREE.Group
  private readonly entries: Map<string, Entry>
  private readonly geometries: Map<string, THREE.BufferGeometry>
  /** Reference count per geometry key: one geometry_key can back several objects. */
  private readonly geometryUsers: Map<string, number>
  private readonly materials: Map<string, THREE.MeshStandardMaterial>
  /** Per-object highlight state: the clone plus the materials it replaced. */
  private readonly highlightMaterials: Map<string, { highlights: THREE.MeshStandardMaterial[]; meshes: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> }>
  private readonly disposables: Set<{ dispose(): void }>
  private readonly resizeObserver: ResizeObserver
  /** rAF handle of the render loop, or null while the loop is parked. */
  private loopFrame: number | null
  /** Bumped on every rebuild, so a stale mesh fetch cannot overwrite newer state. */
  private generation: number
  private selected: string | null
  private hovered: string | null
  private gridVisible: boolean
  private grid: THREE.GridHelper
  private disposed: boolean
  private pendingMeshes: Map<string, Promise<void>>
  private loadingObjects: Map<string, Promise<void>>
  private pendingTextures: Set<Promise<void>>
  private textureSources: Map<string, { signature: string; promise: Promise<THREE.Texture> }>
  private materialTextures: Map<THREE.MeshStandardMaterial, THREE.Texture[]>
  private textureErrors: Map<string, string>
  private meshErrors: Map<string, string>
  private materialRevision: number
  private sceneRevision: number
  private document: SerializedScene | null
  private defaultLights: THREE.Light[]
  private playing: boolean
  private frame: number
  private clip: string | null
  private lastFrameTime: number | null
  private rendering: boolean
  private renderQueue: Promise<void>
  private deferredDocument: SerializedScene | null
  /** The document's active camera, used when a render names none explicitly. */
  private activeCameraName: string | null
  private readonly loop: () => void
  private readonly onPointerDown: (event: PointerEvent) => void
  private readonly onPointerMove: (event: PointerEvent) => void

  private readonly options: ViewportOptions

  constructor(options: ViewportOptions) {
    // Explicit field + assignment, not a parameter property: a parameter property
    // also downlevels to the shared `_defineProperty` helper under the safari15
    // build target, which is exactly what we are avoiding (see the field note).
    this.options = options
    // Assigned before anything below reads them; order mirrors the old field
    // initializers so behaviour is unchanged.
    this.scene = new THREE.Scene()
    this.raycaster = new THREE.Raycaster()
    this.pointer = new THREE.Vector2()
    this.root = new THREE.Group()
    this.entries = new Map()
    this.geometries = new Map()
    this.geometryUsers = new Map()
    this.materials = new Map()
    this.highlightMaterials = new Map()
    this.disposables = new Set()
    this.loopFrame = null
    this.generation = 0
    this.selected = null
    this.hovered = null
    this.gridVisible = true
    this.disposed = false
    this.pendingMeshes = new Map()
    this.loadingObjects = new Map()
    this.pendingTextures = new Set()
    this.textureSources = new Map()
    this.materialTextures = new Map()
    this.textureErrors = new Map()
    this.meshErrors = new Map()
    this.materialRevision = 0
    this.sceneRevision = 0
    this.document = null
    this.defaultLights = []
    this.playing = false
    this.frame = 1
    this.clip = null
    this.lastFrameTime = null
    this.rendering = false
    this.renderQueue = Promise.resolve()
    this.deferredDocument = null
    this.activeCameraName = null
    // Bound once, before they are wired to the renderer below.
    this.loop = this.defineLoop()
    this.onPointerDown = this.definePointerDown()
    this.onPointerMove = this.definePointerMove()

    const container = options.container
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.setSize(Math.max(container.clientWidth, 1), Math.max(container.clientHeight, 1), false)
    this.renderer.domElement.style.display = 'block'
    container.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(45, Math.max(container.clientWidth, 1) / Math.max(container.clientHeight, 1), 0.05, 2000)
    this.camera.position.set(7, 5, 7)

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement)
    this.orbit.enableDamping = true
    this.orbit.dampingFactor = 0.12
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }

    // The document is Z-up; rotating the root rather than the vertices keeps
    // every value we send back in the document's own frame.
    this.root.rotation.x = -Math.PI / 2
    this.scene.add(this.root)

    this.grid = new THREE.GridHelper(24, 24, 0x4a5058, 0x2c3138)
    this.grid.userData.editorHelper = true
    // The grid is authored in three.js Y-up space, so undo the root rotation by
    // adding it to the SCENE, not the root — it must stay flat on the document XY.
    this.scene.add(this.grid)

    const hemi = new THREE.HemisphereLight(0xffffff, 0x404040, 0.55)
    this.scene.add(hemi)
    const key = new THREE.DirectionalLight(0xffffff, 1.1)
    key.position.set(6, 10, 8)
    this.scene.add(key)
    const fill = new THREE.DirectionalLight(0xbfd4ff, 0.35)
    fill.position.set(-7, 4, -6)
    this.scene.add(fill)
    this.defaultLights = [hemi, key, fill]

    this.transform = new TransformControls(this.camera, this.renderer.domElement)
    this.transform.setSize(0.8)
    // Orbiting while dragging would move the camera under the pointer, so the
    // gizmo explicitly takes the orbit controls away for the duration.
    this.transform.addEventListener('dragging-changed', event => {
      this.orbit.enabled = !(event as unknown as { value: boolean }).value
      if ((event as unknown as { value: boolean }).value) this.play(false)
    })
    const transformHelper = this.transform.getHelper()
    transformHelper.userData.editorHelper = true
    this.scene.add(transformHelper)

    const element = this.renderer.domElement
    element.addEventListener('pointerdown', this.onPointerDown)
    element.addEventListener('pointermove', this.onPointerMove)
    this.transform.addEventListener('mouseUp', () => { void this.commitDrag() })

    this.resizeObserver = new ResizeObserver(() => {
      this.resize()
      // Showing the panel again is the only event that knows the viewport is
      // visible, so it is also what wakes the parked loop.
      this.startLoop()
    })
    this.resizeObserver.observe(container)

    this.startLoop()
  }

  /**
   * Whether the panel is actually on screen.
   *
   * A hidden container reports clientWidth 0, which is the same signal resize()
   * already reads: the 1×1 floor it applies is why a parked panel's canvas
   * measured 2×2 device pixels while its loop kept drawing into it.
   */
  private visible(): boolean {
    const container = this.options.container
    return container.clientWidth > 0 && container.clientHeight > 0
  }

  /** Start the render loop unless it is already scheduled. */
  private startLoop(): void {
    if (this.disposed || this.loopFrame !== null) return
    this.loopFrame = requestAnimationFrame(this.loop)
  }

  private stopLoop(): void {
    if (this.loopFrame === null) return
    cancelAnimationFrame(this.loopFrame)
    this.loopFrame = null
  }

  private resize(): void {
    const container = this.options.container
    const width = Math.max(container.clientWidth, 1)
    const height = Math.max(container.clientHeight, 1)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
  }

  // The render loop, as an arrow assigned in the constructor (see the field-
  // initializer note above). requestAnimationFrame needs a stable bound fn.
  private defineLoop(): () => void {
    return () => {
      this.loopFrame = null
      if (this.disposed) return
      // Parking while hidden is the point: the panel is a tab among many, and
      // switching away only sets display:none — it never disposes the viewport.
      // Rendering an invisible scene still costs a full three.js frame (matrix
      // updates, draw calls, a GPU swap) at the display's refresh rate, which on
      // a 120 Hz panel was measured at 125 draws/second for pixels nobody sees.
      if (!this.visible()) { this.lastFrameTime = null; return }
      this.loopFrame = requestAnimationFrame(this.loop)
      if (this.rendering) return
      const now = performance.now()
      if (this.playing && this.document) {
        const fps = this.document.scene?.fps ?? 24
        const range = animationFrameRange(this.document, this.clip)
        const delta = this.lastFrameTime === null ? 0 : Math.min(0.1, (now - this.lastFrameTime) / 1000)
        let frame = this.frame + delta * fps
        if (frame > range[1]) frame = range[0] + (frame - range[0]) % Math.max(range[1] - range[0], 1)
        this.setFrame(frame, this.clip)
      }
      this.lastFrameTime = now
      this.orbit.update()
      // Damping keeps changing the camera after input ends, so render every frame
      // rather than only on a dirty flag; a panel this size is cheap.
      this.renderer.render(this.scene, this.camera)
    }
  }

  /** Frame the camera on everything currently in the scene. */
  fitAll(): void {
    const box = new THREE.Box3()
    let any = false
    for (const entry of this.entries.values()) {
      if (!entry.object.visible) continue
      box.expandByObject(entry.object)
      any = true
    }
    if (!any) {
      this.orbit.target.set(0, 0, 0)
      this.camera.position.set(7, 5, 7)
      return
    }
    const center = box.getCenter(new THREE.Vector3())
    const size = box.getSize(new THREE.Vector3()).length() || 4
    const distance = size / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * 1.4
    const direction = this.camera.position.clone().sub(this.orbit.target).normalize()
    this.orbit.target.copy(center)
    this.camera.position.copy(center.clone().add(direction.multiplyScalar(Math.max(distance, 1.5))))
  }

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible
    this.grid.visible = visible
  }

  get gridIsVisible(): boolean { return this.gridVisible }

  /** Replace the scene graph from a fresh serialization. */
  update(document: SerializedScene): void {
    if (this.disposed) return
    if (this.rendering) { this.deferredDocument = document; return }
    const changedDocument = this.document?.id !== document.id
    this.document = document
    this.sceneRevision++
    this.clearEmphasis()
    if (changedDocument) { this.playing = false; this.frame = document.scene?.currentFrame ?? document.scene?.frameStart ?? 1; this.clip = document.scene?.activeClip ?? Object.keys(document.clips ?? {})[0] ?? null }
    else { if (document.scene?.currentFrame !== undefined) this.frame = document.scene.currentFrame; if (document.scene?.activeClip !== undefined) this.clip = document.scene.activeClip || null }
    // Record the render camera BEFORE syncing objects, so it is current even if
    // the object sync below throws part-way.
    this.activeCameraName = typeof document.scene?.activeCamera === 'string' ? document.scene.activeCamera : null
    this.syncMaterials(document.materials ?? [], document.textures ?? {})
    const seen = new Set<string>()
    for (const item of document.objects ?? []) {
      seen.add(item.name)
      this.syncObject(item)
    }
    // Objects deleted in the document must leave the panel, or they linger as
    // ghosts the user can still select.
    for (const name of [...this.entries.keys()]) {
      if (seen.has(name)) continue
      this.removeEntry(name)
    }
    linkSceneHierarchy(new Map([...this.entries].map(([name, entry]) => [name, entry.object])), document.objects, this.root)
    for (const light of this.defaultLights) light.visible = !document.objects.some(item => item.type === 'LIGHT' && item.visible !== false)
    const background = document.scene?.background
    this.scene.background = background?.length && background.length >= 3 ? new THREE.Color().setRGB(background[0], background[1], background[2], THREE.LinearSRGBColorSpace) : null
    this.bindSkins()
    this.setFrame(this.frame, this.clip)
    this.refreshEmphasis()
  }

  private syncMaterials(list: SerializedMaterial[], textures: Record<string, SerializedTexture>): void {
    const revision = ++this.materialRevision
    this.textureErrors.clear()
    for (const [name, record] of this.textureSources) if (!textures[name]) { this.textureSources.delete(name); void record.promise.then(texture => texture.dispose()).catch(() => {}) }
    const live = new Set<string>()
    for (const item of list) {
      live.add(item.name)
      const existing = this.materials.get(item.name)
      if (existing) {
        this.disposeMaterialTextures(existing)
        applyMaterial(existing, item)
        this.loadMaterialTextures(existing, item, textures, revision)
        continue
      }
      const material = new THREE.MeshStandardMaterial()
      applyMaterial(material, item)
      this.materials.set(item.name, material)
      this.disposables.add(material)
      this.loadMaterialTextures(material, item, textures, revision)
    }
    for (const [name, material] of [...this.materials]) {
      if (live.has(name)) continue
      this.materials.delete(name)
      this.disposeMaterialTextures(material)
      material.dispose()
      this.disposables.delete(material)
    }
  }

  private syncObject(item: SerializedObject): void {
    const existing = this.entries.get(item.name)
    if (existing && existing.kind === item.type && item.type !== 'LIGHT' && Boolean(item.joint) === (existing.object instanceof THREE.Bone) && (item.type !== 'MESH' || existing.placeholder || Boolean(item.skin) === (existing.object instanceof THREE.SkinnedMesh)) && (!item.geometry_key || existing.geometryKey === item.geometry_key)) {
      existing.item = item
      applyTransform(existing.object, item)
      existing.object.visible = item.visible !== false
      if ((existing.object as THREE.Mesh).isMesh && !existing.placeholder) this.applyMeshAppearance(existing.object as THREE.Mesh, item)
      if (existing.placeholder && !this.loadingObjects.has(item.name)) this.scheduleMeshLoad(item, existing.geometryKey ?? `${item.name}:unkeyed`, existing.generation)
      return
    }
    if (existing) this.removeEntry(item.name)
    const generation = ++this.generation
    // A mesh shows a placeholder immediately so the object is selectable and
    // listed while its buffers are still being fetched; cameras and lights have
    // no geometry to wait for.
    if (item.type === 'MESH') {
      const key = item.geometry_key ?? `${item.name}:unkeyed`
      const cached = this.acquireGeometry(key)
      const object = cached ? makeMesh(item, cached, this.materialFor(item)) : this.placeholderFor(item)
      this.mount(item, object, key, generation, cached !== null)
      if (!cached) this.scheduleMeshLoad(item, key, generation)
      return
    }
    const object = item.joint ? new THREE.Bone() : item.type === 'CAMERA' ? makeCameraProxy(item) : item.type === 'LIGHT' ? makeLightObject(item) : new THREE.Group()
    this.mount(item, object, undefined, generation, true)
  }

  private scheduleMeshLoad(item: SerializedObject, key: string, generation: number): void {
    const task = this.loadMeshGeometry(item, key, generation).catch(error => { if (this.entries.get(item.name)?.generation === generation) this.meshErrors.set(item.name, String((error as Error)?.message ?? error)) })
    this.loadingObjects.set(item.name, task)
    void task.finally(() => { if (this.loadingObjects.get(item.name) === task) this.loadingObjects.delete(item.name) })
  }

  private mount(item: SerializedObject, object: THREE.Object3D, meshKey: string | undefined,
    generation: number, resolved: boolean): void {
    applyTransform(object, item)
    object.visible = item.visible !== false
    object.userData.modelName = item.name
    object.traverse(child => { child.userData.modelName = item.name })
    this.root.add(object)
    this.entries.set(item.name, {
      object, name: item.name, kind: item.type, geometryKey: meshKey,
      placeholder: !resolved, generation,
      item,
    })
  }

  private removeEntry(name: string): void {
    const entry = this.entries.get(name)
    if (!entry) return
    this.entries.delete(name)
    if (this.selected === name) { this.selected = null; this.transform.detach() }
    if (this.hovered === name) this.hovered = null
    for (const other of this.entries.values()) if (other.object.parent === entry.object) this.root.add(other.object)
    entry.object.removeFromParent()
    disposeObject(entry.object)
    this.meshErrors.delete(name)
    if (entry.geometryKey) this.releaseGeometry(entry.geometryKey)
  }

  /** Take a reference on a cached geometry, or return null when it must load. */
  private acquireGeometry(key: string): THREE.BufferGeometry | null {
    const geometry = this.geometries.get(key)
    if (!geometry) return null
    this.geometryUsers.set(key, (this.geometryUsers.get(key) ?? 0) + 1)
    return geometry
  }

  private releaseGeometry(key: string): void {
    const users = (this.geometryUsers.get(key) ?? 1) - 1
    if (users > 0) {
      this.geometryUsers.set(key, users)
      return
    }
    this.geometryUsers.delete(key)
    const geometry = this.geometries.get(key)
    if (geometry) {
      this.geometries.delete(key)
      this.disposables.delete(geometry)
      geometry.dispose()
    }
  }

  /**
   * Fetch one object's evaluated buffers and swap its placeholder out.
   *
   * A geometry_key is a content hash, so several objects that share geometry share
   * one fetch and one buffer set; a generation check drops the result if the
   * object was rebuilt or removed while the request was in flight.
   */
  private async loadMeshGeometry(item: SerializedObject, key: string, generation: number): Promise<void> {
    const inFlight = this.pendingMeshes.get(key)
    if (inFlight) {
      await inFlight
    } else {
      const task = (async () => {
        const payload = await this.options.loadMesh(item.name)
        if (!payload) throw new Error(`No geometry returned for ${item.name}`)
        const storedKey = payload.geometry_key || key
        if (storedKey !== key) throw new Error(`Geometry changed while loading ${item.name}; reload the scene`)
        if (this.disposed) return
        if (this.geometries.has(storedKey)) return
        const geometry = geometryFrom(payload)
        this.geometries.set(storedKey, geometry)
        this.disposables.add(geometry)
      })()
      this.pendingMeshes.set(key, task)
      try {
        await task
      } finally {
        this.pendingMeshes.delete(key)
      }
    }
    if (this.disposed) return
    const entry = this.entries.get(item.name)
    if (!entry || entry.generation !== generation || !entry.placeholder) return
    const geometry = this.geometries.get(key)
    if (!geometry) return
    this.geometryUsers.set(key, (this.geometryUsers.get(key) ?? 0) + 1)
    const wasSelected = this.selected === item.name
    const current = entry.item
    const mesh = makeMesh(current, geometry, this.materialFor(current))
    const parent = entry.object.parent ?? this.root
    for (const other of this.entries.values()) if (other.object.parent === entry.object) mesh.add(other.object)
    entry.object.removeFromParent()
    disposeObject(entry.object)
    applyTransform(mesh, current)
    mesh.visible = current.visible !== false
    mesh.userData.modelName = current.name
    parent.add(mesh)
    entry.object = mesh
    entry.placeholder = false
    entry.geometryKey = key
    this.applyMeshAppearance(mesh, current)
    this.meshErrors.delete(item.name)
    this.bindSkins()
    this.applyFrame()
    if (wasSelected) { this.selected = null; this.select(item.name) }
    this.refreshEmphasis()
  }

  private materialFor(item: SerializedObject): THREE.Material | THREE.Material[] {
    // The material lives on the mesh datablock, not the object; the host
    // serialization resolves the object's first material slot to a name here.
    const name = item.material
    if (item.materials?.length) return item.materials.map(slot => this.materials.get(slot) ?? EMPTY_MATERIAL)
    return (name && this.materials.get(name)) || EMPTY_MATERIAL
  }

  private applyMeshAppearance(mesh: THREE.Mesh, item: SerializedObject): void {
    mesh.material = this.materialFor(item)
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) if (material instanceof THREE.MeshStandardMaterial && mesh.geometry.getAttribute('color')) { material.vertexColors = true; material.needsUpdate = true }
    const influences = item.morphInfluences ?? item.morph_influences
    if (influences && mesh.morphTargetInfluences) mesh.morphTargetInfluences = influences.slice()
  }

  private bindSkins(): void {
    if (!this.document) return
    bindSceneSkins(new Map([...this.entries].map(([name, entry]) => [name, entry.object])), this.document)
  }

  private disposeMaterialTextures(material: THREE.MeshStandardMaterial): void {
    for (const texture of this.materialTextures.get(material) ?? []) texture.dispose()
    this.materialTextures.delete(material)
  }

  private loadMaterialTextures(material: THREE.MeshStandardMaterial, item: SerializedMaterial, textures: Record<string, SerializedTexture>, revision: number): void {
    const slots = [['baseColorTexture', 'map', true], ['metallicRoughnessTexture', 'metalnessMap', false], ['normalTexture', 'normalMap', false], ['occlusionTexture', 'aoMap', false], ['emissiveTexture', 'emissiveMap', true]] as const
    for (const [field, property, srgb] of slots) {
      const slot = item[field]; if (!slot) continue
      const task = (async () => {
        const source = textures[slot.texture]
        if (!source || !['image/png', 'image/jpeg'].includes(source.mimeType) || !source.dataBase64) throw new Error(`Embedded texture ${slot.texture} is unavailable`)
        const signature = `${source.mimeType}:${source.dataBase64}:${JSON.stringify(source.sampler ?? {})}`
        let record = this.textureSources.get(source.name)
        if (!record || record.signature !== signature) {
          const previous = record
          const promise = new THREE.TextureLoader().loadAsync(`data:${source.mimeType};base64,${source.dataBase64}`).then(texture => { configureTextureSampler(texture, source); if (this.disposed) texture.dispose(); return texture })
          record = { signature, promise }; this.textureSources.set(source.name, record)
          if (previous) void previous.promise.then(texture => texture.dispose()).catch(() => {})
        }
        const base = await record.promise
        if (this.disposed || revision !== this.materialRevision || this.materials.get(item.name) !== material) return
        const texture = textureForSlot(base, slot, srgb)
        const owned = this.materialTextures.get(material) ?? []; owned.push(texture); this.materialTextures.set(material, owned)
        material[property] = texture
        if (field === 'metallicRoughnessTexture') material.roughnessMap = texture
        if (field === 'normalTexture') material.normalScale.setScalar(slot.scale ?? 1)
        if (field === 'occlusionTexture') material.aoMapIntensity = slot.strength ?? 1
        material.needsUpdate = true; this.refreshEmphasis()
      })().catch(error => { if (revision === this.materialRevision) this.textureErrors.set(`${item.name}.${field}`, String((error as Error)?.message ?? error)) })
      this.pendingTextures.add(task)
      void task.finally(() => this.pendingTextures.delete(task))
    }
  }

  /** Placeholder shown until evaluated geometry arrives. */
  private placeholderFor(item: SerializedObject): THREE.Object3D {
    const geometry = new THREE.BoxGeometry(1, 1, 1)
    const material = new THREE.MeshStandardMaterial({ color: 0x6b7280, wireframe: true, transparent: true, opacity: 0.55 })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = item.name
    mesh.userData.placeholder = true
    mesh.userData.ownsGeometry = true
    mesh.userData.ownsMaterial = true
    return mesh
  }

  // Pointer handlers as constructor-assigned arrows, not class-field
  // initializers (see the field note above).
  private definePointerDown(): (event: PointerEvent) => void {
    return (event: PointerEvent): void => {
      if (this.rendering) return
      if (event.button !== 0) return
      const hit = this.pick(event)
      this.select(hit)
    }
  }

  private definePointerMove(): (event: PointerEvent) => void {
    return (event: PointerEvent): void => {
      if (this.rendering) return
      if (this.transform.dragging) return
      const hit = this.pick(event)
      if (hit !== this.hovered) {
        this.hovered = hit
        this.options.onHover?.(hit)
        this.renderer.domElement.style.cursor = hit ? 'pointer' : 'default'
        this.refreshEmphasis()
      }
    }
  }

  private pick(event: PointerEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const targets: THREE.Object3D[] = []
    for (const entry of this.entries.values()) if (entry.object.visible) targets.push(entry.object)
    if (!targets.length) return null
    const hits = this.raycaster.intersectObjects(targets, true)
    for (const hit of hits) {
      const name = hit.object.userData.modelName as string | undefined
      if (name) return name
    }
    return null
  }

  select(name: string | null): void {
    if (this.rendering) return
    if (this.selected === name) return
    this.selected = name
    const entry = name ? this.entries.get(name) : undefined
    if (entry) { enableTRS(entry.object); this.transform.attach(entry.object) }
    else this.transform.detach()
    this.refreshEmphasis()
    this.options.onSelect?.(name)
  }

  get selection(): string | null { return this.selected }

  /**
   * Highlight selection and hover WITHOUT touching shared materials.
   *
   * Two objects assigned the same material share one three.js material,
   * so setting `emissive` on it recolours every object in the scene that uses
   * it — selecting one cube would light up all of them. Each highlighted object
   * gets its own clone instead, and the original materials are kept so they can
   * be put back exactly when the highlight moves on.
   */
  private refreshEmphasis(): void {
    this.clearEmphasis()
    if (this.rendering) return
    for (const name of [this.selected, this.hovered]) {
      if (!name || this.highlightMaterials.has(name)) continue
      const entry = this.entries.get(name)
      if (!entry) continue
      const color = name === this.selected ? SELECTED_EMISSIVE : HOVER_EMISSIVE
      const meshes = highlightableMeshes(entry.object), highlights: THREE.MeshStandardMaterial[] = []
      if (!meshes.length) continue
      this.highlightMaterials.set(name, { highlights, meshes: meshes.map(mesh => [mesh, mesh.material]) })
      for (const mesh of meshes) {
        const originals = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        const replacements = originals.map(material => {
          if (!(material instanceof THREE.MeshStandardMaterial)) return material
          const clone = material.clone(); clone.emissive.setHex(color); clone.emissiveIntensity = Math.max(clone.emissiveIntensity, 0.3); highlights.push(clone); return clone
        })
        mesh.material = Array.isArray(mesh.material) ? replacements : replacements[0]
      }
    }
  }

  private clearEmphasis(): void {
    for (const [name, saved] of [...this.highlightMaterials]) {
      for (const [mesh, original] of saved.meshes) mesh.material = original
      for (const material of saved.highlights) material.dispose()
      this.highlightMaterials.delete(name)
    }
  }

  /**
   * Write a finished drag back in the document's own frame.
   *
   * The gizmo moves the object inside the rotated root, so its world matrix is
   * in three.js Y-up space; composing with the root's inverse recovers the
   * object's LOCAL matrix, which is exactly the location / rotation / scale
   * triplet the document stores. Euler order is fixed to XYZ on both sides
   * (applyTransform sets it, the kernel reads it), so the quaternion round-trips
   * back to the same triplet rather than depending on a guessed convention.
   */
  private async commitDrag(): Promise<void> {
    const name = this.selected
    if (!name) return
    const entry = this.entries.get(name)
    if (!entry) return
    const next = localTransformForWriteback(entry.object)
    try {
      await this.options.onTransform?.(name, next)
    } catch {
      // The host re-publishes the authoritative document on success; on failure
      // the next update() restores the real state, so nothing to undo here.
    }
  }

  /** The transform gizmo mode: translate, rotate or scale. */
  setMode(mode: 'translate' | 'rotate' | 'scale'): void {
    this.transform.setMode(mode)
  }

  get mode(): string { return this.transform.mode }

  setFrame(frame: number, clip: string | null = this.clip): void {
    if (!Number.isFinite(frame)) throw new Error('Animation frame must be finite')
    if (clip && !this.document?.clips?.[clip]) throw new Error(`Animation clip not found: ${clip}`)
    this.frame = frame; this.clip = clip
    if (!this.rendering) this.applyFrame()
    this.options.onFrame?.(frame, this.playing)
  }

  play(playing: boolean): void {
    this.playing = playing; this.lastFrameTime = null
    this.options.onFrame?.(this.frame, playing)
    if (playing) this.startLoop()
  }

  get currentFrame(): number { return this.frame }
  get isPlaying(): boolean { return this.playing }
  get currentClip(): string | null { return this.clip }

  private applyFrame(): void {
    if (!this.document) return
    applyAnimationFrame(new Map([...this.entries].map(([name, entry]) => [name, entry.object])), this.document, this.frame, this.clip)
    this.root.updateMatrixWorld(true)
    for (const entry of this.entries.values()) if (entry.object instanceof THREE.SkinnedMesh) {
      entry.object.skeleton?.update()
      const bounds = entry.object as unknown as { boundingBox: THREE.Box3 | null; boundingSphere: THREE.Sphere | null }
      bounds.boundingBox = null; bounds.boundingSphere = null; entry.object.frustumCulled = false
    }
  }

  /** Wait for complete object replacements and decoded material images. */
  async whenReady(): Promise<void> {
    const revision = this.sceneRevision
    await Promise.all([...this.loadingObjects.values(), ...this.pendingTextures])
    if (this.disposed) throw new Error('The 3D viewport is closed')
    if (revision !== this.sceneRevision) throw new Error('The 3D document changed while preparing the render; retry it')
    const missing = [...this.entries.values()].filter(entry => entry.placeholder).map(entry => entry.name)
    if (missing.length) throw new Error(`Mesh geometry has not resolved: ${missing.map(name => `${name}${this.meshErrors.has(name) ? ` (${this.meshErrors.get(name)})` : ''}`).join(', ')}`)
    if (this.textureErrors.size) throw new Error(`Material textures have not resolved: ${[...this.textureErrors.values()].join('; ')}`)
  }

  /**
   * Render the active document camera to image bytes, off-screen.
   *
   * The host process has no WebGL context, so a `model3d_render` tool call is
   * delegated here (digram's render-request/render-result pattern). This draws
   * into the existing renderer at the requested size, then restores the panel's
   * own view — the visible viewport must not jump or resize as a side effect of
   * the agent asking for a picture.
   *
   * The caller (panel.handleRenderRequest) pushes the host's requested document
   * into this viewport synchronously right before calling, so the scene drawn is
   * by construction the one asked for; there is no id handshake to verify it.
   */
  renderOffscreen(options: RenderOptions): Promise<Uint8Array> {
    const task = this.renderQueue.then(() => this.renderNow(options))
    this.renderQueue = task.then(() => {}, () => {})
    return task
  }

  private async renderNow(options: RenderOptions): Promise<Uint8Array> {
    if (this.disposed) throw new Error('The 3D viewport is closed.')
    await this.whenReady()
    // Find the camera proxy. It is a Group, not a THREE.Camera, so a real
    // PerspectiveCamera is built at its world transform: the proxy already
    // carries the root's Z-up rotation through its world matrix.
    let source: THREE.Object3D | undefined
    if (options.camera) { if (this.entries.get(options.camera)?.kind !== 'CAMERA') throw new Error(`Render camera not found: ${options.camera}`); source = this.entries.get(options.camera)?.object }
    if (!source && this.activeCameraName) source = this.entries.get(this.activeCameraName)?.object
    if (!source) throw new Error('No camera object in the scene to render from.')

    const width = Math.max(1, Math.min(8192, Math.round(options.width) || 640))
    const height = Math.max(1, Math.min(8192, Math.round(options.height) || 480))
    const settings = this.entries.get(source.userData.modelName)?.item.camera
    const lens = Number.isFinite(Number(options.lens)) && Number(options.lens) > 0 ? Number(options.lens) : settings?.lens ?? 50
    // Vertical FOV from focal length on a 36x24mm sensor, the convention the
    // document's `lens` field is expressed in.
    const fov = (2 * Math.atan(24 / (2 * lens)) * 180) / Math.PI

    const camera = new THREE.PerspectiveCamera(fov, width / height, settings?.clipStart ?? 0.05, settings?.clipEnd ?? 2000)
    source.updateWorldMatrix(true, false)
    camera.position.setFromMatrixPosition(source.matrixWorld)
    const position = new THREE.Vector3(), orientation = new THREE.Quaternion(), scale = new THREE.Vector3(); source.matrixWorld.decompose(position, orientation, scale); camera.quaternion.copy(orientation)
    this.scene.add(camera)

    const previousSize = new THREE.Vector2()
    this.renderer.getSize(previousSize)
    const previousPixelRatio = this.renderer.getPixelRatio()
    const gridWasVisible = this.grid.visible
    const transformWasAttached = (this.transform as unknown as { object?: THREE.Object3D }).object !== undefined
    const orbitWasEnabled = this.orbit.enabled, transformWasEnabled = this.transform.enabled
    const previousFrame = this.frame, previousClip = this.clip
    const helpers: Array<[THREE.Object3D, boolean]> = []
    try {
      this.setFrame(options.frame ?? this.document?.scene?.currentFrame ?? this.frame, options.clip ?? this.document?.scene?.activeClip ?? this.clip)
      source.updateWorldMatrix(true, false)
      source.matrixWorld.decompose(camera.position, camera.quaternion, scale)
      this.rendering = true
      this.orbit.enabled = false; this.transform.enabled = false
      this.stopLoop()
      this.clearEmphasis()
      // Editor chrome must not appear in a delivered image.
      this.grid.visible = false
      if (transformWasAttached) this.transform.detach()
      this.scene.traverse(object => { if (object.userData.editorHelper) { helpers.push([object, object.visible]); object.visible = false } })
      this.renderer.setPixelRatio(1)
      this.renderer.setSize(width, height, false)
      this.scene.updateMatrixWorld(true)
      if (options.engine === 'pathtrace') {
        const { renderPathTraced } = await import('./pathtrace')
        await renderPathTraced(this.renderer, this.scene, camera, { samples: options.samples ?? 32, bounces: options.bounces ?? 4 })
      } else this.renderer.render(this.scene, camera)
      const canvas = this.renderer.domElement
      const dataUrl = canvas.toDataURL(options.format === 'jpg' ? 'image/jpeg' : 'image/png', 0.95)
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
      return bytes
    } finally {
      this.scene.remove(camera)
      camera.clear()
      this.renderer.setPixelRatio(previousPixelRatio)
      this.renderer.setSize(previousSize.x, previousSize.y, false)
      this.grid.visible = gridWasVisible
      for (const [helper, visible] of helpers) helper.visible = visible
      this.rendering = false
      this.orbit.enabled = orbitWasEnabled; this.transform.enabled = transformWasEnabled
      this.frame = previousFrame; this.clip = previousClip
      this.applyFrame()
      const selected = this.selected ? this.entries.get(this.selected) : undefined
      if (transformWasAttached && selected) this.transform.attach(selected.object)
      this.resize()
      const deferred = this.deferredDocument; this.deferredDocument = null
      if (deferred) this.update(deferred)
      this.refreshEmphasis()
      this.startLoop()
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearEmphasis()
    this.stopLoop()
    this.resizeObserver.disconnect()
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown)
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove)
    this.transform.detach()
    this.transform.dispose()
    this.orbit.dispose()
    for (const entry of this.entries.values()) {
      this.root.remove(entry.object)
      disposeObject(entry.object)
    }
    this.entries.clear()
    for (const geometry of this.geometries.values()) geometry.dispose()
    this.geometries.clear()
    this.geometryUsers.clear()
    for (const material of this.materials.values()) { this.disposeMaterialTextures(material); material.dispose() }
    this.materials.clear()
    for (const record of this.textureSources.values()) void record.promise.then(texture => texture.dispose()).catch(() => {})
    this.highlightMaterials.clear()
    for (const item of this.disposables) { try { item.dispose() } catch { /* already gone */ } }
    this.disposables.clear()
    this.grid.dispose()
    this.renderer.dispose()
    // A WebGL context is a scarce browser resource; leaving it attached to a
    // removed canvas leaks one per panel open.
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}

/** A mesh object, with the shared caches marked as NOT owned by it. */
function makeMesh(item: SerializedObject, geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[]): THREE.Mesh {
  if (Array.isArray(material) && !geometry.groups.length) geometry.addGroup(0, geometry.index?.count ?? geometry.getAttribute('position').count, 0)
  const mesh = item.skin ? new THREE.SkinnedMesh(geometry, material) : new THREE.Mesh(geometry, material)
  mesh.name = item.name
  mesh.updateMorphTargets()
  const influences = item.morphInfluences ?? item.morph_influences
  if (influences && mesh.morphTargetInfluences) mesh.morphTargetInfluences = influences.slice()
  for (const entry of Array.isArray(material) ? material : [material]) if (entry instanceof THREE.MeshStandardMaterial && geometry.getAttribute('color')) { entry.vertexColors = true; entry.needsUpdate = true }
  // Both come from a cache outliving this object: disposing them here would
  // blank every other object sharing the same geometry or material.
  mesh.userData.ownsGeometry = false
  mesh.userData.ownsMaterial = false
  return mesh
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    if (mesh instanceof THREE.SkinnedMesh) mesh.skeleton?.dispose()
    // Shared materials belong to the material cache and shared geometries to
    // the geometry_key cache; only what this object created on its own is freed.
    if (mesh.userData.ownsMaterial === true) {
      const material = mesh.material
      if (Array.isArray(material)) for (const item of material) item.dispose()
      else material?.dispose()
    }
    if (mesh.userData.ownsGeometry === true) mesh.geometry?.dispose()
  })
}

/** Snapshot the meshes that can carry a highlight, with their real materials. */
function highlightableMeshes(object: THREE.Object3D): THREE.Mesh[] {
  const found: THREE.Mesh[] = []
  object.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const material = mesh.material
    if (child.userData.modelName !== object.userData.modelName) return
    if (!material || !(Array.isArray(material) ? material : [material]).some(m => m instanceof THREE.MeshStandardMaterial)) return
    found.push(mesh)
  })
  return found
}

/**
 * Apply a serialized transform.
 *
 * The document stores location / rotation / scale datablocks (not a baked
 * matrix), so those three are authoritative and the drag gizmo edits exactly
 * them. Euler order is fixed to XYZ on both sides; the kernel never rotates
 * geometry, only the root group converts Z-up to three.js Y-up.
 */
export function applyTransform(object: THREE.Object3D, item: SerializedObject): void {
  if (item.matrix) {
    if (item.matrix.length !== 16 || !item.matrix.every(Number.isFinite)) throw new Error('Invalid object transform matrix')
    object.matrix.fromArray(item.matrix); object.matrix.decompose(object.position, object.quaternion, object.scale)
    object.matrixAutoUpdate = false; object.matrixWorldNeedsUpdate = true; return
  }
  object.matrixAutoUpdate = true
  object.position.set(item.location?.[0] ?? 0, item.location?.[1] ?? 0, item.location?.[2] ?? 0)
  const quaternion = item.rotationQuaternion ?? item.rotation_quaternion
  if (quaternion) object.quaternion.fromArray(quaternion).normalize()
  else object.rotation.set(item.rotation_euler?.[0] ?? 0, item.rotation_euler?.[1] ?? 0, item.rotation_euler?.[2] ?? 0, 'XYZ')
  // Guard against a zero scale: it collapses the object and makes it
  // unselectable, which reads to the user as a vanished object.
  object.scale.set(item.scale?.[0] ?? 1, item.scale?.[1] ?? 1, item.scale?.[2] ?? 1)
  object.updateMatrix()
}

export function applyMaterial(material: THREE.MeshStandardMaterial, item: SerializedMaterial): void {
  const color = item.baseColor
  if (Array.isArray(color) && color.length >= 3) material.color.setRGB(color[0], color[1], color[2], THREE.LinearSRGBColorSpace)
  material.metalness = typeof item.metallic === 'number' ? item.metallic : 0
  material.roughness = typeof item.roughness === 'number' ? item.roughness : 0.5
  const alpha = typeof item.alpha === 'number' ? item.alpha : color?.[3] ?? 1
  material.transparent = item.alphaMode === 'BLEND' || (!item.alphaMode && alpha < 1)
  material.opacity = alpha
  material.alphaTest = item.alphaMode === 'MASK' ? item.alphaCutoff ?? 0.5 : 0
  material.side = item.doubleSided ? THREE.DoubleSide : THREE.FrontSide
  material.map = null; material.metalnessMap = null; material.roughnessMap = null; material.normalMap = null; material.aoMap = null; material.emissiveMap = null
  const emission = item.emissiveColor
  const strength = typeof item.emissiveStrength === 'number' ? item.emissiveStrength : 0
  if (Array.isArray(emission) && emission.length >= 3 && strength > 0) {
    material.emissive.setRGB(emission[0], emission[1], emission[2], THREE.LinearSRGBColorSpace)
    material.emissiveIntensity = strength
  } else {
    material.emissive.setHex(0x000000)
  }
  material.needsUpdate = true
}

/** A camera is drawn as a small proxy: it has no geometry of its own. */
function makeCameraProxy(item: SerializedObject): THREE.Object3D {
  const group = new THREE.Group()
  group.name = item.name
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.32, 0.24, 0.44),
    new THREE.MeshStandardMaterial({ color: 0x3f4650, roughness: 0.6 }),
  )
  const lens = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.09, 0.2, 16),
    new THREE.MeshStandardMaterial({ color: 0x23282f, roughness: 0.4 }),
  )
  lens.rotation.x = Math.PI / 2
  lens.position.z = -0.3
  // These are created here and cached nowhere, so the proxies own them: without
  // the flags, disposeObject() would skip both and leak a material per camera.
  for (const mesh of [body, lens]) {
    mesh.userData.ownsGeometry = true
    mesh.userData.ownsMaterial = true
    mesh.userData.editorHelper = true
  }
  group.add(body, lens)
  return group
}

/** A light is drawn as an emissive sphere; a light datablock is not visible geometry. */
export function makeLightObject(item: SerializedObject): THREE.Object3D {
  const group = new THREE.Group(); group.name = item.name
  const type = String(item.light?.type ?? 'POINT')
  const rgb = item.light?.color ?? [1, 1, 1], lightColor = new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace), energy = Math.max(0, item.light?.energy ?? 1000)
  let light: THREE.Light
  if (type === 'SUN') light = new THREE.DirectionalLight(lightColor, energy)
  else if (type === 'SPOT') light = new THREE.SpotLight(lightColor, energy / Math.PI)
  else if (type === 'AREA') { RectAreaLightUniformsLib.init(); light = new THREE.RectAreaLight(lightColor, energy, 1, 1) }
  else light = new THREE.PointLight(lightColor, energy / (4 * Math.PI))
  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) { light.target.position.set(0, 0, -1); group.add(light.target) }
  group.add(light)
  const color = type === 'SUN' ? 0xffd9a0 : type === 'AREA' ? 0xcfe4ff : 0xfff0c0
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 16, 12),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.4 }),
  )
  mesh.name = item.name
  mesh.userData.ownsGeometry = true
  mesh.userData.ownsMaterial = true
  mesh.userData.editorHelper = true
  group.add(mesh)
  return group
}

function enableTRS(object: THREE.Object3D): void {
  if (object.matrixAutoUpdate) return
  object.matrix.decompose(object.position, object.quaternion, object.scale); object.matrixAutoUpdate = true; object.updateMatrix()
}

export function localTransformForWriteback(object: THREE.Object3D): { location: number[]; rotation_euler: number[]; scale: number[] } {
  object.updateWorldMatrix(true, false)
  const local = object.parent ? new THREE.Matrix4().multiplyMatrices(object.parent.matrixWorld.clone().invert(), object.matrixWorld) : object.matrixWorld.clone()
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3(); local.decompose(position, quaternion, scale)
  const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ')
  return { location: position.toArray(), rotation_euler: [euler.x, euler.y, euler.z], scale: scale.toArray() }
}

export function linkSceneHierarchy(objects: Map<string, THREE.Object3D>, items: SerializedObject[], root: THREE.Object3D): void {
  const byName = new Map(items.map(item => [item.name, item])), checked = new Set<string>(), active = new Set<string>()
  const check = (name: string): void => {
    if (checked.has(name)) return
    if (active.has(name) || active.size > 256) throw new Error('Invalid scene hierarchy cycle or depth')
    const item = byName.get(name); if (!item) throw new Error(`Scene parent not found: ${name}`)
    active.add(name); if (item.parent) check(item.parent); active.delete(name); checked.add(name)
  }
  for (const item of items) check(item.name)
  for (const item of items) {
    const object = objects.get(item.name); if (!object) continue
    const parent = item.parent ? objects.get(item.parent) : root
    if (!parent) throw new Error(`Scene parent not loaded: ${item.parent}`)
    if (object.parent !== parent) parent.add(object)
  }
  root.updateMatrixWorld(true)
}

export function bindSceneSkins(objects: Map<string, THREE.Object3D>, document: SerializedScene): void {
  for (const item of document.objects) {
    if (!item.skin) continue
    const mesh = objects.get(item.name); if (!(mesh instanceof THREE.SkinnedMesh)) continue
    const skin = document.skins?.[item.skin]; if (!skin) throw new Error(`Skin not found: ${item.skin}`)
    if (skin.inverseBindMatrices.length !== skin.joints.length * 16) throw new Error('Invalid inverse-bind matrix count')
    const bones = skin.joints.map(name => { const bone = objects.get(name); if (!(bone instanceof THREE.Bone)) throw new Error(`Skin joint is not a loaded bone: ${name}`); return bone })
    const inverses = bones.map((_, i) => new THREE.Matrix4().fromArray(skin.inverseBindMatrices.slice(i * 16, i * 16 + 16)))
    mesh.skeleton?.dispose(); mesh.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4())
    mesh.updateWorldMatrix(true, false); mesh.skeleton.update()
  }
}

export function configureTextureSampler(texture: THREE.Texture, source: SerializedTexture): void {
  const wraps: Record<number, THREE.Wrapping> = { 10497: THREE.RepeatWrapping, 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping }
  const filters: Record<number, THREE.TextureFilter> = { 9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter, 9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter }
  texture.flipY = false; texture.wrapS = wraps[source.sampler?.wrapS ?? 10497] ?? THREE.RepeatWrapping; texture.wrapT = wraps[source.sampler?.wrapT ?? 10497] ?? THREE.RepeatWrapping
  texture.magFilter = (filters[source.sampler?.magFilter ?? 9729] ?? THREE.LinearFilter) as THREE.MagnificationTextureFilter
  texture.minFilter = (filters[source.sampler?.minFilter ?? 9987] ?? THREE.LinearMipmapLinearFilter) as THREE.MinificationTextureFilter
  texture.needsUpdate = true
}

export function textureForSlot(source: THREE.Texture, slot: TextureSlot, srgb: boolean): THREE.Texture {
  const texture = source.clone(); texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.channel = slot.transform?.texCoord ?? slot.texCoord ?? 0
  if (texture.channel !== 0 && texture.channel !== 1) throw new Error('Only UV coordinate sets 0 and 1 are supported')
  if (slot.transform) { texture.offset.fromArray(slot.transform.offset); texture.repeat.fromArray(slot.transform.scale); texture.rotation = slot.transform.rotation }
  texture.updateMatrix(); texture.needsUpdate = true; return texture
}

/** glTF cubic tracks use incoming/value/outgoing triplets at each key. */
export function sampleAnimationTrack(track: SerializedTrack, time: number, width: number): number[] {
  if (!Number.isFinite(time) || width < 1 || !Number.isInteger(width) || !track.times.length || !track.times.every((t, i) => Number.isFinite(t) && (i === 0 || t > track.times[i - 1])) || !track.values.every(Number.isFinite)) throw new Error('Invalid animation track')
  const cubic = track.interpolation === 'CUBICSPLINE', stride = width * (cubic ? 3 : 1)
  if (track.values.length !== track.times.length * stride) throw new Error('Animation track value count mismatch')
  const valueAt = (index: number): number[] => track.values.slice(index * stride + (cubic ? width : 0), index * stride + (cubic ? width * 2 : width))
  let left = 0; while (left + 1 < track.times.length && track.times[left + 1] <= time) left++
  if (time <= track.times[0]) return valueAt(0)
  if (left === track.times.length - 1 || track.interpolation === 'STEP') return valueAt(left)
  const a = valueAt(left), b = valueAt(left + 1), duration = track.times[left + 1] - track.times[left], t = (time - track.times[left]) / duration
  let value: number[]
  if (cubic) {
    const t2 = t * t, t3 = t2 * t, incoming = track.values.slice((left + 1) * stride, (left + 1) * stride + width), outgoing = track.values.slice(left * stride + width * 2, left * stride + width * 3)
    value = a.map((v, i) => (2 * t3 - 3 * t2 + 1) * v + (t3 - 2 * t2 + t) * duration * outgoing[i] + (-2 * t3 + 3 * t2) * b[i] + (t3 - t2) * duration * incoming[i])
  } else if (track.path === 'rotation') value = new THREE.Quaternion().fromArray(a).normalize().slerp(new THREE.Quaternion().fromArray(b).normalize(), t).toArray()
  else value = a.map((v, i) => v + (b[i] - v) * t)
  if (track.path === 'rotation') value = new THREE.Quaternion().fromArray(value).normalize().toArray()
  return value
}

export function animationFrameRange(document: SerializedScene, clip?: string | null): [number, number] {
  const start = document.scene?.frameStart ?? 1, fps = document.scene?.fps ?? 24
  let end = document.scene?.frameEnd ?? start
  for (const item of document.objects) for (const keys of Object.values(item.animation ?? {})) for (const key of keys) end = Math.max(end, key.frame)
  if (clip && document.clips?.[clip]) for (const track of document.clips[clip].tracks) if (track.times.length) end = Math.max(end, start + track.times[track.times.length - 1] * fps)
  return [start, Math.max(start + 1, end)]
}

export function applyAnimationFrame(objects: Map<string, THREE.Object3D>, document: SerializedScene, frame: number, clip?: string | null): void {
  for (const item of document.objects) {
    const object = objects.get(item.name); if (!object) continue
    applyTransform(object, item)
    const mesh = object as THREE.Mesh, influences = item.morphInfluences ?? item.morph_influences
    if (mesh.morphTargetInfluences) mesh.morphTargetInfluences = influences?.slice() ?? mesh.morphTargetInfluences.map(() => 0)
    for (const [path, unsorted] of Object.entries(item.animation ?? {})) {
      if (!unsorted.length) continue
      const keys = unsorted.slice().sort((a, b) => a.frame - b.frame), first = keys[0], last = keys[keys.length - 1]
      let left = first, right = first
      if (frame >= last.frame) left = right = last
      else for (let i = 0; i < keys.length - 1; i++) if (frame >= keys[i].frame && frame <= keys[i + 1].frame) { left = keys[i]; right = keys[i + 1]; break }
      const amount = left === right ? 0 : (frame - left.frame) / (right.frame - left.frame), value = left.value.map((v, i) => v + ((right.value[i] ?? v) - v) * amount)
      enableTRS(object)
      if (path === 'location' || path === 'translation') object.position.fromArray(value)
      else if (path === 'rotation_euler' || path === 'rotationEuler') object.rotation.set(value[0], value[1], value[2], 'XYZ')
      else if (path === 'rotation_quaternion') object.quaternion.fromArray(left.value).normalize().slerp(new THREE.Quaternion().fromArray(right.value).normalize(), amount)
      else if (path === 'scale') object.scale.fromArray(value)
      else if ((path === 'weights' || path === 'morph_weights') && mesh.morphTargetInfluences) mesh.morphTargetInfluences = value
    }
  }
  if (!clip) return
  const selected = document.clips?.[clip]; if (!selected) throw new Error(`Animation clip not found: ${clip}`)
  const time = (frame - (document.scene?.frameStart ?? 1)) / (document.scene?.fps ?? 24)
  for (const track of selected.tracks) {
    const object = objects.get(track.object); if (!object) throw new Error(`Animation object not found: ${track.object}`)
    if (track.path === 'weights' && object.userData.placeholder) continue
    const mesh = object as THREE.Mesh, width = track.path === 'rotation' ? 4 : track.path === 'weights' ? mesh.morphTargetInfluences?.length ?? 0 : 3
    const value = sampleAnimationTrack(track, time, width); enableTRS(object)
    if (track.path === 'translation') object.position.fromArray(value)
    else if (track.path === 'rotation') object.quaternion.fromArray(value)
    else if (track.path === 'scale') object.scale.fromArray(value)
    else if (track.path === 'weights') mesh.morphTargetInfluences = value
  }
}
