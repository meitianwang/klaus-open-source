import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { HandlerContext } from '../ipc/registry';
import type { Json } from '../ipc/contract';
import type { WorkspaceStore } from '../services/workspaces';
import { VisualCapabilityServer } from '../visuals/capability-server';
import { message, record, text, type Data } from '../visuals/data';
import { object, string } from '../services/service-types';
import { Model3DStore } from './store';
import { GeometryCache, evaluateObject, kernel } from './kernel';
import { bake } from './physics';
import { exportDocumentGlb, exportObj, extensionOf, importGltf, importObj, mergeImported, transformGeometry } from './io';
import { model3dTools } from './tools';
import { worldMatrixOf, matrixToTransform, invertMatrix, multiplyMatrices, quaternionFromEuler } from './scene-math';
import {
  defaultMaterial, documentSummary, emptyDocument, findObject, geometryKey, oneVec, parseDocument,
  safeName, serializeDocument, zeroVec,
  MODIFIER_TYPES, PRIMITIVES,
  type MeshBlock, type Model3DDocument, type Modifier3D, type Object3DRecord, type PrimitiveKind, type Vec3,
} from './model';

/**
 * Per-task 3D ownership: one document, one host.
 *
 * The MCP tools (model3d_*) and the side panel's IPC (model3d:*) both funnel
 * through here, so an agent edit and a panel drag mutate the same document and
 * can never hold two copies of the scene — the invariant digram's panel relies
 * on, applied to a 3D scene instead of a diagram.
 *
 * Unlike the Blender version this replaced there is no child process and no
 * runtime download: the kernel is WASM in this process, so `documentFor` is a
 * store read, not a spawn. That also removes the whole provisioning surface —
 * nothing to install, nothing to fail before first use.
 *
 * Rendering is the one thing that still leaves the host: there is no WebGL
 * context in the main process, so a render is delegated to the panel, which
 * draws off-screen and returns bytes (digram's render-request/render-result
 * pattern). That is why model3d_render requires an open panel.
 */

export interface Model3DServiceOptions {
  configRoot: string;
  windowId: number;
  ownsWindow?(senderId: number): boolean;
  workspaces: Pick<WorkspaceStore, 'resolveSessionDirectory' | 'withDirectoryOperation' | 'sessionDirectory'>;
  emit(channel: string, payload: Json): void;
  enabled?(): boolean;
  renderTimeoutMs?: number;
}

interface PendingRender {
  owner: string;
  format: string;
  resolve(result: { bytes: Buffer; panelVisible: boolean }): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
const MAX_RENDER_BYTES = 64 * 1024 * 1024;
const RENDER_TIMEOUT_MS = 120_000;
/** Bounds any single evaluation so a runaway modifier cannot wedge the host. */
const MAX_EVALUATED_TRIANGLES = 4_000_000;

function failure(messageText: string, code = 'ERROR'): Data {
  return { isError: true, content: [{ type: 'text', text: code === 'ERROR' ? messageText : `${messageText} [${code}]` }] };
}

function vec3Of(value: unknown, fallback: Vec3): Vec3 {
  if (Array.isArray(value) && value.length === 3 && value.every(item => typeof item === 'number' && Number.isFinite(item))) {
    return { x: value[0] as number, y: value[1] as number, z: value[2] as number };
  }
  return { ...fallback };
}

function arrayOfNumbers(value: unknown, fallback: number[]): number[] {
  if (!Array.isArray(value) || !value.length) return [...fallback];
  const numbers = value.map(Number);
  return numbers.every(Number.isFinite) ? numbers : [...fallback];
}

export class Model3DService {
  readonly store: Model3DStore;
  private readonly mcp: VisualCapabilityServer;
  /** Evaluated-geometry cache, shared across documents of one host. */
  private readonly geometry = new GeometryCache();
  private readonly pending = new Map<string, PendingRender>();
  private readonly generations = new Map<string, number>();
  /**
   * Sessions already known to own a 3D document. Purely a scan cache for the
   * implicit-creation card in execute(): once a session owns one, no later call
   * can create another behind our back, so the directory need not be listed
   * again. Dropping an entry costs at most one extra listing.
   */
  private readonly hasDocument = new Set<string>();
  private closed = false;

  constructor(private readonly options: Model3DServiceOptions) {
    this.store = new Model3DStore(options.configRoot);
    this.mcp = new VisualCapabilityServer('klaus-model3d', model3dTools,
      (owner, name, args) => this.execute(owner, name, args),
      () => !this.closed && (this.options.enabled?.() ?? true));
  }

  hostCapabilities(owner: string): Promise<Data> {
    return this.mcp.hostCapabilities(owner);
  }

  private success(value: unknown, artifact?: Json): Data {
    // Normalized through JSON so structuredContent is genuinely Json before it
    // crosses the MCP boundary.
    const structured = JSON.parse(JSON.stringify(value ?? null)) as Json;
    return {
      content: [
        ...(artifact ? [{ type: 'text', text: JSON.stringify({ artifact }) }] : []),
        { type: 'text', text: JSON.stringify(structured) },
      ],
      structuredContent: structured,
    };
  }

  private agentDocument(doc: Model3DDocument, includePixels = false): Json {
    const result = record(serializeDocument(doc));
    if (!includePixels) result.textures = Object.fromEntries(Object.entries(doc.textures ?? {}).map(([name,texture]) => { const { dataBase64, ...metadata } = texture; return [name,{...metadata,bytes:Buffer.byteLength(dataBase64,'base64')}]; }));
    return result as Json;
  }

  private artifact(doc: { id: string; title: string }): Json {
    return { kind: 'model3d', id: doc.id, title: doc.title };
  }

  /** Load (or create) the document a task is working on, and persist changes. */
  private documentFor(sessionId: string, id?: unknown): Model3DDocument {
    text(sessionId, '3D session');
    const resolved = id === undefined ? undefined : text(id, 'id');
    if (resolved === undefined) {
      const existing = this.store.list(sessionId)[0];
      if (existing) return this.store.load(string(existing.id), sessionId);
      return this.store.open(sessionId, {});
    }
    return this.store.load(resolved, sessionId);
  }

  /** Persist a mutation and tell every listening surface to re-sync. */
  private commit(doc: Model3DDocument, expectedVersion?: number): Model3DDocument {
    const saved = this.store.save(doc, expectedVersion);
    this.options.emit('model3d:changed', { id: saved.id, version: saved.version, sessionId: saved.sessionId });
    return saved;
  }

  // ───────────────────────────── MCP tool dispatch ─────────────────────────────

