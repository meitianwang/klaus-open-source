import type { Model3DDocument, Object3DRecord } from './model';
import { evaluateObject, GeometryCache, physics, type Kernel } from './kernel';
import { composeTransform, invertMatrix, matrixToTransform, multiplyMatrices, worldMatrixOf } from './scene-math';

/**
 * Local rigid-body simulation. Body placement uses full scene world transforms;
 * fixed scenery retains its authored affine shape and active bodies bake to local
 * position and quaternion channels. This module has no cloth solver.
 */

export interface BakeResult {
  frames: number;
  /** Active object name -> per-frame LOCAL location [x, y, z]. */
  tracks: Record<string, number[][]>;
  /** Active object name -> per-frame LOCAL unit quaternion [x, y, z, w]. */
  rotationTracks?: Record<string, number[][]>;
  /** Canonical LOCAL scale, including the sign needed to reconstruct reflections. */
  scaleTracks?: Record<string, number[][]>;
  /** Exact local matrices for validation, not an animation export promise. */
  matrixTracks?: Record<string, number[][]>;
  ms: number;
}

type RigidEntry = { body: any; record: Object3DRecord; residual: number[] };
type Quaternion = { x: number; y: number; z: number; w: number };
type Translation = { x: number; y: number; z: number };

function rigidMatrix(position: Translation, q: Quaternion): number[] {
  const x = q.x * 2, y = q.y * 2, z = q.z * 2;
  return [1-q.y*y-q.z*z,q.x*y+q.w*z,q.x*z-q.w*y,0,
    q.x*y-q.w*z,1-q.x*x-q.z*z,q.y*z+q.w*x,0,
    q.x*z+q.w*y,q.y*z-q.w*x,1-q.x*x-q.y*y,0,position.x,position.y,position.z,1];
}

function quaternionOf(matrix: number[]): Quaternion {
  const transform=matrixToTransform(matrix) as Object3DRecord['transform'] & {rotationQuaternion?:number[]};
  const q=transform.rotationQuaternion??[0,0,0,1];return {x:q[0]!,y:q[1]!,z:q[2]!,w:q[3]!};
}

function determinant(matrix:number[]):number {
  return matrix[0]!*(matrix[5]!*matrix[10]!-matrix[9]!*matrix[6]!)-matrix[4]!*(matrix[1]!*matrix[10]!-matrix[9]!*matrix[2]!)+matrix[8]!*(matrix[1]!*matrix[6]!-matrix[5]!*matrix[2]!);
}

/**
 * Step the simulation and sample every active body's translation per frame.
 *
 * Returns raw tracks instead of writing them into the document: the caller
 * decides whether to commit them as keyframes (destructive to the authored
 * animation) or just preview them.
 */
