import { describe, expect, test } from 'bun:test'
import * as THREE from 'three'
import { Model3DViewport, applyAnimationFrame, applyMaterial, applyTransform, bindSceneSkins, configureTextureSampler, geometryFrom, linkSceneHierarchy, localTransformForWriteback, makeLightObject, sampleAnimationTrack, textureForSlot, type MeshPayload, type SerializedObject, type SerializedScene } from './viewport'

const item = (name: string, changes: Partial<SerializedObject> = {}): SerializedObject => ({ name, type: 'MESH', location: [0, 0, 0], rotation_euler: [0, 0, 0], scale: [1, 1, 1], visible: true, modifiers: [], geometry_key: name, ...changes })
const payload = (name: string): MeshPayload => ({ name, geometry_key: name, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) })
const near = (actual: number, expected: number): void => expect(Math.abs(actual - expected)).toBeLessThan(1e-6)

/** Exercise the real async scene methods without allocating a GPU context. */
function headless(loadMesh: (name: string) => Promise<MeshPayload>): Model3DViewport {
  const view = Object.create(Model3DViewport.prototype) as any
  Object.assign(view, { options: { loadMesh }, disposed: false, rendering: false, deferredDocument: null, document: null, sceneRevision: 0, materialRevision: 0, generation: 0, root: new THREE.Group(), scene: new THREE.Scene(), entries: new Map(), geometries: new Map(), geometryUsers: new Map(), materials: new Map(), highlightMaterials: new Map(), disposables: new Set(), pendingMeshes: new Map(), loadingObjects: new Map(), pendingTextures: new Set(), textureSources: new Map(), materialTextures: new Map(), textureErrors: new Map(), meshErrors: new Map(), defaultLights: [], frame: 1, clip: null, playing: false, selected: null, hovered: null, transform: { detach() {}, attach() {} }, activeCameraName: null })
  view.root.rotation.x = -Math.PI / 2; view.scene.add(view.root)
  return view as Model3DViewport
}