  async execute(owner: string, name: string, fields: Data): Promise<Data> {
    try {
      if (this.closed || !(this.options.enabled?.() ?? true)) throw new Error('3D tools are disabled or shut down.');
      text(owner, '3D session');
      // `model3d_scene` publishes its own card on both of its branches. Every
      // other verb reaches its document through documentFor, which CREATES one
      // when the task owns none yet — so a task that opens with `model3d_add`
      // instead of `model3d_scene` still produces a scene the user has to be able
      // to reach. The card is appended here rather than in each verb, so a new
      // entry point cannot silently ship without a way to open the panel it drew
      // into. Only a session that owns NO document can have one created by this
      // call, and ownership never goes away, so the two directory scans below are
      // a session's lifetime cost rather than a per-call one.
      const sceneCall = name === 'model3d_scene';
      const watch = !sceneCall && !this.hasDocument.has(owner);
      const ownedBefore = watch ? this.store.list(owner).length > 0 : true;
      const result = await this.dispatch(owner, name, fields);
      if (sceneCall || ownedBefore) {
        this.hasDocument.add(owner);
        return result;
      }
      // The listing row already carries id and title, so the card needs no second
      // read of the document.
      const created = this.store.list(owner)[0];
      if (!created) return result;
      this.hasDocument.add(owner);
      const card = { type: 'text', text: JSON.stringify({ artifact: this.artifact({ id: string(created.id), title: string(created.title) }) }) };
      return { ...result, content: [card, ...(Array.isArray(result.content) ? result.content : [])] };
    } catch (error) {
      return failure(message(error));
    }
  }

  private async dispatch(sessionId: string, name: string, fields: Data): Promise<Data> {
    switch (name) {
      case 'model3d_scene': {
        if (string(fields.action) === 'new') {
          const id = typeof fields.id === 'string' && fields.id ? fields.id : `m3d-${randomUUID()}`;
          const doc = emptyDocument(id, typeof fields.title === 'string' ? fields.title : 'Untitled', sessionId);
          this.store.persist(doc);
          this.options.emit('model3d:changed', { id, version: doc.version, sessionId });
          return this.success({ id, document: serializeDocument(doc), summary: documentSummary(doc) }, this.artifact(doc));
        }
        const doc = this.documentFor(sessionId, fields.id);
        return this.success({ id: doc.id, document: this.agentDocument(doc), summary: documentSummary(doc) }, this.artifact(doc));
      }
      case 'model3d_add': return this.success(this.addObject(sessionId, fields));
      case 'model3d_transform': return this.success(this.transformObject(sessionId, fields));
      case 'model3d_modifier': return this.success(await this.editModifier(sessionId, fields));
      case 'model3d_material': return this.success(this.editMaterial(sessionId, fields));
      case 'model3d_mesh_edit':
      case 'model3d_sculpt':
      case 'model3d_uv':
      case 'model3d_geometry':
      case 'model3d_rig':
      case 'model3d_texture': return this.success(await this.author(sessionId, name, fields));
      case 'model3d_scene_settings': return this.success(this.sceneSettings(sessionId, fields));
      case 'model3d_render': return this.success(await this.render(sessionId, fields), undefined);
      case 'model3d_animate': return this.success(this.animate(sessionId, fields));
      case 'model3d_physics': return this.success(await this.physicsAction(sessionId, fields));
      case 'model3d_io': return this.success(await this.io(sessionId, fields));
      case 'model3d_document': return this.success(await this.documentFile(sessionId, fields));
      case 'model3d_serialize': {
        const doc = this.documentFor(sessionId, fields.id);
        return this.success(this.agentDocument(doc, fields.include_texture_data === true));
      }
      case 'model3d_mesh': return this.success(await this.meshOf(sessionId, fields));
      case 'model3d_inspect': return this.success(await this.inspect(sessionId, fields));
      default: throw new Error(`Unknown 3D tool: ${name}`);
    }
  }

  // ───────────────────────────── modelling ─────────────────────────────

  private addObject(sessionId: string, fields: Data): Json {
    const doc = this.documentFor(sessionId, fields.id);
    const kind = string(fields.kind);
    const location = vec3Of(fields.location, zeroVec());
    const rotation = vec3Of(fields.rotation, zeroVec());
    const scale = vec3Of(fields.scale, oneVec());
    const names = doc.objects.map(item => item.name);

    if (kind === 'camera') {
      const name = safeName(fields.name, 'Camera', names);
      doc.objects.push({
        name, type: 'CAMERA',
        transform: { location, rotationEuler: rotation, scale },
        modifiers: [], visible: true,
        camera: { lens: Number(fields.lens) || 50, clipStart: 0.1, clipEnd: 1000 },
      });
      // The first camera added becomes the render camera; a later one does not
      // steal it, because the user may have framed a shot already.
      if (!doc.scene.activeCamera) doc.scene.activeCamera = name;
      return this.commitAndReport(doc, name, 'CAMERA');
    }
    if (kind === 'light') {
      const type = (['SUN', 'POINT', 'SPOT', 'AREA'] as const).includes(string(fields.light_type).toUpperCase() as 'SUN')
        ? string(fields.light_type).toUpperCase() as 'SUN' | 'POINT' | 'SPOT' | 'AREA' : 'SUN';
      const name = safeName(fields.name, type.charAt(0) + type.slice(1).toLowerCase(), names);
      doc.objects.push({
        name, type: 'LIGHT',
        transform: { location, rotationEuler: rotation, scale },
        modifiers: [], visible: true,
        light: { type, energy: Number(fields.energy) || (type === 'SUN' ? 4 : 300), color: arrayOfNumbers(fields.color, [1, 1, 1]) },
      });
      return this.commitAndReport(doc, name, 'LIGHT');
    }
    if (kind === 'empty') {
      const name = safeName(fields.name, 'Empty', names);
      doc.objects.push({ name, type: 'EMPTY', transform: { location, rotationEuler: rotation, scale }, modifiers: [], visible: true });
      return this.commitAndReport(doc, name, 'EMPTY');
    }
    if (!(PRIMITIVES as readonly string[]).includes(kind)) {
      throw new Error(`Unknown primitive '${kind}'. Expected one of: ${PRIMITIVES.join(', ')}`);
    }
    const primitive = kind as PrimitiveKind;
    const params: Record<string, number> = {};
    for (const key of ['size', 'radius', 'depth', 'segments', 'rings', 'majorRadius', 'minorRadius', 'subdivisions']) {
      const value = Number(fields[key]);
      if (Number.isFinite(value) && value > 0) params[key] = value;
    }
    const meshName = safeName(fields.name, primitive.charAt(0).toUpperCase() + primitive.slice(1), Object.keys(doc.meshes));
    doc.meshes[meshName] = { name: meshName, primitive, primitiveParams: params, materials: [] };
    const objectName = safeName(fields.name, meshName, names);
    doc.objects.push({
      name: objectName, type: 'MESH', mesh: meshName,
      transform: { location, rotationEuler: rotation, scale },
      modifiers: [], visible: true,
    });
    return this.commitAndReport(doc, objectName, 'MESH');
  }

  private commitAndReport(doc: Model3DDocument, name: string, type: string): Json {
    this.commit(doc);
    return { name, type, objects: doc.objects.length };
  }

