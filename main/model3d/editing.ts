import { open } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Json } from '../ipc/contract';
import { record, type Data } from '../visuals/data';
import { string } from '../services/service-types';
import { findObject, parseDocument, safeName, type MeshBlock, type Model3DDocument, type Object3DRecord } from './model';
import { worldMatrixOf } from './scene-math';
import { sculptMesh, unwrapMesh, evaluateGeometryGraph, createRig, rigFromObjects, bindSkin, meshNormals } from './authoring';
import { createTexture, paintTexture, type TextureStroke } from './texture-edit';
import { inspectTextureImage } from './io';
import type { EvaluatedMesh } from './kernel';

type Evaluate = (doc:Model3DDocument,target:Object3DRecord)=>Promise<EvaluatedMesh|null>;
const numbers = (value:unknown,label:string):number[] => {
  if(!Array.isArray(value)||value.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw new Error(`${label} must contain finite numbers.`);
  return [...value] as number[];
};
const required = (value:unknown,label:string):string => {const result=string(value);if(!result)throw new Error(`${label} is required.`);return result;};
function validateMesh(mesh:MeshBlock):void{
  const p=mesh.positions??[],indices=mesh.indices??[],count=p.length/3;
  if(!p.length||p.length%3||p.some(v=>!Number.isFinite(v))||count>1_000_000)throw new Error('Mesh positions must contain 1 to 1,000,000 finite vertices.');
  if(!indices.length||indices.length%3||indices.length>12_000_000||indices.some(v=>!Number.isInteger(v)||v<0||v>=count))throw new Error('Mesh indices must reference valid triangle vertices.');
  for(const [key,width]of [['normals',3],['uvs',2],['uvs1',2],['skinIndices',4],['skinWeights',4],['tangents',4]] as const){
    const values=mesh[key];if(values&&(values.length!==count*width||values.some(v=>!Number.isFinite(v))))throw new Error(`Mesh ${key} length or values are invalid.`);
  }
}
async function editableMesh(doc:Model3DDocument,target:Object3DRecord,fields:Data,evaluate:Evaluate):Promise<MeshBlock>{
  if(target.type!=='MESH'||!target.mesh)throw new Error('This operation needs a mesh object.');
  const source=doc.meshes[target.mesh];if(!source)throw new Error('Mesh datablock is missing.');
  if(fields.discard_surface_data===true){
    const stripped=structuredClone(source);
    for(const key of ['uvs','uvs1','tangents','colors','skinIndices','skinWeights','morphTargets','groups']as const)delete stripped[key];
    const newName=safeName(`${source.name}_geometry`,source.name,Object.keys(doc.meshes));stripped.name=newName;doc.meshes[newName]=stripped;target.mesh=newName;
    delete target.skin;delete target.morphInfluences;
    if(target.animation)delete target.animation.morph_weights;
    for(const clip of Object.values(doc.clips??{}))clip.tracks=clip.tracks.filter(t=>t.object!==target.name||t.path!=='weights');
    return editableMesh(doc,target,{...fields,discard_surface_data:false,bake_modifiers:true},evaluate);
  }
  const active=target.modifiers.some(m=>m.enabled);
  if(active&&fields.bake_modifiers!==true)throw new Error('Editing base vertices under active modifiers requires bake_modifiers=true.');
  let result:MeshBlock;
  if(source.primitive!==null||active){
    const evaluated=await evaluate(doc,target);if(!evaluated)throw new Error('The mesh has no evaluated geometry.');
    result={...source,primitive:null,primitiveParams:{},positions:Array.from(evaluated.positions),indices:Array.from(evaluated.indices),normals:Array.from(evaluated.normals)};
    for(const key of ['uvs','uvs1','skinIndices','skinWeights','tangents','colors'] as const){const value=evaluated[key];if(value)(result as unknown as Record<string,unknown>)[key]=Array.from(value);}
    if(active)target.modifiers=[];
  }else result=structuredClone(source);
  const references=doc.objects.filter(o=>o.mesh===target.mesh).length;
  if(references>1&&fields.edit_shared!==true){result.name=safeName(`${source.name}_edited`,source.name,Object.keys(doc.meshes));target.mesh=result.name;}
  validateMesh(result);return result;
}
function saveMesh(doc:Model3DDocument,target:Object3DRecord,mesh:MeshBlock):void{
  validateMesh(mesh);doc.meshes[mesh.name]=mesh;target.mesh=mesh.name;
}

/** Apply one bounded native authoring operation to a private document copy. */
export async function editModelDocument(input:Model3DDocument,verb:string,fields:Data,evaluate:Evaluate):Promise<{document:Model3DDocument;result:Json}>{
  const doc=structuredClone(input);
  if(verb==='model3d_mesh_edit'&&string(fields.action)==='bake_geometry'&&fields.discard_surface_data!==true)throw new Error('Geometry-only baking requires discard_surface_data=true.');
  if(verb==='model3d_texture'){
    doc.textures??={};const name=required(fields.name,'Texture name'),action=string(fields.action)||'create';
    if(action==='create'){
      if(doc.textures[name]&&fields.replace!==true)throw new Error('Texture exists; use replace=true to replace its pixels.');
      doc.textures[name]=createTexture(name,Number(fields.width??1024),Number(fields.height??1024),numbers(fields.color??[.8,.8,.8,1],'color'));
      return {document:doc,result:{texture:name,mimeType:'image/png'}};
    }
    if(action==='import'){
      const path=required(fields.path,'Texture file'),handle=await open(path,'r');let bytes:Buffer;
      try{const info=await handle.stat();if(!info.isFile()||info.size>24*1024*1024)throw new Error('Texture import needs a regular file of at most 24 MiB.');const buffer=Buffer.alloc(info.size);const result=await handle.read(buffer,0,buffer.length,0);if(result.bytesRead!==buffer.length)throw new Error('Texture file changed during import.');bytes=buffer;}finally{await handle.close();}
      const mime=extname(path).toLowerCase()==='.png'?'image/png':['.jpg','.jpeg'].includes(extname(path).toLowerCase())?'image/jpeg':null;
      if(!mime)throw new Error('Texture import supports PNG and JPEG files.');
      if(mime==='image/png'&&!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('Invalid PNG signature.');
      if(mime==='image/jpeg'&&!bytes.subarray(0,3).equals(Buffer.from([255,216,255])))throw new Error('Invalid JPEG signature.');
      if(doc.textures[name]&&fields.replace!==true)throw new Error('Texture exists; use replace=true to replace it.');
      const dimensions=inspectTextureImage(bytes,mime);
      doc.textures[name]={name,mimeType:mime,dataBase64:bytes.toString('base64'),...dimensions};return {document:doc,result:{texture:name,bytes:bytes.length,...dimensions}};
    }
    const source=doc.textures[name];if(!source)throw new Error(`No texture named '${name}'.`);
    if(action!=='paint')throw new Error(`Unsupported texture action '${action}'.`);
    const strokes=(Array.isArray(fields.strokes)?fields.strokes:[]).map(raw=>{const r=record(raw);return {uv:numbers(r.uv,'uv'),radius:Number(r.radius),color:numbers(r.color,'color'),strength:r.strength===undefined?undefined:Number(r.strength),mode:r.mode};});
    const painted=paintTexture(source,strokes as TextureStroke[]);doc.textures[name]=painted.texture;
    return {document:doc,result:{texture:name,pixelsChanged:painted.pixelsChanged}};
  }
  if(verb==='model3d_geometry'){
    const name=required(fields.name,'Object name'),definition=record(fields.graph);
    const mesh=evaluateGeometryGraph(definition as unknown as Parameters<typeof evaluateGeometryGraph>[0],name);
    mesh.geometryGraph=structuredClone(definition) as Record<string,Json>;validateMesh(mesh);
    let target=findObject(doc,name);
    if(target&&target.type!=='MESH')throw new Error('Geometry output cannot replace a non-mesh object.');
    if(!target){target={name,type:'MESH',mesh:mesh.name,transform:{location:{x:0,y:0,z:0},rotationEuler:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},modifiers:[],visible:true};doc.objects.push(target);}
    else {
      const previous=target.mesh?doc.meshes[target.mesh]:undefined;
      if(target.skin||previous?.skinIndices||previous?.morphTargets?.length)throw new Error('A bound or morph-target mesh must be explicitly converted to geometry-only before replacing its graph.');
      if(target.modifiers.length&&fields.bake_modifiers!==true)throw new Error('Replacing a procedural mesh under modifiers requires bake_modifiers=true.');
      if(!mesh.materials.length&&previous)mesh.materials=previous.materials.slice();
      if(doc.objects.some(o=>o!==target&&o.mesh===mesh.name))mesh.name=safeName(`${name}_geometry`,name,Object.keys(doc.meshes));
    }
    target.modifiers=[];saveMesh(doc,target,mesh);
    return {document:doc,result:{name,vertices:mesh.positions!.length/3,triangles:mesh.indices!.length/3,nodes:Array.isArray(definition.nodes)?definition.nodes.length:0}};
  }
  if(verb==='model3d_rig'){
    const action=string(fields.action),skinName=required(fields.skin??fields.name,'Skin name');doc.skins??={};
    if(action==='create'){
      if(doc.skins[skinName])throw new Error(`Skin '${skinName}' already exists.`);
      const bones=(Array.isArray(fields.bones)?fields.bones:[]).map(raw=>{const b=record(raw);const vector=(v:unknown)=>{if(v===undefined)return undefined;const r=numbers(v,'bone vector');if(r.length!==3)throw new Error('A bone vector needs three components.');return {x:r[0]!,y:r[1]!,z:r[2]!};};return {name:required(b.name,'Bone name'),parent:string(b.parent)||undefined,position:vector(b.position),rotationEuler:vector(b.rotation_euler??b.rotationEuler),rotationQuaternion:b.rotation_quaternion===undefined?undefined:numbers(b.rotation_quaternion,'bone quaternion'),scale:vector(b.scale)};});
      const rig=createRig(bones as unknown as Parameters<typeof createRig>[0],skinName);
      if(rig.objects.some(o=>findObject(doc,o.name)))throw new Error('A rig bone name collides with an existing scene object.');
      doc.objects.push(...rig.objects);doc.skins[skinName]=rig.skin;
      return {document:doc,result:{skin:skinName,bones:rig.objects.map(o=>o.name)}};
    }
    const skin=doc.skins[skinName];if(!skin)throw new Error(`No skin named '${skinName}'.`);
    if(action==='pose'){
      const poses=(Array.isArray(fields.poses)?fields.poses:[]).map(record);
      for(const pose of poses){
        const name=required(pose.name,'Bone name');if(!skin.joints.includes(name))throw new Error(`'${name}' is not a bone of this rig.`);
        const target=findObject(doc,name)!;if(pose.rotation_quaternion!==undefined||pose.rotation_euler!==undefined||pose.location!==undefined)delete target.transform.matrix;
        if(pose.rotation_quaternion!==undefined){const q=numbers(pose.rotation_quaternion,'rotation_quaternion');if(q.length!==4||Math.hypot(...q)<1e-8)throw new Error('A bone quaternion needs four nonzero finite components.');const length=Math.hypot(...q);target.transform.rotationQuaternion=q.map(v=>v/length);}
        if(pose.rotation_euler!==undefined){const r=numbers(pose.rotation_euler,'rotation_euler');if(r.length!==3)throw new Error('A bone rotation needs three components.');target.transform.rotationEuler={x:r[0]!,y:r[1]!,z:r[2]!};delete target.transform.rotationQuaternion;}
        if(pose.location!==undefined){const r=numbers(pose.location,'location');if(r.length!==3)throw new Error('A bone position needs three components.');target.transform.location={x:r[0]!,y:r[1]!,z:r[2]!};}
      }
      return {document:doc,result:{skin:skinName,posed:poses.map(p=>String(p.name))}};
    }
    const target=findObject(doc,required(fields.name,'Mesh object'));if(!target)throw new Error('Mesh object does not exist.');
    const mesh=await editableMesh(doc,target,fields,evaluate);
    if(action==='bind'){
      const rig=rigFromObjects(skin,doc.objects);
      const result=bindSkin(mesh,rig,{meshWorldMatrix:worldMatrixOf(doc,target.name),maxInfluences:4,falloff:Number(fields.falloff??2)});
      const boundSkinName=safeName(`${skinName}_${target.name}`,skinName,Object.keys(doc.skins));doc.skins[boundSkinName]={...result.skin,name:boundSkinName};
      saveMesh(doc,target,result.mesh);target.skin=boundSkinName;
      return {document:doc,result:{name:target.name,skin:boundSkinName,vertices:mesh.positions!.length/3}};
    }
    if(action==='set_weights'){
      if(target.skin!==skinName||!mesh.skinIndices||!mesh.skinWeights)throw new Error('Bind this mesh to the selected skin first.');
      const values=(Array.isArray(fields.weights)?fields.weights:[]).map(record);
      if(!values.length||values.length>100000)throw new Error('Weight painting needs 1 to 100,000 vertex entries.');
      for(const value of values){
        const vertex=Number(value.vertex),joints=numbers(value.joints,'joints'),weights=numbers(value.weights,'weights');
        if(!Number.isInteger(vertex)||vertex<0||vertex>=mesh.positions!.length/3||joints.length!==weights.length||joints.length<1||joints.length>4||joints.some(j=>!Number.isInteger(j)||j<0||j>=skin.joints.length)||weights.some(w=>w<0)||weights.reduce((a,b)=>a+b,0)<=0)throw new Error('Invalid vertex skin weights.');
        const total=weights.reduce((a,b)=>a+b,0);for(let i=0;i<4;i++){mesh.skinIndices[vertex*4+i]=joints[i]??0;mesh.skinWeights[vertex*4+i]=(weights[i]??0)/total;}
      }
      saveMesh(doc,target,mesh);return {document:doc,result:{name:target.name,paintedVertices:values.length}};
    }
    throw new Error(`Unsupported rig action '${action}'.`);
  }
  const name=required(fields.name,'Mesh object');let target=findObject(doc,name);
  if(verb==='model3d_mesh_edit'&&!target&&string(fields.action)==='create'){
    target={name,type:'MESH',mesh:safeName(name,name,Object.keys(doc.meshes)),transform:{location:{x:0,y:0,z:0},rotationEuler:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}},modifiers:[],visible:true};
    const mesh:MeshBlock={name:target.mesh!,primitive:null,primitiveParams:{},positions:numbers(fields.positions,'positions'),indices:numbers(fields.indices,'indices'),materials:Array.isArray(fields.materials)?fields.materials.map(String):[]};
    for(const key of ['normals','uvs','uvs1','tangents','colors','skinIndices','skinWeights']as const)if(fields[key]!==undefined)mesh[key]=numbers(fields[key],key);
    if(fields.groups!==undefined)mesh.groups=structuredClone(fields.groups) as MeshBlock['groups'];if(fields.morphTargets!==undefined)mesh.morphTargets=structuredClone(fields.morphTargets) as MeshBlock['morphTargets'];
    validateMesh(mesh);doc.objects.push(target);doc.meshes[mesh.name]=mesh;return {document:doc,result:{name,vertices:mesh.positions!.length/3,triangles:mesh.indices!.length/3}};
  }
  if(!target)throw new Error(`No mesh object named '${name}'.`);
  let mesh=await editableMesh(doc,target,fields,evaluate);let extra:Record<string,Json>={};
  if(verb==='model3d_sculpt'){
    const strokes=(Array.isArray(fields.strokes)?fields.strokes:[]).map(raw=>{const s=record(raw);const vec=(v:unknown)=>{const r=numbers(v,'brush vector');if(r.length!==3)throw new Error('A brush vector needs three components.');return {x:r[0]!,y:r[1]!,z:r[2]!};};return {brush:s.brush,point:vec(s.point),radius:Number(s.radius),strength:Number(s.strength),normal:s.normal===undefined?undefined:vec(s.normal),delta:s.delta===undefined?undefined:vec(s.delta)};});
    const result=sculptMesh(mesh,strokes as Parameters<typeof sculptMesh>[1]);mesh=result.mesh;extra={affectedVertices:result.affectedVertices};
  }else if(verb==='model3d_uv'){
    const result=unwrapMesh(mesh,{...record(fields.options),method:string(fields.method)||'unwrap'} as Parameters<typeof unwrapMesh>[1]);mesh=result.mesh;extra={islands:result.islands as unknown as Json,seams:result.seams as unknown as Json};
  }else if(verb==='model3d_mesh_edit'){
    for(const key of ['positions','indices','normals','uvs','uvs1','tangents','colors','skinIndices','skinWeights']as const)if(fields[key]!==undefined)mesh[key]=numbers(fields[key],key);
    if(fields.groups!==undefined)mesh.groups=structuredClone(fields.groups) as MeshBlock['groups'];if(fields.morphTargets!==undefined)mesh.morphTargets=structuredClone(fields.morphTargets) as MeshBlock['morphTargets'];
    if(fields.materials!==undefined){if(!Array.isArray(fields.materials))throw new Error('materials must be a list of names.');mesh.materials=fields.materials.map(String);}
    if(fields.positions!==undefined||fields.indices!==undefined){validateMesh(mesh);if(fields.normals===undefined)mesh.normals=meshNormals(mesh.positions!,mesh.indices!);if(fields.tangents===undefined)delete mesh.tangents;}
    else if(fields.uvs!==undefined&&fields.tangents===undefined)delete mesh.tangents;
    delete mesh.geometryGraph;
  }else throw new Error(`Unknown authoring verb '${verb}'.`);
  saveMesh(doc,target,mesh);
  // Re-validate the enriched document before the host publishes a new version.
  const validated=parseDocument(doc);return {document:validated,result:{name,vertices:mesh.positions!.length/3,triangles:mesh.indices!.length/3,...extra}};
}