describe('native 3D evaluated buffers', () => {
  test('UVs, tangents, colors, skin, groups and morph deltas reach independent GPU attributes', () => {
    const data = payload('mesh')
    data.uvs = new Float32Array([0, 0, 1, 0, 0, 1]); data.uvs1 = new Float32Array([0.2, 0.2, 0.8, 0.2, 0.2, 0.8]); data.tangents = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]); data.colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]); data.skinIndices = new Uint16Array(12); data.skinWeights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]); data.groups = [{ start: 0, count: 3, materialIndex: 1 }]; data.morphTargets = [{ name: 'Smile', positions: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]) }]
    const geometry = geometryFrom(data)
    for (const [channel, width] of [['uv', 2], ['uv1', 2], ['tangent', 4], ['color', 4], ['skinIndex', 4], ['skinWeight', 4]] as const) { expect(geometry.getAttribute(channel).itemSize).toBe(width); expect(geometry.getAttribute(channel).count).toBe(3) }
    expect(geometry.getAttribute('skinIndex').array).toBeInstanceOf(Uint16Array)
    expect(geometry.groups).toEqual(data.groups); expect(geometry.morphTargetsRelative).toBe(true); expect(geometry.morphAttributes.position![0].name).toBe('Smile')
    data.positions[0] = 99; expect(geometry.getAttribute('position').getX(0)).toBe(0)
    expect(() => geometryFrom({ ...payload('bad'), uvs: new Float32Array([0, 0]) })).toThrow('uv')
    expect(() => geometryFrom({ ...payload('bad'), indices: new Uint32Array([0, 1, 9]) })).toThrow('triangle')
  })

  test('independent out-of-order mesh fetches all resolve and use the latest local transform', async () => {
    const resolvers = new Map<string, (p: MeshPayload) => void>()
    const view = headless(name => new Promise(resolve => resolvers.set(name, resolve)))
    const document: SerializedScene = { id: 'doc', objects: [item('one'), item('two'), item('three')], materials: [] }
    view.update(document)
    view.update({ ...document, objects: [item('one', { location: [7, 0, 0] }), item('two'), item('three')] })
    resolvers.get('two')!(payload('two')); resolvers.get('one')!(payload('one')); resolvers.get('three')!(payload('three'))
    await view.whenReady()
    const entries = (view as any).entries as Map<string, any>
    for (const name of ['one', 'two', 'three']) { expect(entries.get(name).placeholder).toBe(false); expect(entries.get(name).object.isMesh).toBe(true) }
    expect(entries.get('one').object.position.x).toBe(7)
  })

  test('persistent playhead and native quaternion/morph channels select a real pose on load', async () => {
    const data = payload('mesh'); data.morphTargets = [{ positions: new Float32Array(9) }]
    const view = headless(async () => data)
    view.update({ id: 'frame', scene: { frameStart: 1, fps: 10, currentFrame: 6 }, materials: [], objects: [item('mesh', { animation: { rotation_quaternion: [{ frame: 1, value: [0, 0, 0, 1] }, { frame: 11, value: [0, 0, 1, 0] }], morph_weights: [{ frame: 1, value: [0] }, { frame: 11, value: [1] }] } })] })
    await view.whenReady()
    const mesh = (view as any).entries.get('mesh').object as THREE.Mesh
    expect(view.currentFrame).toBe(6); near(mesh.quaternion.z, Math.SQRT1_2); near(mesh.morphTargetInfluences![0], 0.5)
  })

  test('imported morph animation waits through mesh placeholders and evaluates after replacement', async () => {
    let resolve!: (data: MeshPayload) => void
    const view = headless(() => new Promise(done => { resolve = done })), data = payload('animated'); data.morphTargets = [{ positions: new Float32Array(9) }]
    view.update({ id: 'morph', scene: { currentFrame: 6, fps: 10, frameStart: 1, activeClip: 'Morph' }, objects: [item('animated')], materials: [], clips: { Morph: { name: 'Morph', tracks: [{ object: 'animated', path: 'weights', times: [0, 1], values: [0, 1], interpolation: 'LINEAR' }] } } })
    resolve(data); await view.whenReady()
    const mesh = (view as any).entries.get('animated').object as THREE.Mesh
    near(mesh.morphTargetInfluences![0], 0.5)
  })

  test('renders cannot proceed with a rejected mesh fetch or an undecoded embedded texture', async () => {
    const failed = headless(async () => { throw new Error('missing bytes') })
    failed.update({ id: 'bad', objects: [item('broken')], materials: [] })
    let failure = ''; try { await failed.whenReady() } catch (error) { failure = String(error) }
    expect(failure).toContain('missing bytes')
    let decode!: (texture: THREE.Texture<HTMLImageElement>) => void
    const originalLoader = THREE.TextureLoader.prototype.loadAsync
    THREE.TextureLoader.prototype.loadAsync = () => new Promise<THREE.Texture<HTMLImageElement>>(resolve => { decode = resolve })
    try {
      const textured = headless(async name => payload(name))
      textured.update({ id: 'painted', objects: [item('paint', { material: 'Paint', materials: ['Paint'] })], materials: [{ name: 'Paint', baseColorTexture: { texture: 'Color' } }], textures: { Color: { name: 'Color', mimeType: 'image/png', dataBase64: 'fixture' } } })
      let ready = false; const waiting = textured.whenReady().then(() => { ready = true })
      await Promise.resolve(); await Promise.resolve(); expect(ready).toBe(false)
      decode(new THREE.Texture<HTMLImageElement>()); await waiting
      const material = (textured as any).materials.get('Paint') as THREE.MeshStandardMaterial
      expect(material.map).toBeInstanceOf(THREE.Texture); expect(material.map!.colorSpace).toBe(THREE.SRGBColorSpace)
    } finally { THREE.TextureLoader.prototype.loadAsync = originalLoader }
  })
})