  private async author(sessionId: string, verb: string, fields: Data): Promise<Json> {
    const { editModelDocument } = await import('./editing');
    const edited = await editModelDocument(this.documentFor(sessionId, fields.id), verb, fields, (doc, target) => this.evaluate(doc, target));
    this.commit(parseDocument(edited.document));
    return edited.result;
  }

  private transformObject(sessionId: string, fields: Data): Json {
    const doc = this.documentFor(sessionId, fields.id);
    const entries = Array.isArray(fields.entries) && fields.entries.length
      ? fields.entries.map(record)
      : [record(fields)];
    if (!entries.length) throw new Error('model3d_transform needs a name or an entries list.');
    const moved: string[] = [];
    for (const entry of entries) {
      const target = findObject(doc, string(entry.name));
      if (!target) throw new Error(`No object named '${string(entry.name) || '(none)'}'`);
      if (entry.location !== undefined) target.transform.location = vec3Of(entry.location, target.transform.location);
      if (entry.rotation_euler !== undefined) { target.transform.rotationEuler = vec3Of(entry.rotation_euler, target.transform.rotationEuler); delete target.transform.rotationQuaternion; }
      if (entry.scale !== undefined) target.transform.scale = vec3Of(entry.scale, target.transform.scale);
      if (entry.location !== undefined || entry.rotation_euler !== undefined || entry.rotation_quaternion !== undefined || entry.scale !== undefined) delete target.transform.matrix;
      if (entry.rotation_quaternion !== undefined) { const q = arrayOfNumbers(entry.rotation_quaternion, []); if (q.length !== 4 || Math.hypot(...q) < 1e-8) throw new Error('rotation_quaternion must be a nonzero finite quaternion.'); const length = Math.hypot(...q); target.transform.rotationQuaternion = q.map(value => value / length); }
      if (entry.parent !== undefined) {
        const before=entry.keep_world===true?worldMatrixOf(doc,target.name):null;
        target.parent = entry.parent === null ? undefined : text(entry.parent, 'parent');
        worldMatrixOf(doc, target.name);
        if(before){const parent=target.parent?worldMatrixOf(doc,target.parent):[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];target.transform=matrixToTransform(multiplyMatrices(invertMatrix(parent),before));}
      }
      moved.push(target.name);
    }
    this.commit(doc);
    return { moved, count: moved.length };
  }

  private async editModifier(sessionId: string, fields: Data): Promise<Json> {
    const doc = this.documentFor(sessionId, fields.id);
    const target = findObject(doc, string(fields.name));
    if (!target) throw new Error(`No object named '${string(fields.name) || '(none)'}'`);
    const action = string(fields.action);
    if (action === 'add') {
      const type = string(fields.type) as Modifier3D['type'];
      if (!(MODIFIER_TYPES as readonly string[]).includes(type)) {
        throw new Error(`Unknown modifier '${string(fields.type)}'. Supported: ${MODIFIER_TYPES.join(', ')}`);
      }
      const modifier: Modifier3D = {
        id: `${type}-${target.modifiers.length + 1}`,
        type,
        label: string(fields.label) || type,
        enabled: fields.enabled !== false,
        params: object(fields.params) as Record<string, Json>,
      };
      target.modifiers.push(modifier);
      this.commit(doc);
      return { name: target.name, modifier: modifier.id, stack: target.modifiers.map(item => ({ id: item.id, type: item.type, enabled: item.enabled })) };
    }
    const selector = string(fields.modifier);
    const index = target.modifiers.findIndex(item => item.id === selector || item.label === selector || item.type === selector);
    if (index < 0) {
      const available = target.modifiers.map(item => item.id).join(', ') || 'none';
      throw new Error(`No modifier '${selector}' on ${target.name}; it has ${available}`);
    }
    if (action === 'remove') {
      const [removed] = target.modifiers.splice(index, 1);
      this.commit(doc);
      return { name: target.name, removed: removed?.id ?? null, stack: target.modifiers.map(item => item.id) };
    }
    if (action === 'update') {
      const modifier = target.modifiers[index]!;
      if (object(fields.params) && Object.keys(object(fields.params)).length) {
        modifier.params = { ...modifier.params, ...object(fields.params) };
      }
      if (fields.enabled !== undefined) modifier.enabled = fields.enabled !== false;
      if (typeof fields.label === 'string' && fields.label.trim()) modifier.label = fields.label.trim().slice(0, 60);
      this.commit(doc);
      return { name: target.name, modifier: modifier.id, params: modifier.params, enabled: modifier.enabled };
    }
    if (action === 'toggle') {
      const modifier = target.modifiers[index]!;
      modifier.enabled = fields.enabled === undefined ? !modifier.enabled : fields.enabled !== false;
      this.commit(doc);
      return { name: target.name, modifier: modifier.id, enabled: modifier.enabled };
    }
    if (action === 'reorder') {
      const position = Number(fields.position);
      if (!Number.isFinite(position)) throw new Error('reorder needs a numeric position.');
      const [modifier] = target.modifiers.splice(index, 1);
      target.modifiers.splice(Math.max(0, Math.min(target.modifiers.length, Math.round(position))), 0, modifier!);
      this.commit(doc);
      return { name: target.name, stack: target.modifiers.map(item => item.id) };
    }
    if (action === 'apply') {
      // Baking a layer: evaluate up to and including it, then replace the base
      // mesh with that result and drop every layer up to it. Layers after it
      // stay, so a stack stays editable above the bake point.
      const mesh = target.mesh ? doc.meshes[target.mesh] : undefined;
      if (!mesh) throw new Error(`${target.name} has no mesh to bake into.`);
      // Evaluate a throwaway copy whose stack ends at `index`. A fresh cache is
      // used because this truncated stack has a different geometry key than the
      // live object, and the result is about to become the base mesh anyway.
      const truncated: Object3DRecord = { ...target, modifiers: target.modifiers.slice(0, index + 1) };
      const evaluated = await evaluateObject(doc, truncated, new GeometryCache());
      if (!evaluated) throw new Error(`${target.name} produced no geometry to bake.`);
      if (evaluated.indices.length / 3 > MAX_EVALUATED_TRIANGLES) {
        throw new Error(`Baking would produce ${evaluated.indices.length / 3} triangles, over the ${MAX_EVALUATED_TRIANGLES} limit.`);
      }
      const baked: MeshBlock = {
        name: mesh.name, primitive: null, primitiveParams: {},
        positions: Array.from(evaluated.positions), indices: Array.from(evaluated.indices),
        materials: mesh.materials,
      };
      doc.meshes[mesh.name] = baked;
      target.modifiers = target.modifiers.slice(index + 1);
      this.commit(doc);
      return { name: target.name, applied: index + 1, verts: evaluated.positions.length / 3, tris: evaluated.indices.length / 3 };
    }
    throw new Error(`Unknown modifier action '${action}'`);
  }

