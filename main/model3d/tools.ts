import type { Data } from '../visuals/data';
import { MODIFIER_TYPES, PRIMITIVES } from './model';

/**
 * The agent-facing 3D tool surface.
 *
 * Shaped like the digram tools: a few verbs with strict schemas, because the
 * model composes them with no viewport to look at. Unlike the Blender version
 * this replaces, there is NO `eval` escape hatch — there is no external process
 * here to run arbitrary code in, and inventing one would be a security downgrade
 * for no capability gain. Anything the tools cannot express is simply not
 * offered, and the skill says so plainly instead of the model guessing.
 *
 * Annotations are explicit on every tool. The engine treats an MCP tool as
 * non-read-only unless declared otherwise, so nothing is auto-approved by
 * omission; declaring the split is what keeps the panel's refresh path (a read
 * per frame) usable while every mutation still reaches the approval gate.
 */

export function model3dTools(): Data[] {
  const string = { type: 'string' };
  const number = { type: 'number' };
  const boolean = { type: 'boolean' };
  const vec3 = { type: 'array', items: number, minItems: 3, maxItems: 3, description: 'Three numbers [x, y, z]. Units are metres; Z is up, matching the document model.' };
  const objectName = { ...string, description: 'Object name exactly as an earlier tool returned it. Names are de-duplicated (Cube, Cube.001), so always use the returned value.' };
  const id = { ...string, description: 'Document id. Omit for the document this task is already working on.' };
  const readOnly = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false };
  const mutating = { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false };
  const spec = (name: string, description: string, properties: Data, annotations: Data, required: string[] = []): Data => ({
    name, description,
    inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
    annotations,
  });

  return [
    spec('model3d_scene', 'Create or read a 3D scene. Returns the document id, an object summary and the panel artifact, so one call at the start of a modelling task gives both the agent and the side panel the same document.',
      { id, action: { ...string, enum: ['new', 'summary'], description: "'new' resets to an empty document; 'summary' reads the current one. Default 'summary'." }, title: string }, mutating),
    spec('model3d_add', 'Add an object: a primitive mesh, a camera, a light or an empty. Returns the real object name, which later tools need.',
      {
        id, kind: { ...string, enum: [...PRIMITIVES, 'camera', 'light', 'empty'], description: 'What to add.' },
        name: string, location: vec3, rotation: vec3, scale: vec3,
        size: number, radius: number, depth: number, segments: number, rings: number,
        majorRadius: number, minorRadius: number, subdivisions: number,
        light_type: { ...string, enum: ['SUN', 'POINT', 'SPOT', 'AREA'], description: 'When kind is light.' },
        energy: number, color: { type: 'array', items: number, minItems: 3, maxItems: 4 },
        lens: { ...number, description: 'Camera focal length in mm.' },
      }, mutating, ['kind']),
    spec('model3d_transform', 'Set an object\'s location, rotation or scale absolutely. Also the write-back path for a panel drag.',
      { id, name: objectName, location: vec3, rotation_euler: vec3, scale: vec3,
        rotation_quaternion: {type:'array',items:number,minItems:4,maxItems:4},parent:{type:['string','null']},keep_world:boolean,
        entries: { type: 'array', items: { type: 'object', properties: { name: objectName, location: vec3, rotation_euler: vec3, scale: vec3,rotation_quaternion:{type:'array',items:number,minItems:4,maxItems:4},parent:{type:['string','null']},keep_world:boolean } }, description: 'Batch transform for several objects at once.' } },
      mutating),
    spec('model3d_modifier', 'Add, re-tune, reorder, enable/disable, remove or apply a NON-DESTRUCTIVE modifier layer. Supported: ' + MODIFIER_TYPES.join(', ') + '. Nothing here is baked until you apply, so any layer can be changed or removed later.',
      {
        id, name: objectName,
        action: { ...string, enum: ['add', 'update', 'remove', 'apply', 'reorder', 'toggle'], description: 'What to do.' },
        type: { ...string, enum: [...MODIFIER_TYPES], description: 'Modifier type, for action add.' },
        modifier: { ...string, description: 'Modifier id or label, for update/remove/apply/toggle.' },
        label: string, params: { type: 'object', description: "Modifier parameters. Examples: {iterations: 2} for subdivide, {operation: 'subtract', object: 'Sphere'} for boolean, {count: 3, offsetX: 2} for array, {axis: 'x'} for mirror, {thickness: 0.1} for solidify." },
        enabled: boolean, position: { ...number, description: 'New stack index, for reorder.' },
      }, mutating, ['action', 'name']),
    spec('model3d_material', 'Create or update a material and optionally assign it to objects. Materials are shared datablocks: one record referenced by many objects, so editing one updates every object using it.',
      { id, name: { ...string, description: 'Material name.' },
        base_color: { type: 'array', items: number, minItems: 3, maxItems: 4, description: 'Linear RGBA 0-1.' },
        metallic: number, roughness: number, alpha: number,
        emission_color: { type: 'array', items: number, minItems: 3, maxItems: 3 }, emission_strength: number,
        base_color_texture:{type:['string','null']},metallic_roughness_texture:{type:['string','null']},normal_texture:{type:['string','null']},occlusion_texture:{type:['string','null']},emissive_texture:{type:['string','null']},texture_uv_set:{type:'integer',enum:[0,1]},double_sided:boolean,alpha_mode:{...string,enum:['OPAQUE','MASK','BLEND']},alpha_cutoff:number,
        assign_to: { type: 'array', items: string, description: 'Objects to assign this material to (slot 0).' } },
      mutating, ['name']),
    spec('model3d_scene_settings', 'Set the render resolution, frame range, fps, background colour and active camera.',
      { id, resolution_x: number, resolution_y: number,render_engine:{...string,enum:['raster','pathtrace']},render_samples:number,render_bounces:number,
        frame_start: number, frame_end: number, fps: number, active_camera: string, background: { type: 'array', items: number, minItems: 3, maxItems: 4 } },
      mutating),
    spec('model3d_render', 'Render the active camera to an image in the task workspace. Raster is immediate; local path tracing progressively samples PBR light transport. Requires the desktop renderer and a camera; no external application or generation service.',
      { id, format: { ...string, enum: ['PNG', 'JPEG'], description: 'Default PNG.' },engine:{...string,enum:['raster','pathtrace']},samples:number,bounces:number,frame:number,clip:string },
      mutating),
    spec('model3d_animate', 'Set or delete keyframes on an object property, move the playhead, or set the frame range. Keyframes land on the current frame unless a frame is given.',
      { id, name: objectName, action: { ...string, enum: ['keyframe', 'delete_keyframe', 'set_frame', 'frame_range'], description: 'What to do.' },
        data_paths: { type: 'array', items: string, description: "Animated properties: location, rotation_euler, rotation_quaternion, scale or morph_weights." },
        frame: number, start: number, end: number, fps: number },
      mutating, ['action']),
    spec('model3d_physics', 'Mark rigid bodies and bake their world-space simulation into local position, quaternion and scale animation keys. Passive bodies are static colliders; active bodies simulate. Vertex cloth is not implemented.',
      { id, name: objectName, action: { ...string, enum: ['rigid_body', 'bake', 'clear'], description: 'What to do.' },
        kind: { ...string, enum: ['active', 'passive'], description: 'active falls, passive is a static collider.' },
        mass: number, friction: number, restitution: number,
        preset: { ...string, description: "Cloth preset name, e.g. 'cotton'." }, collider: objectName,
        frame_start: number, frame_end: number },
      mutating, ['action']),
    spec('model3d_io', 'Import a 3D file into the document or export it out. Supported: glTF/GLB and OBJ. Import creates one mesh datablock per mesh in the file.',
      { id, action: { ...string, enum: ['import', 'export'], description: 'Direction.' },
        path: { ...string, description: 'Absolute file path; the extension picks the format (.glb, .gltf, .obj).' },
        names: { type: 'array', items: string, description: 'Restrict an export to these objects.' } },
      mutating, ['action', 'path']),
    spec('model3d_document', 'Save or load a .model3d.json project file. The document holds datablocks, modifier stacks and animation — everything except derived geometry.',
      { id, action: { ...string, enum: ['save', 'load'], description: 'Direction.' }, path: { ...string, description: 'Absolute .model3d.json path.' } },
      mutating, ['action', 'path']),
    spec('model3d_serialize', 'Read the full document as JSON: every object with its transform, modifier stack, a geometry cache key, all materials and the scene settings. The side panel renders from this.',
      { id,include_texture_data:boolean }, readOnly),
    spec('model3d_mesh', 'Read one object\'s EVALUATED geometry (post-modifier) as float32 position/normal buffers and uint32 indices, keyed by a content hash so unchanged geometry is not re-fetched.',
      { id, name: objectName }, readOnly, ['name']),
    spec('model3d_inspect', 'List every object, or read one in detail (transform, modifier stack, evaluated vertex/triangle counts, materials, bounding box).',
      { id, name: objectName }, readOnly),
    spec('model3d_mesh_edit','Create or update a base mesh with indexed triangles and optional UV/skin attributes. Existing shared meshes become single-user unless edit_shared=true; active modifiers require bake_modifiers=true.',
      {id,name:objectName,action:{...string,enum:['create','update','bake_geometry']},discard_surface_data:boolean,positions:{type:'array',items:number},indices:{type:'array',items:number},normals:{type:'array',items:number},uvs:{type:'array',items:number},uvs1:{type:'array',items:number},tangents:{type:'array',items:number},colors:{type:'array',items:number},groups:{type:'array',items:{type:'object'}},morphTargets:{type:'array',items:{type:'object'}},skinIndices:{type:'array',items:number},skinWeights:{type:'array',items:number},materials:{type:'array',items:string},bake_modifiers:boolean,edit_shared:boolean},mutating,['name','action']),
    spec('model3d_sculpt','Deform local base-mesh vertices with bounded draw, inflate, smooth, flatten, crease or grab strokes. Sculpt preserves UVs and skin weights; it never substitutes object scaling for surface edits.',
      {id,name:objectName,strokes:{type:'array',maxItems:512,items:{type:'object',properties:{brush:{...string,enum:['draw','inflate','smooth','flatten','crease','grab']},point:vec3,radius:number,strength:number,normal:vec3,delta:vec3},required:['brush','point','radius','strength']}},bake_modifiers:boolean,edit_shared:boolean},mutating,['name','strokes']),
    spec('model3d_uv','Create or repack UV coordinates, split declared seams and preserve all duplicated skin/morph vertex attributes. Supports chart unwrap, planar, box, cylindrical and spherical projection.',
      {id,name:objectName,method:{...string,enum:['unwrap','planar','box','cylindrical','spherical']},options:{type:'object',properties:{axis:{...string,enum:['x','y','z']},padding:number,angleDegrees:number,seams:{type:'array',items:{type:'array',items:number,minItems:2,maxItems:2}}}},bake_modifiers:boolean,edit_shared:boolean},mutating,['name']),
    spec('model3d_geometry','Create or update an editable local geometry graph. Typed DAG nodes support primitive/source/mirror/array/transform/subdivide/profile/sweep; cycles and excessive geometry are refused. Saves the graph and its evaluated mesh.',
      {id,name:objectName,graph:{type:'object',properties:{nodes:{type:'array',maxItems:256,items:{type:'object'}},output:string},required:['nodes','output']},bake_modifiers:boolean},mutating,['name','graph']),
    spec('model3d_rig','Create a bone hierarchy, bind normalized four-influence skin weights, pose bones or paint selected vertex weights. Rigs and animations export with the GLB asset.',
      {id,action:{...string,enum:['create','bind','pose','set_weights']},name:objectName,skin:string,bones:{type:'array',maxItems:256,items:{type:'object',properties:{name:string,parent:string,position:vec3,rotation_euler:vec3,rotation_quaternion:{type:'array',items:number,minItems:4,maxItems:4},scale:vec3},required:['name']}},poses:{type:'array',items:{type:'object',properties:{name:string,location:vec3,rotation_euler:vec3,rotation_quaternion:{type:'array',items:number,minItems:4,maxItems:4}},required:['name']}},weights:{type:'array',items:{type:'object',properties:{vertex:number,joints:{type:'array',items:number,minItems:1,maxItems:4},weights:{type:'array',items:number,minItems:1,maxItems:4}},required:['vertex','joints','weights']}},falloff:number,bake_modifiers:boolean,edit_shared:boolean},mutating,['action']),
    spec('model3d_texture','Create a PNG texture, import a local PNG/JPEG, or paint bounded UV-space strokes into a PNG. Pixel data stays in the local document; assign the returned texture name to a PBR material slot.',
      {id,action:{...string,enum:['create','import','paint']},name:string,width:number,height:number,color:{type:'array',items:number,minItems:3,maxItems:4},path:string,replace:boolean,strokes:{type:'array',maxItems:512,items:{type:'object',properties:{uv:{type:'array',items:number,minItems:2,maxItems:2},mode:{...string,enum:['paint','replace','erase']},radius:number,color:{type:'array',items:number,minItems:3,maxItems:4},strength:number},required:['uv','radius','color']}}},mutating,['action','name']),
  ];
}