export async function bake(
  _kernelInstance: Kernel,
  doc: Model3DDocument,
  frameStart: number,
  frameEnd: number,
  fps: number,
): Promise<BakeResult> {
  if (![frameStart,frameEnd,fps].every(Number.isFinite)||!Number.isInteger(frameStart)||!Number.isInteger(frameEnd)||frameEnd<frameStart||frameEnd-frameStart+1>1000||fps<=0||fps>240) throw new Error('Rigid-body bake requires an ordered integer range of at most 1000 frames and FPS in (0,240].');
  const records=doc.objects.filter(record=>!!record.rigidBody);
  if(records.length>2048)throw new Error('Rigid-body bake supports at most 2048 bodies.');
  const rapier=await physics(),world=new rapier.World({x:0,y:0,z:-9.81}),cache=new GeometryCache();
  world.timestep=1/fps;
  const started=Date.now(),bodies=new Map<string,RigidEntry>();
  try {
    for(const record of records){
      const setup=record.rigidBody!;
      if(!Number.isFinite(setup.mass)||setup.mass<=0||!Number.isFinite(setup.friction)||setup.friction<0||!Number.isFinite(setup.restitution)||setup.restitution<0||setup.restitution>1)throw new Error('Rigid-body mass, friction and restitution are outside their physical ranges.');
      const matrix=worldMatrixOf(doc,record.name),position={x:matrix[12]!,y:matrix[13]!,z:matrix[14]!},rotation=quaternionOf(matrix);
      const residual=multiplyMatrices(invertMatrix(rigidMatrix(position,rotation)),matrix);
      const descriptor=(setup.kind==='passive'?rapier.RigidBodyDesc.fixed():rapier.RigidBodyDesc.dynamic()).setTranslation(position.x,position.y,position.z).setRotation(rotation);
      const body=world.createRigidBody(descriptor),collider=await colliderFor(doc,record,residual,rapier,cache);
      if(!collider)throw new Error(`Rigid body '${record.name}' has no usable collision geometry.`);
      collider.setFriction(setup.friction);collider.setRestitution(setup.restitution);
      // Override total collider mass instead of adding it to the default density mass.
      collider.setMass(setup.mass);world.createCollider(collider,body);
      bodies.set(record.name,{body,record,residual});
    }
    const frames=frameEnd-frameStart+1,tracks:Record<string,number[][]>={},rotationTracks:Record<string,number[][]>={},scaleTracks:Record<string,number[][]>={},matrixTracks:Record<string,number[][]>={};
    for(const [name,entry]of bodies)if(entry.record.rigidBody?.kind==='active'){tracks[name]=[];rotationTracks[name]=[];scaleTracks[name]=[];matrixTracks[name]=[];}
    const byName=new Map(doc.objects.map(record=>[record.name,record]));
    for (let frame = 0; frame < frames; frame++) {
      world.step();
      const matrices=new Map<string,number[]>(),visiting=new Set<string>();
      const currentWorld=(name:string):number[]=>{
        const cached=matrices.get(name);if(cached)return cached;
        if(visiting.has(name))throw new Error(`Physics hierarchy cycle at '${name}'.`);
        const record=byName.get(name);if(!record)throw new Error(`Physics parent '${name}' is missing.`);
        visiting.add(name);
        const body=bodies.get(name),parent=(record as Object3DRecord&{parent?:string}).parent;
        const matrix=body?multiplyMatrices(rigidMatrix(body.body.translation(),body.body.rotation()),body.residual):parent?multiplyMatrices(currentWorld(parent),composeTransform(record.transform)):composeTransform(record.transform);
        visiting.delete(name);matrices.set(name,matrix);return matrix;
      };
      for(const [name,entry]of bodies){
        if(entry.record.rigidBody?.kind!=='active')continue;
        const parent=(entry.record as Object3DRecord&{parent?:string}).parent,worldMatrix=currentWorld(name),local=parent?multiplyMatrices(invertMatrix(currentWorld(parent)),worldMatrix):worldMatrix;
        const transform=matrixToTransform(local) as Object3DRecord['transform']&{matrix?:number[]};delete transform.matrix;
        const reconstructed=composeTransform(transform),tolerance=Math.max(1,...local.slice(0,12).map(Math.abs))*1e-5;
        if(local.some((value,i)=>Math.abs(value-reconstructed[i]!)>tolerance))throw new Error(`Reparent rigid body '${name}' to a nonsheared frame before bake, or bake its affine shape into geometry.`);
        tracks[name]!.push([local[12]!,local[13]!,local[14]!]);
        scaleTracks[name]!.push([transform.scale.x,transform.scale.y,transform.scale.z]);
        const q=quaternionOf(local);let values=[q.x,q.y,q.z,q.w];const previous=rotationTracks[name]!.at(-1);
        if(previous&&values.reduce((sum,value,i)=>sum+value*previous[i]!,0)<0)values=values.map(value=>-value);
        rotationTracks[name]!.push(values);matrixTracks[name]!.push(local);
      }
    }
    return {frames,tracks,rotationTracks,scaleTracks,matrixTracks,ms:Date.now()-started};
  } finally {
    // rapier bodies are WASM allocations; forgetting to free them leaks native
    // memory the JS GC cannot see.
    cache.clear();world.free();
  }
}

/**
 * A collision shape for one object.
 *
 * A convex hull is the default because it is cheap, always convex (which rapier
 * requires for dynamic bodies), and visually close for most solids. `concave`
 * opts into a trimesh collider for static scenery such as a ground plane.
 */
async function colliderFor(doc:Model3DDocument,record:Object3DRecord,residual:number[],rapier:any,cache:GeometryCache):Promise<any|null> {
  if (record.type !== 'MESH') {
    // Non-mesh bodies still need a shape to collide; use a small ball so a
    // camera or light marked passive behaves predictably instead of vanishing.
    const radius=.1*Math.max(Math.hypot(...residual.slice(0,3)),Math.hypot(...residual.slice(4,7)),Math.hypot(...residual.slice(8,11)));
    return rapier.ColliderDesc.ball(radius);
  }
  const mesh=await evaluateObject(doc,record,cache);if(!mesh||!mesh.positions.length||!mesh.indices.length)return null;
  const positions=new Float32Array(mesh.positions.length);
  for(let i=0;i<positions.length;i+=3){
    const x=mesh.positions[i]!,y=mesh.positions[i+1]!,z=mesh.positions[i+2]!;
    positions[i]=residual[0]!*x+residual[4]!*y+residual[8]!*z+residual[12]!;
    positions[i+1]=residual[1]!*x+residual[5]!*y+residual[9]!*z+residual[13]!;
    positions[i+2]=residual[2]!*x+residual[6]!*y+residual[10]!*z+residual[14]!;
  }
  const indices=new Uint32Array(mesh.indices);
  if(determinant(residual)<0)for(let i=0;i<indices.length;i+=3)[indices[i+1],indices[i+2]]=[indices[i+2]!,indices[i+1]!];
  const concave = record.rigidBody?.kind === 'passive';
  return concave
    ? rapier.ColliderDesc.trimesh(positions, indices)
    : rapier.ColliderDesc.convexHull(positions);
}

/**
 * Sample a baked track at an arbitrary frame (linear interpolation), so the
 * panel scrubber and `simulate` agree without re-running the solver.
 */
export function sampleTrack(track: number[][] | undefined, frame: number): number[] | null {
  if (!track || !track.length) return null;
  if(!Number.isFinite(frame))return null;
  const clamped=Math.max(0,Math.min(track.length-1,frame)),low=Math.floor(clamped),high=Math.ceil(clamped),t=clamped-low;
  return track[low]!.map((value,i)=>value*(1-t)+track[high]![i]!*t);
}