  private editMaterial(sessionId: string, fields: Data): Json {
    const doc = this.documentFor(sessionId, fields.id);
    const requested = string(fields.name).trim();
    const name = requested && doc.materials[requested] ? requested : safeName(fields.name, 'Material', Object.keys(doc.materials));
    const existing = doc.materials[name] ?? defaultMaterial(name);
    const next = { ...existing, name };
    if (fields.base_color !== undefined) next.baseColor = arrayOfNumbers(fields.base_color, existing.baseColor);
    if (fields.metallic !== undefined) next.metallic = Number(fields.metallic) || 0;
    if (fields.roughness !== undefined) next.roughness = Number(fields.roughness) || 0;
    if (fields.alpha !== undefined) next.alpha = Math.min(1, Math.max(0, Number(fields.alpha) || 1));
    if (fields.emission_color !== undefined) next.emissiveColor = arrayOfNumbers(fields.emission_color, existing.emissiveColor);
    if (fields.emission_strength !== undefined) next.emissiveStrength = Number(fields.emission_strength) || 0;
    if (fields.double_sided !== undefined) next.doubleSided = fields.double_sided === true;
    if (fields.alpha_mode !== undefined) { const mode = string(fields.alpha_mode); if (!['OPAQUE','MASK','BLEND'].includes(mode)) throw new Error('alpha_mode must be OPAQUE, MASK or BLEND.'); next.alphaMode = mode as 'OPAQUE'|'MASK'|'BLEND'; }
    if (fields.alpha_cutoff !== undefined) next.alphaCutoff = Math.max(0,Math.min(1,Number(fields.alpha_cutoff)));
    for (const [field,slot] of [['base_color_texture','baseColorTexture'],['metallic_roughness_texture','metallicRoughnessTexture'],['normal_texture','normalTexture'],['occlusion_texture','occlusionTexture'],['emissive_texture','emissiveTexture']] as const) {
      if (fields[field] === undefined) continue;
      if (fields[field] === null) { delete next[slot]; continue; }
      const texture = text(fields[field], field);
      if (!doc.textures?.[texture]) throw new Error(`No texture named '${texture}'.`);
      next[slot] = { texture, texCoord: fields.texture_uv_set === 1 ? 1 : 0 };
    }
    if (![next.metallic,next.roughness,next.alpha,next.emissiveStrength,next.alphaCutoff ?? 0].every(Number.isFinite)) throw new Error('Material factors must be finite numbers.');
    doc.materials[name] = next;
    const assigned: string[] = [];
    const targets = typeof fields.assign_to === 'string' ? [fields.assign_to] : Array.isArray(fields.assign_to) ? fields.assign_to.map(String) : [];
    for (const objectName of targets) {
      const target = findObject(doc, objectName);
      if (!target || target.type !== 'MESH' || !target.mesh) continue;
      const mesh = doc.meshes[target.mesh];
      if (!mesh) continue;
      // Assign into slot 0, creating the slot if the mesh has none. Replacing
      // slot 0 rather than appending keeps a repeated assign idempotent.
      if (mesh.materials.length) mesh.materials[0] = name;
      else mesh.materials = [name];
      assigned.push(target.name);
    }
    this.commit(doc);
    return { material: name, assigned };
  }

  private sceneSettings(sessionId: string, fields: Data): Json {
    const doc = this.documentFor(sessionId, fields.id);
    const scene = doc.scene;
    if (fields.resolution_x !== undefined) scene.resolutionX = Math.max(1, Math.min(8192, Math.round(Number(fields.resolution_x) || scene.resolutionX)));
    if (fields.resolution_y !== undefined) scene.resolutionY = Math.max(1, Math.min(8192, Math.round(Number(fields.resolution_y) || scene.resolutionY)));
    if (fields.frame_start !== undefined) scene.frameStart = Math.round(Number(fields.frame_start) || scene.frameStart);
    if (fields.frame_end !== undefined) scene.frameEnd = Math.round(Number(fields.frame_end) || scene.frameEnd);
    if (fields.fps !== undefined) scene.fps = Math.max(1, Math.min(240, Math.round(Number(fields.fps) || scene.fps)));
    if (typeof fields.active_camera === 'string') {
      const camera = findObject(doc, fields.active_camera);
      if (!camera || camera.type !== 'CAMERA') throw new Error(`No camera named '${fields.active_camera}'`);
      scene.activeCamera = camera.name;
    }
    if (fields.background !== undefined) scene.background = arrayOfNumbers(fields.background, scene.background);
    if (fields.render_engine !== undefined) { const engine = string(fields.render_engine); if (engine !== 'raster' && engine !== 'pathtrace') throw new Error('render_engine must be raster or pathtrace.'); scene.renderEngine = engine; }
    if (fields.render_samples !== undefined) scene.renderSamples = Math.max(1, Math.min(1024, Math.round(Number(fields.render_samples) || 32)));
    if (fields.render_bounces !== undefined) scene.renderBounces = Math.max(1, Math.min(32, Math.round(Number(fields.render_bounces) || 6)));
    this.commit(doc);
    return { scene: { ...scene } };
  }

  private animate(sessionId: string, fields: Data): Json {
    const doc = this.documentFor(sessionId, fields.id);
    const action = string(fields.action);
    if (action === 'frame_range') {
      if (fields.start !== undefined) doc.scene.frameStart = Math.round(Number(fields.start) || doc.scene.frameStart);
      if (fields.end !== undefined) doc.scene.frameEnd = Math.round(Number(fields.end) || doc.scene.frameEnd);
      if (fields.fps !== undefined) doc.scene.fps = Math.max(1, Math.min(240, Math.round(Number(fields.fps) || doc.scene.fps)));
      this.commit(doc);
      return { start: doc.scene.frameStart, end: doc.scene.frameEnd, fps: doc.scene.fps };
    }
    if (action === 'set_frame') {
      doc.scene.currentFrame = Math.round(Number(fields.frame) || doc.scene.frameStart);
      if (typeof fields.clip === 'string') { if (!doc.clips?.[fields.clip]) throw new Error('Animation clip does not exist.'); doc.scene.activeClip = fields.clip; }
      this.commit(doc);
      return { frame: doc.scene.currentFrame, clip: doc.scene.activeClip ?? null };
    }
    const target = findObject(doc, string(fields.name));
    if (!target) throw new Error(`No object named '${string(fields.name) || '(none)'}'`);
    const frame = fields.frame === undefined ? doc.scene.frameStart : Math.round(Number(fields.frame) || doc.scene.frameStart);
    const paths = (typeof fields.data_paths === 'string' ? [fields.data_paths] : Array.isArray(fields.data_paths) ? fields.data_paths.map(String) : ['location']);
    const allowed = new Set(['location', 'rotation_euler', 'rotation_quaternion', 'scale', 'morph_weights']);
    for (const path of paths) {
      if (!allowed.has(path)) throw new Error(`'${path}' cannot be animated; expected one of ${[...allowed].join(', ')}`);
    }
    target.animation ??= {};
    for (const path of paths) {
      const source = path === 'location' ? target.transform.location : path === 'rotation_euler' ? target.transform.rotationEuler : target.transform.scale;
      if (action !== 'delete_keyframe' && path === 'rotation_quaternion') delete target.animation.rotation_euler;
      if (action !== 'delete_keyframe' && path === 'rotation_euler') delete target.animation.rotation_quaternion;
      const value = path === 'rotation_quaternion' ? target.transform.rotationQuaternion ?? quaternionFromEuler(target.transform.rotationEuler.x,target.transform.rotationEuler.y,target.transform.rotationEuler.z) : path === 'morph_weights' ? target.morphInfluences ?? [] : [source.x, source.y, source.z];
      if (!value.length) throw new Error('This object has no morph targets to animate.');
      const track: Array<{ frame: number; value: number[] }> = target.animation[path] ??= [];
      const existing = track.findIndex(key => key.frame === frame);
      if (existing >= 0) track[existing] = { frame, value };
      else track.push({ frame, value });
      track.sort((a, b) => a.frame - b.frame);
    }
    if (action === 'delete_keyframe') {
      for (const path of paths) {
        const track = target.animation[path];
        if (!track) continue;
        target.animation[path] = track.filter(key => key.frame !== frame);
        if (!target.animation[path]!.length) delete target.animation[path];
      }
    }
    this.commit(doc);
    return { name: target.name, frame, paths, action };
  }