describe('native 3D scene transforms and skeletons', () => {
  test('EMPTY parents, joint bones, matrices and quaternions retain their local document transforms', () => {
    const root = new THREE.Group(); root.rotation.x = -Math.PI / 2
    const parent = new THREE.Group(), child = new THREE.Object3D(), bone = new THREE.Bone()
    const parentItem = item('parent', { type: 'EMPTY', location: [5, 1, 2], rotation_euler: [0.2, 0.3, 0.4], scale: [2, 2, 2] }), childItem = item('child', { parent: 'parent', location: [1, 2, 3], rotationQuaternion: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [-1, 1, 1] }), boneItem = item('bone', { type: 'EMPTY', joint: true, parent: 'child', matrix: Array.from(new THREE.Matrix4().makeTranslation(0, 0, 2).toArray()) })
    for (const [object, source] of [[parent, parentItem], [child, childItem], [bone, boneItem]] as const) applyTransform(object, source)
    linkSceneHierarchy(new Map([['parent', parent], ['child', child], ['bone', bone]]), [parentItem, childItem, boneItem], root)
    expect(child.parent).toBe(parent); expect(bone.parent).toBe(child); expect(bone.matrixAutoUpdate).toBe(false)
    const writeback = localTransformForWriteback(child); writeback.location.forEach((v, i) => near(v, [1, 2, 3][i])); near(writeback.scale[0], -1)
    const roundTrip = new THREE.Object3D(); applyTransform(roundTrip, item('copy', { location: writeback.location, rotation_euler: writeback.rotation_euler, scale: writeback.scale })); roundTrip.matrix.elements.forEach((value, i) => near(value, child.matrix.elements[i]))
    expect(() => linkSceneHierarchy(new Map([['parent', parent], ['child', child]]), [item('parent', { parent: 'child' }), item('child', { parent: 'parent' })], root)).toThrow('cycle')
  })

  test('identity glTF mesh bind works with a transformed mesh and a non-joint ancestor', () => {
    const root = new THREE.Group(); root.rotation.x = -Math.PI / 2
    const ancestor = new THREE.Group(), bone = new THREE.Bone()
    const data = payload('skin'); data.skinIndices = new Uint16Array(12); data.skinWeights = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
    const mesh = new THREE.SkinnedMesh(geometryFrom(data), new THREE.MeshStandardMaterial())
    const records = [item('ancestor', { type: 'EMPTY', location: [2, 0, 0], rotation_euler: [0.2, 0.3, 0.4] }), item('joint', { type: 'EMPTY', parent: 'ancestor', joint: true, location: [0, 1, 0] }), item('skin', { parent: 'ancestor', location: [3, 0, 0], skin: 'Rig' })]
    const objects = new Map<string, THREE.Object3D>([['ancestor', ancestor], ['joint', bone], ['skin', mesh]])
    records.forEach(source => applyTransform(objects.get(source.name)!, source)); linkSceneHierarchy(objects, records, root)
    const inverseRoot = root.matrixWorld.clone().invert(), docJoint = inverseRoot.clone().multiply(bone.matrixWorld), docMesh = inverseRoot.clone().multiply(mesh.matrixWorld), inverseBind = docJoint.clone().invert().multiply(docMesh)
    const document: SerializedScene = { objects: records, materials: [], skins: { Rig: { name: 'Rig', joints: ['joint'], inverseBindMatrices: inverseBind.toArray() } } }
    bindSceneSkins(objects, document); root.updateMatrixWorld(true); mesh.skeleton.update()
    const rest = mesh.applyBoneTransform(1, new THREE.Vector3(1, 0, 0)); near(rest.x, 1); near(rest.y, 0); near(rest.z, 0)
    bone.position.y += 1; root.updateMatrixWorld(true); mesh.skeleton.update()
    const posed = mesh.applyBoneTransform(1, new THREE.Vector3(1, 0, 0)); near(posed.x, 1); near(posed.y, 1); near(posed.z, 0)
  })
})