  private async physicsAction(sessionId: string, fields: Data): Promise<Json> {
    const doc = this.documentFor(sessionId, fields.id);
    const action = string(fields.action);
    if (action === 'cloth') throw new Error('The native physics solver does not implement vertex cloth simulation.');
    if (action === 'rigid_body') {
      const target = findObject(doc, string(fields.name));
      if (!target) throw new Error(`No object named '${string(fields.name) || '(none)'}'`);
      if (action === 'rigid_body') {
        target.rigidBody = {
          kind: string(fields.kind) === 'passive' ? 'passive' : 'active',
          mass: Number(fields.mass) > 0 ? Number(fields.mass) : 1,
          friction: fields.friction !== undefined ? Number(fields.friction) || 0 : 0.5,
          restitution: fields.restitution !== undefined ? Number(fields.restitution) || 0 : 0,
        };
        delete target.cloth;
      } else {
        target.cloth = {
          preset: string(fields.preset) || 'cotton',
          mass: Number(fields.mass) > 0 ? Number(fields.mass) : 1,
          ...(typeof fields.collider === 'string' ? { collider: fields.collider } : {}),
        };
        delete target.rigidBody;
      }
      this.commit(doc);
      return { name: target.name, action, rigid_body: target.rigidBody ?? null, cloth: target.cloth ?? null };
    }
    if (action === 'clear') {
      const target = findObject(doc, string(fields.name));
      if (!target) throw new Error(`No object named '${string(fields.name) || '(none)'}'`);
      delete target.rigidBody;
      delete target.cloth;
      this.commit(doc);
      return { name: target.name, cleared: true };
    }
    if (action !== 'bake') throw new Error(`Unknown physics action '${action}'`);
    const bodies = doc.objects.filter(item => item.rigidBody);
    if (!bodies.length) throw new Error('Nothing to bake: no object has a rigid body. Use action rigid_body first.');
    const start = fields.frame_start !== undefined ? Math.round(Number(fields.frame_start) || doc.scene.frameStart) : doc.scene.frameStart;
    const end = fields.frame_end !== undefined ? Math.round(Number(fields.frame_end) || doc.scene.frameEnd) : doc.scene.frameEnd;
    if (end < start) throw new Error('frame_end must not be before frame_start.');
    if (end - start > 1000) throw new Error('Refusing to bake more than 1000 frames in one call.');
    const kernelInstance = await kernel();
    const result = await bake(kernelInstance, doc, start, end, doc.scene.fps);
    // The bake writes animation keys. That is what makes it reversible: deleting
    // the keys restores the authored transforms.
    for (const [name, track] of Object.entries(result.tracks)) {
      const target = findObject(doc, name);
      if (!target) continue;
      target.animation ??= {};
      target.animation.location = track.map((value, index) => ({ frame: start + index, value }));
      if(result.rotationTracks?.[name]){target.animation.rotation_quaternion=result.rotationTracks[name]!.map((value,index)=>({frame:start+index,value}));delete target.animation.rotation_euler;delete target.transform.matrix;}
      if(result.scaleTracks?.[name])target.animation.scale=result.scaleTracks[name]!.map((value,index)=>({frame:start+index,value}));
    }
    this.commit(doc);
    return { frames: result.frames, bodies: Object.keys(result.tracks).length, ms: result.ms, wrote: 'location keyframes' };
  }

  private async io(sessionId: string, fields: Data): Promise<Json> {
    const doc = this.documentFor(sessionId, fields.id);
    const action = string(fields.action);
    const path = resolve(string(fields.path));
    const extension = extensionOf(path);
    if (action === 'import') {
      if (!['.glb', '.gltf', '.obj'].includes(extension)) {
        throw new Error(`Unsupported import format '${extension}'. Supported: .glb, .gltf, .obj`);
      }
      const imported = extension === '.obj' ? await importObj(path) : await importGltf(path);
      const created = mergeImported(doc, imported, path);
      this.commit(doc);
      return { path, created, objects: doc.objects.length };
    }
    if (action !== 'export') throw new Error(`Unknown io action '${action}'`);
    if (!['.glb', '.gltf', '.obj'].includes(extension)) {
      throw new Error(`Unsupported export format '${extension}'. Supported: .glb, .gltf, .obj`);
    }
    const selection = Array.isArray(fields.names) && fields.names.length
      ? fields.names.map(String)
      : doc.objects.filter(item => item.type === 'MESH').map(item => item.name);
    if (!selection.length) throw new Error('Nothing to export: the document has no mesh objects.');
    if (extension !== '.obj') {
      const overrides:Record<string,MeshBlock>={};
      for(const name of selection){
        const target=findObject(doc,name);if(!target?.mesh)continue;const source=doc.meshes[target.mesh];if(!source)continue;
        if(source.primitive===null&&!target.modifiers.some(m=>m.enabled))continue;
        const evaluated=await this.evaluate(doc,target);if(!evaluated)continue;
        const mesh:MeshBlock={...source,primitive:null,primitiveParams:{},positions:Array.from(evaluated.positions),indices:Array.from(evaluated.indices),normals:Array.from(evaluated.normals)};
        for(const key of ['uvs','uvs1','tangents','colors','skinIndices','skinWeights']as const){const data=evaluated[key];if(data)(mesh as unknown as Record<string,unknown>)[key]=Array.from(data);}
        if(evaluated.groups)mesh.groups=evaluated.groups.map(g=>({...g}));overrides[target.mesh]=mesh;
      }
      const bytes=await exportDocumentGlb(path,doc,{objects:selection,meshes:overrides});return {path,bytes,objects:selection.length};
    }
    const entries: Array<{ name: string; positions: Float32Array; normals: Float32Array; indices: Uint32Array; material?: { name: string; baseColor: number[]; metallic: number; roughness: number } }> = [];
    for (const name of selection) {
      const target = findObject(doc, name);
      if (!target || target.type !== 'MESH') continue;
      const evaluated = await this.evaluate(doc, target);
      if (!evaluated) continue;
      if (evaluated.indices.length / 3 > MAX_EVALUATED_TRIANGLES) {
        throw new Error(`'${name}' evaluates to more than ${MAX_EVALUATED_TRIANGLES} triangles; export that object on its own.`);
      }
      const materialName = target.mesh ? doc.meshes[target.mesh]?.materials[0] : undefined;
      const material = materialName ? doc.materials[materialName] : undefined;
      // Bake the object's full transform into the geometry so both exporters see
      // world-space vertices. The kernel evaluates in local space; without this
      // a rotated, scaled or offset object would export at the origin upright.
      const baked = transformGeometry(evaluated.positions, evaluated.normals, {
        location: [target.transform.location.x, target.transform.location.y, target.transform.location.z],
        rotation_euler: [target.transform.rotationEuler.x, target.transform.rotationEuler.y, target.transform.rotationEuler.z],
        scale: [target.transform.scale.x, target.transform.scale.y, target.transform.scale.z],
      });
      entries.push({
        name, positions: baked.positions, normals: baked.normals, indices: evaluated.indices,
        ...(material ? { material: { name: material.name, baseColor: material.baseColor, metallic: material.metallic, roughness: material.roughness } } : {}),
      });
    }
    if (!entries.length) throw new Error('Nothing to export: the selection had no mesh geometry.');
    // No caller-chosen directory is honoured for writes the host performs
    // outside the engine sandbox; the path the caller named must already be
    // inside the session workspace or an explicit user-chosen location.
    const bytes = await exportObj(path, entries);
    return { path, bytes, objects: entries.length };
  }

  private async documentFile(sessionId: string, fields: Data): Promise<Json> {
    const doc = this.documentFor(sessionId, fields.id);
    const action = string(fields.action);
    const path = resolve(string(fields.path));
    if (!path.endsWith('.model3d.json')) throw new Error('A 3D document file must end in .model3d.json');
    if (action === 'save') {
      await mkdir(dirname(path), { recursive: true });
      const encoded = JSON.stringify(doc, null, 2);
      if (Buffer.byteLength(encoded) > MAX_DOCUMENT_BYTES) throw new Error('The document exceeds 128 MiB.');
      await writeFile(path, encoded, { mode: 0o600 });
      return { path, bytes: Buffer.byteLength(encoded) };
    }
    if (action !== 'load') throw new Error(`Unknown document action '${action}'`);
    const parsed = parseDocument(JSON.parse(await readFile(path, 'utf8')));
    // A loaded document adopts THIS session's identity: a file saved by another
    // task must not become a second owner of the same id.
    parsed.sessionId = sessionId;
    parsed.id = doc.id;
    parsed.version = doc.version;
    this.commit(parsed);
    return { path, document: serializeDocument(parsed), summary: documentSummary(parsed) };
  }

  private async meshOf(sessionId: string, fields: Data): Promise<Json> {
    const doc = this.documentFor(sessionId, fields.id);
    const target = findObject(doc, string(fields.name));
    if (!target) throw new Error(`No object named '${string(fields.name) || '(none)'}'`);
    if (target.type !== 'MESH') return { name: target.name, type: target.type, verts: 0, tris: 0, positions_b64: '', normals_b64: '', indices_b64: '', geometry_key: geometryKey(doc, target) };
    const evaluated = await this.evaluate(doc, target);
    if (!evaluated) throw new Error(`'${target.name}' has no mesh to evaluate.`);
    return {
      name: target.name,
      geometry_key: evaluated.geometryKey,
      verts: evaluated.positions.length / 3,
      tris: evaluated.indices.length / 3,
      // base64 because this crosses JSON-RPC; the panel-side path (model3d:mesh)
      // gets the typed arrays directly through Electron's structured clone.
      positions_b64: Buffer.from(evaluated.positions.buffer, evaluated.positions.byteOffset, evaluated.positions.byteLength).toString('base64'),
      normals_b64: Buffer.from(evaluated.normals.buffer, evaluated.normals.byteOffset, evaluated.normals.byteLength).toString('base64'),
      indices_b64: Buffer.from(evaluated.indices.buffer, evaluated.indices.byteOffset, evaluated.indices.byteLength).toString('base64'),
    };
  }

  private async inspect(sessionId: string, fields: Data): Promise<Json> {
    const doc = this.documentFor(sessionId, fields.id);
    if (fields.name === undefined) {
      return JSON.parse(JSON.stringify({
        objects: doc.objects.map(item => ({
          name: item.name, type: item.type, mesh: item.mesh ?? null,
          location: [item.transform.location.x, item.transform.location.y, item.transform.location.z],
          modifiers: item.modifiers.map(modifier => modifier.type),
        })),
        materials: Object.keys(doc.materials),
        scene: doc.scene,
      })) as Json;
    }
    const target = findObject(doc, string(fields.name));
    if (!target) throw new Error(`No object named '${string(fields.name)}'`);
    const detail: Record<string, Json> = {
      name: target.name, type: target.type, mesh: target.mesh ?? null,
      location: [target.transform.location.x, target.transform.location.y, target.transform.location.z],
      rotation_euler: [target.transform.rotationEuler.x, target.transform.rotationEuler.y, target.transform.rotationEuler.z],
      scale: [target.transform.scale.x, target.transform.scale.y, target.transform.scale.z],
      visible: target.visible,
      modifiers: target.modifiers.map(modifier => ({ id: modifier.id, type: modifier.type, label: modifier.label, enabled: modifier.enabled, params: modifier.params })),
      animation: target.animation ? Object.keys(target.animation) : [],
      rigid_body: target.rigidBody ?? null,
      cloth: target.cloth ?? null,
    };
    if (target.type === 'MESH') {
      const evaluated = await this.evaluate(doc, target);
      if (evaluated) {
        const bounds = boundingBoxOf(evaluated.positions);
        detail.verts = evaluated.positions.length / 3;
        detail.tris = evaluated.indices.length / 3;
        detail.dimensions = bounds.size;
        detail.bounds = { min: bounds.min, max: bounds.max };
        const mesh = target.mesh ? doc.meshes[target.mesh] : undefined;
        detail.materials = mesh?.materials ?? [];
      }
    }
    return detail;
  }