describe('native 3D PBR lights and animation', () => {
  test('PBR factors, sampler modes, UV channels and texture transforms are preserved per slot', () => {
    const material = new THREE.MeshStandardMaterial(); applyMaterial(material, { name: 'PBR', baseColor: [0.5, 0.2, 0.1, 0.4], alpha: 0.4, alphaMode: 'MASK', alphaCutoff: 0.3, metallic: 0.7, roughness: 0.25, doubleSided: true, emissiveColor: [0.1, 0.2, 0.3], emissiveStrength: 5 })
    near(material.color.r, 0.5); near(material.alphaTest, 0.3); expect(material.transparent).toBe(false); expect(material.side).toBe(THREE.DoubleSide); near(material.emissiveIntensity, 5)
    const base = new THREE.Texture(); configureTextureSampler(base, { name: 'Color', mimeType: 'image/png', dataBase64: 'fixture', sampler: { wrapS: 33071, wrapT: 33648, magFilter: 9728, minFilter: 9987 } })
    const color = textureForSlot(base, { texture: 'Color', transform: { offset: [0.2, 0.3], scale: [2, 3], rotation: 0.5, texCoord: 1 } }, true), data = textureForSlot(base, { texture: 'Color' }, false)
    expect(color.flipY).toBe(false); expect(color.channel).toBe(1); expect(color.wrapS).toBe(THREE.ClampToEdgeWrapping); expect(color.wrapT).toBe(THREE.MirroredRepeatWrapping); expect(color.magFilter).toBe(THREE.NearestFilter); expect(color.colorSpace).toBe(THREE.SRGBColorSpace); expect(data.colorSpace).toBe(THREE.NoColorSpace); expect(base.offset.x).toBe(0); near(color.offset.x, 0.2); near(color.repeat.y, 3)
  })

  test('document light controls create actual lights with helper geometry marked for exclusion', () => {
    for (const type of ['SUN', 'POINT', 'SPOT', 'AREA']) {
      const object = makeLightObject(item(type, { type: 'LIGHT', light: { type, energy: 20, color: [0.2, 0.4, 0.6] } }))
      const light = object.children.find(child => child instanceof THREE.Light) as THREE.Light
      expect(light).toBeDefined(); expect(light.intensity).toBeGreaterThan(0); near(light.color.g, 0.4)
      expect(object.children.some(child => child.userData.editorHelper)).toBe(true)
    }
  })

  test('linear quaternion, step, cubic spline and multiweight animation use real sampled values', () => {
    const rotation = sampleAnimationTrack({ object: 'joint', path: 'rotation', times: [0, 1], values: [0, 0, 0, 1, 0, 0, 1, 0], interpolation: 'LINEAR' }, 0.5, 4); near(rotation[2], Math.SQRT1_2); near(rotation[3], Math.SQRT1_2)
    expect(sampleAnimationTrack({ object: 'mesh', path: 'translation', times: [0, 1], values: [0, 0, 0, 2, 0, 0], interpolation: 'STEP' }, 0.5, 3)).toEqual([0, 0, 0])
    const cubic = { object: 'mesh', path: 'translation' as const, times: [0, 2], values: [0, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0], interpolation: 'CUBICSPLINE' as const }; near(sampleAnimationTrack(cubic, 1, 3)[0], 1)
    const morph = { object: 'mesh', path: 'weights' as const, times: [0, 1], values: [0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0], interpolation: 'CUBICSPLINE' as const }; expect(sampleAnimationTrack(morph, 0.5, 2)).toEqual([0.5, 0.5])
  })

  test('frame playhead applies native transforms, imported joint poses and morph weights', () => {
    const meshData = payload('mesh'); meshData.morphTargets = [{ positions: new Float32Array(9) }]
    const mesh = new THREE.Mesh(geometryFrom(meshData), new THREE.MeshStandardMaterial()), joint = new THREE.Bone(), objects = new Map<string, THREE.Object3D>([['mesh', mesh], ['joint', joint]])
    const document: SerializedScene = { objects: [item('mesh', { animation: { location: [{ frame: 1, value: [0, 0, 0] }, { frame: 11, value: [2, 0, 0] }] }, morphInfluences: [0] }), item('joint', { type: 'EMPTY', joint: true })], materials: [], scene: { frameStart: 1, fps: 10 }, clips: { Motion: { name: 'Motion', tracks: [{ object: 'joint', path: 'rotation', times: [0, 1], values: [0, 0, 0, 1, 0, 0, 1, 0], interpolation: 'LINEAR' }, { object: 'mesh', path: 'weights', times: [0, 1], values: [0, 1], interpolation: 'LINEAR' }] } } }
    applyAnimationFrame(objects, document, 6, 'Motion'); near(mesh.position.x, 1); near(joint.quaternion.z, Math.SQRT1_2); near(mesh.morphTargetInfluences![0], 0.5)
    applyAnimationFrame(objects, document, 1, 'Motion'); near(mesh.position.x, 0); near(mesh.morphTargetInfluences![0], 0); near(joint.quaternion.z, 0)
  })
})