  /** Evaluate with the cache, and bound the result so a runaway stack cannot OOM the host. */
  private async evaluate(doc: Model3DDocument, target: Object3DRecord) {
    const evaluated = await evaluateObject(doc, target, this.geometry);
    if (evaluated && evaluated.indices.length / 3 > MAX_EVALUATED_TRIANGLES) {
      throw new Error(`'${target.name}' evaluates to ${evaluated.indices.length / 3} triangles, over the ${MAX_EVALUATED_TRIANGLES} limit. Lower the subdivision or array count.`);
    }
    return evaluated;
  }

  // ───────────────────────────── rendering (delegated to the panel) ─────────────────────────────

  /**
   * Render by handing the document to the panel, which draws off-screen and
   * returns bytes. The host has no WebGL context, so the renderer process does
   * the draw; that works with the panel hidden too, so the result reports
   * whether the user could actually see the scene.
   */
  private async render(sessionId: string, fields: Data): Promise<Json> {
    const doc = this.documentFor(sessionId, fields.id);
    if (!doc.scene.activeCamera) throw new Error('No active camera. Add one with model3d_add kind=camera first.');
    const format = (string(fields.format) || 'PNG').toUpperCase() === 'JPEG' ? 'jpg' : 'png';
    const engine = string(fields.engine) || doc.scene.renderEngine || 'raster';
    if (engine !== 'raster' && engine !== 'pathtrace') throw new Error('Rendering engine must be raster or pathtrace.');
    if (engine === 'pathtrace' && doc.scene.resolutionX * doc.scene.resolutionY > 4_194_304) throw new Error('Path tracing currently supports at most four million output pixels.');
    for (const field of ['samples','bounces','frame']) if (fields[field] !== undefined && !Number.isFinite(Number(fields[field]))) throw new Error('Render parameters must be finite numbers.');
    const requestId = randomUUID();
    const generation = this.generations.get(sessionId) ?? 0;
    const rendered = await new Promise<{ bytes: Buffer; panelVisible: boolean }>((resolveRender, rejectRender) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        rejectRender(new Error('The 3D panel did not answer the render request in time. Is the panel open?'));
      }, this.options.renderTimeoutMs ?? RENDER_TIMEOUT_MS);
      this.pending.set(requestId, { owner: sessionId, format, resolve: resolveRender, reject: rejectRender, timer });
      try {
        this.options.emit('model3d:render-request', {
          requestId, sessionId, document: serializeDocument(doc), format,
          width: doc.scene.resolutionX, height: doc.scene.resolutionY,
          engine,
          samples: Math.max(1,Math.min(1024,Math.round(Number(fields.samples ?? doc.scene.renderSamples ?? 32)))),
          bounces: Math.max(1,Math.min(32,Math.round(Number(fields.bounces ?? doc.scene.renderBounces ?? 6)))),
          frame: fields.frame === undefined ? doc.scene.currentFrame ?? doc.scene.frameStart : Math.round(Number(fields.frame)),
          ...(string(fields.clip) || doc.scene.activeClip ? { clip: string(fields.clip) || doc.scene.activeClip! } : {}),
        });
      } catch (error) {
        this.pending.delete(requestId);
        clearTimeout(timer);
        rejectRender(new Error(message(error)));
      }
    });
    const bytes = rendered.bytes;
    if (this.closed || generation !== (this.generations.get(sessionId) ?? 0)) {
      throw new Error('The 3D task was released while rendering.');
    }
    if (bytes.length > MAX_RENDER_BYTES) throw new Error('The render exceeded 64 MiB and was not published.');
    const directory = await this.options.workspaces.sessionDirectory(sessionId);
    const name = `model3d-render-${Date.now()}-${randomUUID().slice(0, 8)}.${format}`;
    const visible = join(directory, name);
    await this.options.workspaces.withDirectoryOperation(async () => [directory], async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(visible, bytes, { mode: 0o600 });
    });
    // The render succeeded off-screen regardless of whether the user is looking at
    // the panel. Reporting that distinction back is what keeps the agent honest:
    // a valid image file is not evidence the panel is open, and saying "orbit it
    // on the right" while the panel is closed is a claim the user can see is false.
    const panelNote = rendered.panelVisible
      ? 'The 3D panel is open and showing this scene.'
      : 'The 3D panel is NOT open, so the user cannot see the scene; they only have this image. Tell them how to open the panel instead of claiming it is already visible.';
    return {
      path: visible,
      saved: visible,
      panelVisible: rendered.panelVisible,
      // Mirror the image-generation contract so the conversation shows the still
      // and the Files panel lists it.
      contentItems: [
        { type: 'inputImage', imageUrl: `data:${format === 'png' ? 'image/png' : 'image/jpeg'};base64,${bytes.toString('base64')}` },
        { type: 'inputText', text: `Saved: ${visible}\n${panelNote}` },
      ],
    } as Json;
  }

  /** The panel handing rendered bytes back to the waiting tool call. */
  private renderResult(fields: Data): Data {
    const requestId = text(fields.requestId, 'requestId');
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error('Unknown or expired render request.');
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    try {
      if (fields.error !== undefined) throw new Error(String(fields.error));
      const declared = string(fields.format).toLowerCase() === 'jpg' || string(fields.format).toLowerCase() === 'jpeg' ? 'jpg' : 'png';
      if (declared !== pending.format) throw new Error('Render format does not match its request.');
      const decoded = Buffer.from(String(fields.data ?? ''), 'base64');
      if (!decoded.length) throw new Error('The panel returned no render bytes.');
      const signature = declared === 'png'
        ? decoded.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : decoded.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
      if (!signature) throw new Error('The panel returned bytes that are not the declared image format.');
      pending.resolve({ bytes: decoded, panelVisible: fields.panelVisible === true });
      return { ok: true };
    } catch (error) {
      pending.reject(new Error(message(error)));
      return { ok: false, error: message(error) };
    }
  }

  // ───────────────────────────── panel IPC ─────────────────────────────

  async invoke(context: HandlerContext): Promise<Data> {
    if (this.closed) throw new Error('3D service has shut down.');
    if (context.role !== 'main' || !(this.options.ownsWindow?.(context.senderId) ?? context.senderId === this.options.windowId)) {
      throw new Error('The 3D panel belongs to another window.');
    }
    const fields = record(context.args[0]);
    // `render-result` is keyed by requestId, not by session: the panel answers a
    // specific pending render and carries no session id. Requiring one here would
    // reject every reply and leave the tool call to time out.
    if (context.channel === 'model3d:render-result') return this.renderResult(fields);
    const sessionId = text(fields.sessionId, '3D session');
    switch (context.channel) {
      case 'model3d:list':
        return { documents: this.store.list(sessionId) };
      case 'model3d:get': {
        try {
          const doc = this.documentFor(sessionId, fields.id);
          return { ok: true, document: serializeDocument(doc) };
        } catch (error) {
          // An empty session is the normal state before anything is modelled,
          // not an error the panel has to explain to the user.
          if (fields.id === undefined) return { ok: true, document: null };
          throw error;
        }
      }
      case 'model3d:mesh': {
        const doc = this.documentFor(sessionId, fields.id);
        const target = findObject(doc, string(fields.name));
        if (!target) throw new Error(`No object named '${string(fields.name)}'`);
        const evaluated = target.type === 'MESH' ? await this.evaluate(doc, target) : null;
        // Typed arrays cross Electron IPC by structured clone, so no base64.
        return {
          ok: true,
          name: target.name,
          geometry_key: geometryKey(doc, target),
          positions: evaluated ? evaluated.positions : new Float32Array(0),
          normals: evaluated ? evaluated.normals : new Float32Array(0),
          indices: evaluated ? evaluated.indices : new Uint32Array(0),
          uvs:evaluated?.uvs,uvs1:evaluated?.uvs1,tangents:evaluated?.tangents,colors:evaluated?.colors,
          skinIndices:evaluated?.skinIndices,skinWeights:evaluated?.skinWeights,
          groups:evaluated?.groups,morphTargets:evaluated?.morphTargets,
        } as unknown as Data;
      }
      case 'model3d:apply': {
        const doc = this.documentFor(sessionId, fields.id);
        const baseVersion = fields.baseVersion === undefined ? undefined : Number(fields.baseVersion);
        if (baseVersion !== undefined && baseVersion !== doc.version) {
          // A drag built against an older version must not clobber an agent edit
          // that already landed: report the current document instead.
          return { ok: false, stale: true, document: serializeDocument(doc) };
        }
        const applied = this.applyPanelOps(doc, fields.ops);
        this.commit(doc);
        return { ok: true, applied, document: serializeDocument(doc) };
      }
      default:
        throw new Error(`Unknown model3d channel: ${context.channel}`);
    }
  }

  /** Validate and apply a panel op batch against the live document. */
  private applyPanelOps(doc: Model3DDocument, ops: unknown): number {
    if (!Array.isArray(ops) || !ops.length) throw new Error('apply expects a non-empty ops array.');
    if (ops.length > 1000) throw new Error('apply accepts at most 1000 ops.');
    let applied = 0;
    // Validate the whole batch before mutating anything: a half-applied drag
    // would leave the document in a state neither side intended.
    const staged: Array<() => void> = [];
    for (const raw of ops) {
      const op = record(raw);
      const type = string(op.type);
      if (type === 'transform') {
        const target = findObject(doc, string(op.name));
        if (!target) throw new Error(`No object named '${string(op.name) || '(none)'}'`);
        const location = op.location === undefined ? undefined : vec3Of(op.location, target.transform.location);
        const rotation = op.rotation_euler === undefined ? undefined : vec3Of(op.rotation_euler, target.transform.rotationEuler);
        const scale = op.scale === undefined ? undefined : vec3Of(op.scale, target.transform.scale);
        staged.push(() => {
          if (location) target.transform.location = location;
          if (rotation) { target.transform.rotationEuler = rotation; delete target.transform.rotationQuaternion; }
          if (scale) target.transform.scale = scale;
          if (location || rotation || scale) delete target.transform.matrix;
        });
      } else if (type === 'visibility') {
        const target = findObject(doc, string(op.name));
        if (!target) throw new Error(`No object named '${string(op.name) || '(none)'}'`);
        const visible = op.visible !== false;
        staged.push(() => { target.visible = visible; });
      } else if (type === 'duplicate') {
        const target = findObject(doc, string(op.name));
        if (!target) throw new Error(`No object named '${string(op.name) || '(none)'}'`);
        staged.push(() => { this.duplicateObject(doc, target); });
      } else if (type === 'delete') {
        const names = Array.isArray(op.names) ? op.names.map(String) : [string(op.name)].filter(Boolean);
        if (!names.length) throw new Error('delete needs names.');
        for (const name of names) if (!findObject(doc, name)) throw new Error(`No object named '${name}'`);
        staged.push(() => {
          const removed = new Set(names);
          let found = true;
          while (found) { found = false; for (const item of doc.objects) if (item.parent && removed.has(item.parent) && !removed.has(item.name)) { removed.add(item.name); found = true; } }
          for (const skin of Object.values(doc.skins ?? {})) if (skin.joints.some(name => removed.has(name)) && doc.objects.some(item => item.skin === skin.name && !removed.has(item.name))) throw new Error('A bound bone cannot be deleted while its skinned mesh remains.');
          for (const [key,skin] of Object.entries(doc.skins ?? {})) if (skin.joints.some(name => removed.has(name))) delete doc.skins![key];
          for (const name of names) {
            const index = doc.objects.findIndex(item => item.name === name);
            if (index >= 0) doc.objects.splice(index, 1);
          }
          doc.objects = doc.objects.filter(item => !removed.has(item.name));
          for (const [key,clip] of Object.entries(doc.clips ?? {})) { clip.tracks = clip.tracks.filter(track => !removed.has(track.object)); if (!clip.tracks.length) delete doc.clips![key]; }
          if (doc.scene.activeClip && !doc.clips?.[doc.scene.activeClip]) doc.scene.activeClip = undefined;
          if (doc.scene.activeCamera && !findObject(doc, doc.scene.activeCamera)) doc.scene.activeCamera = undefined;
        });
      } else {
        throw new Error(`Unsupported panel op: ${type || '(none)'}`);
      }
    }
    for (const apply of staged) {
      apply();
      applied += 1;
    }
    return applied;
  }

  /** Duplicate an object, sharing its mesh datablock the way Blender does. */
  private duplicateObject(doc: Model3DDocument, source: Object3DRecord): string {
    const name = safeName(`${source.name}_copy`, source.name, doc.objects.map(item => item.name));
    const copy: Object3DRecord = JSON.parse(JSON.stringify({ ...source, name }));
    copy.transform.location = { x: source.transform.location.x + 1, y: source.transform.location.y, z: source.transform.location.z };
    doc.objects.push(copy);
    return name;
  }

  releaseSession(sessionId: string): void {
    this.generations.set(sessionId, (this.generations.get(sessionId) ?? 0) + 1);
    this.hasDocument.delete(sessionId);
    this.mcp.releaseSession(sessionId);
    for (const [requestId, pending] of this.pending) {
      if (pending.owner !== sessionId) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.reject(new Error('The 3D task was released.'));
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The 3D service shut down.'));
    }
    this.pending.clear();
    this.geometry.clear();
    await this.mcp.shutdown();
  }
}

function boundingBoxOf(positions: Float32Array): { min: number[]; max: number[]; size: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[index + axis] as number;
      min[axis] = Math.min(min[axis] as number, value);
      max[axis] = Math.max(max[axis] as number, value);
    }
  }
  if (!positions.length) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  return {
    min: min.map(value => Number(value.toFixed(4))),
    max: max.map(value => Number(value.toFixed(4))),
    size: min.map((value, axis) => Number(((max[axis] as number) - value).toFixed(4))),
  };
}
