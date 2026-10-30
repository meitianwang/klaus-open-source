import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, assert, assertEqual, assertDeepEqual } from './harness';
import { applyModifier, kernel, primitiveSolid, solidFromMesh, evaluateObject, GeometryCache } from '../main/model3d/kernel';
import { emptyDocument, zeroVec, oneVec, type Modifier3D, type Object3DRecord } from '../main/model3d/model';
import type { Json } from '../main/ipc/contract';
import { bake, sampleTrack } from '../main/model3d/physics';
import { composeTransform } from '../main/model3d/scene-math';

const h = new Harness(), doc = emptyDocument('geometry-proof','Geometry proof','geometry-proof');
const object = (name: string): Object3DRecord => ({name,type:'MESH',mesh:name,transform:{location:zeroVec(),rotationEuler:zeroVec(),scale:oneVec()},modifiers:[],visible:true});
const self = object('Self'); doc.objects.push(self); doc.meshes.Self={name:'Self',primitive:'cube',primitiveParams:{size:2},materials:[]};
const modifier = (type: Modifier3D['type'], params: Record<string,Json>={}): Modifier3D => ({id:type,type,label:type,enabled:true,params});
const apply = async (type: Modifier3D['type'], params: Record<string,Json>={}, source?: any): Promise<any> => {
  const k=await kernel(); return applyModifier(k,source??k.Manifold.cube([2,2,2],true),modifier(type,params),{doc,self,visiting:new Set([self.name])});
};
const near = (a:number,b:number,epsilon:number,message:string):void=>assert(Math.abs(a-b)<=epsilon,`${message}: expected ${b}, got ${a}`);
const valid = (solid:any,message:string):void=>{assertEqual(solid.status(),'NoError',message);assert(!solid.isEmpty()&&solid.volume()>0,`${message} retains positive volume`);};

h.test('decimation never erases a cube when the requested count is geometrically unavailable',async()=>{
  const result=await apply('decimate',{ratio:.5});valid(result,'cube decimation');assert(result.numTri()>=4,'closed result has at least four triangles');
});
h.test('decimation finds a reduced sphere without treating its face count as distance',async()=>{
  const k=await kernel(),source=primitiveSolid(k,'uv_sphere',{radius:1,segments:32,rings:16});
  const result=await apply('decimate',{ratio:.4},source);valid(result,'sphere decimation');
  assert(result.numTri()<source.numTri()*.7,'requested reduction changes geometry');assert(result.volume()>source.volume()*.7,'sphere remains recognizable');
});
h.test('smooth creates interpolated surface geometry rather than only filling tangent metadata',async()=>{
  const result=await apply('smooth',{angle:180,smoothness:.5,factor:3});valid(result,'smooth');
  assert(result.numTri()>12,'surface interpolation adds vertices');assert(Math.abs(result.volume()-8)>.001,'rounded surface differs from the source cube');
});
h.test('boolean operand uses full relative translation rotation and nonuniform scale',async()=>{
  const d=emptyDocument('relative','Relative','relative'),left=object('Left'),right=object('Right');
  left.transform={location:{x:3,y:-2,z:1},rotationEuler:{x:0,y:0,z:Math.PI/2},scale:{x:2,y:1,z:.5}};
  right.transform={location:{x:3.8,y:-2,z:1},rotationEuler:{x:0,y:0,z:Math.PI/2},scale:{x:.5,y:.25,z:.25}};
  for(const o of [left,right]) {d.objects.push(o);d.meshes[o.name]={name:o.name,primitive:'cube',primitiveParams:{size:2},materials:[]};}
  const k=await kernel(),result=applyModifier(k,k.Manifold.cube([2,2,2],true),modifier('boolean',{operation:'intersect',object:'Right'}),{doc:d,self:left,visiting:new Set(['Left'])});
  valid(result,'relative intersection');near(result.volume(),.225,.00001,'analytic overlap in left local space');
});
h.test('boolean evaluation includes parent world transforms',async()=>{
  const d=emptyDocument('parent','Parent','parent'),parent=object('Rig'),left=object('Left'),right=object('Right');parent.type='EMPTY';delete parent.mesh;
  parent.transform={location:{x:4,y:-1,z:2},rotationEuler:{x:0,y:0,z:Math.PI/2},scale:{x:1.5,y:1.5,z:1.5}};Object.assign(left,{parent:'Rig'});
  right.transform={location:{x:4,y:-1,z:2},rotationEuler:zeroVec(),scale:{x:.25,y:.25,z:.25}};d.objects.push(parent,left,right);
  for(const o of[left,right]) d.meshes[o.name]={name:o.name,primitive:'cube',primitiveParams:{size:2},materials:[]};
  const k=await kernel(),result=applyModifier(k,k.Manifold.cube([2,2,2],true),modifier('boolean',{operation:'intersect',object:'Right'}),{doc:d,self:left,visiting:new Set(['Left'])});
  valid(result,'parent intersection');near(result.volume(),.125/1.5**3,.00001,'parent scale is accounted for in local volume');
});
h.test('CAD conversion welds file-format seams without changing source vertices',async()=>{
  const k=await kernel(),original=k.Manifold.cube([2,2,2],true).getMesh(),positions:number[]=[],indices:number[]=[];
  for(const i of original.triVerts){positions.push(original.vertProperties[i*original.numProp],original.vertProperties[i*original.numProp+1],original.vertProperties[i*original.numProp+2]);indices.push(indices.length);}
  const result=solidFromMesh(k,positions,indices);valid(result,'seam welding');near(result.volume(),8,.00001,'closed cube after welding');assertEqual(positions.length,108,'authored seam vertices remain intact');
});
h.test('convex bevel cuts actual edge chamfers and segmented fillets',async()=>{
  const chamfer=await apply('bevel',{width:.2,segments:1}),fillet=await apply('bevel',{width:.2,segments:4});
  valid(chamfer,'chamfer');valid(fillet,'fillet');assert(chamfer.volume()<8,'edge material is removed');
  assert(fillet.numTri()>chamfer.numTri(),'fillet adds actual intermediate cutting planes');
  assert(fillet.volume()>chamfer.volume(),'rounded bevel retains the expected additional corner material');
});
h.test('bevel explicitly rejects concave shapes instead of substituting a different operation',async()=>{
  const k=await kernel(),source=k.Manifold.cube([2,2,2],true).subtract(k.Manifold.cube([1,1,3],true).translate([.8,.8,0]));
  let error='';try{await apply('bevel',{width:.1},source);}catch(e){error=String(e);}assert(error.includes('convex'),'unsupported concavity is explicit');
});
h.test('solidify uses constant face offsets around a translated source',async()=>{
  const k=await kernel(),source=k.Manifold.cube([2,2,2],true).translate([10,-3,2]),result=await apply('solidify',{thickness:.2},source);
  valid(result,'shell');near(result.volume(),8-1.6**3,.00001,'uniform wall shell volume');
  assert(result.intersect(k.Manifold.cube([1,1,1],true).translate([10,-3,2])).isEmpty(),'shell has a centered interior cavity');
});
h.test('wireframe contains real tubes and leaves the central volume empty',async()=>{
  const k=await kernel(),result=await apply('wireframe',{thickness:.12,segments:8});valid(result,'wireframe');
  assert(result.volume()<1,'surface is replaced by edges');assert(result.numTri()>12,'tube geometry exists');
  assert(result.intersect(k.Manifold.sphere(.2,12)).isEmpty(),'wireframe is not a hull or original cube');
});
h.test('cap extrusion preserves a concave profile rather than filling its bounding rectangle',async()=>{
  const k=await kernel(),profile=new k.CrossSection([[[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]]]),source=k.Manifold.extrude(profile,1);
  const result=await apply('extrude',{distance:1},source);valid(result,'cap extrusion');near(result.volume(),6,.00001,'L profile area times extended height');
  assert(result.intersect(k.Manifold.cube([.5,.5,1],true).translate([1.5,1.5,1.5])).isEmpty(),'unselected concave region remains empty');
});
h.test('screw supports genuine revolved profiles and closed pitched helical sweeps',async()=>{
  const profile:Json=[[1,-.1],[1.3,-.1],[1.3,.1],[1,.1]];
  const ring=await apply('screw',{profile,pitch:0,segments:32}),helix=await apply('screw',{profile,pitch:.7,turns:1.5,segments:32});
  valid(ring,'revolved profile');valid(helix,'helical sweep');const b=helix.boundingBox();
  assert(b.max[2]-b.min[2]>1.1,'pitch produces real vertical progression');assert(helix.numTri()>100,'capped sweep geometry exists');
});
h.test('volumetric remesh reconstructs a concave surface with bounded volume error',async()=>{
  const k=await kernel(),profile=new k.CrossSection([[[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]]]),source=k.Manifold.extrude(profile,1);
  const result=await apply('remesh',{voxels:16},source);valid(result,'remesh');near(result.volume(),3,.35,'voxel-resolution volume');
  assert(result.numTri()>source.numTri(),'surface is actually reconstructed');
});
h.test('concave offset shell uses the reconstructed signed-distance surface',async()=>{
  const k=await kernel(),profile=new k.CrossSection([[[0,0],[2,0],[2,1],[1,1],[1,2],[0,2]]]),source=k.Manifold.extrude(profile,1);
  const result=await apply('solidify',{thickness:.2,voxels:16},source);valid(result,'concave shell');assert(result.volume()<3,'inner offset removes a cavity');
});
h.test('icosphere vertices lie on their requested radius and subdivisions control real triangles',async()=>{
  const k=await kernel(),base=primitiveSolid(k,'ico_sphere',{radius:2,subdivisions:0}),refined=primitiveSolid(k,'ico_sphere',{radius:2,subdivisions:2});
  assertEqual(base.numTri(),20,'base icosahedron');assertEqual(refined.numTri(),320,'two projected subdivisions');
  const mesh=refined.getMesh();for(let i=0;i<mesh.vertProperties.length;i+=mesh.numProp) near(Math.hypot(mesh.vertProperties[i],mesh.vertProperties[i+1],mesh.vertProperties[i+2]),2,.000001,'projected vertex radius');
});
h.test('open character meshes preserve normals UV skin groups and morph data without CAD conversion',async()=>{
  const d=emptyDocument('attrs','Attributes','attrs'),o=object('Character');d.objects.push(o);
  Object.assign(d.meshes,{Character:{name:'Character',primitive:null,primitiveParams:{},materials:['Blue'],positions:[0,0,0,1,0,0,0,1,0],indices:[0,1,2],normals:[0,0,1,0,0,1,0,0,1],uvs:[0,0,1,0,0,1],skinIndices:Array(12).fill(0),skinWeights:[1,0,0,0,1,0,0,0,1,0,0,0],groups:[{start:0,count:3,materialIndex:0}],morphTargets:[{name:'Smile',positions:[0,0,0,0,.1,0,0,0,0]}]}});
  const result=await evaluateObject(d,o,new GeometryCache());assert(result,'open mesh evaluates');
  assertDeepEqual(Array.from(result.uvs!),[0,0,1,0,0,1],'UV data unchanged');assertEqual(result.skinWeights!.length,12,'skin preserved');assertEqual(result.morphTargets?.[0]?.name,'Smile','morph preserved');
  o.modifiers=[modifier('decimate',{ratio:.5})];let error='';try{await evaluateObject(d,o,new GeometryCache());}catch(e){error=String(e);}assert(error.includes('bake'),'topology loss requires explicit bake');
});
h.test('cache invalidates same-length mesh edits and transformed boolean dependencies',async()=>{
  const d=emptyDocument('cache','Cache','cache'),o=object('Mesh'),cache=new GeometryCache();d.objects.push(o);d.meshes.Mesh={name:'Mesh',primitive:null,primitiveParams:{},materials:[],positions:[0,0,0,1,0,0,0,1,0],indices:[0,1,2]};
  const first=await evaluateObject(d,o,cache);d.meshes.Mesh.positions![0]=.2;const second=await evaluateObject(d,o,cache);assert(first!==second,'vertex edit invalidates content cache');
  const a=object('A'),b=object('B');for(const x of[a,b]){d.objects.push(x);d.meshes[x.name]={name:x.name,primitive:'cube',primitiveParams:{size:2},materials:[]};}
  a.modifiers=[modifier('boolean',{operation:'subtract',object:'B'})];b.transform.location.x=.5;
  const before=await evaluateObject(d,a,cache);b.transform.location.x=1;const after=await evaluateObject(d,a,cache);assert(before?.geometryKey!==after?.geometryKey,'operand transform invalidates dependent geometry');
});
h.test('malformed custom attributes and indices fail before creating viewport buffers',async()=>{
  const d=emptyDocument('invalid','Invalid','invalid'),o=object('Invalid');d.objects.push(o);d.meshes.Invalid={name:'Invalid',primitive:null,primitiveParams:{},materials:[],positions:[0,0,0,1,0,0,0,1,0],indices:[0,1,9]};
  let error='';try{await evaluateObject(d,o,new GeometryCache());}catch(e){error=String(e);}assert(error.includes('indices'),'out-of-range index is explicit');
  d.meshes.Invalid.indices=[0,1,2];Object.assign(d.meshes.Invalid,{uvs:[0,0]});error='';try{await evaluateObject(d,o,new GeometryCache());}catch(e){error=String(e);}assert(error.includes('uvs'),'bad UV cardinality is explicit');
});

function addPhysicsObject(d:ReturnType<typeof emptyDocument>,name:string,kind:'active'|'passive',location:number[],scale:number[],primitive:'cube'|'uv_sphere'='cube'):Object3DRecord {
  const o=object(name);o.transform.location={x:location[0]!,y:location[1]!,z:location[2]!};o.transform.scale={x:scale[0]!,y:scale[1]!,z:scale[2]!};
  o.rigidBody={kind,mass:1,friction:1,restitution:0};d.objects.push(o);d.meshes[name]={name,primitive,primitiveParams:primitive==='cube'?{size:2}:{radius:1,segments:24,rings:12},materials:[]};return o;
}
h.test('physics places offset fixed colliders at their authored world location',async()=>{
  const d=emptyDocument('fixed-location','Fixed location','physics');addPhysicsObject(d,'Floor','passive',[3,0,2],[2,2,.25]);addPhysicsObject(d,'Drop','active',[3,0,5],[.2,.2,.2],'uv_sphere');
  const result=await bake(await kernel(),d,1,180,60),last=result.tracks.Drop!.at(-1)!;
  assert(last[0]!>1&&last[0]!<5&&Math.abs(last[1]!)<2,'ball remains inside the offset floor bounds');near(last[2]!,2.45,.08,'fixed floor supports the ball at its translated height');assert(!result.tracks.Floor,'fixed scenery gains no unnecessary animation');
});
h.test('physics collision geometry honors nonuniform mesh scale',async()=>{
  const d=emptyDocument('collider-scale','Collider scale','physics');addPhysicsObject(d,'Floor','passive',[0,0,0],[5,5,.1]);addPhysicsObject(d,'Drop','active',[0,0,3],[.5,.5,.8]);
  const result=await bake(await kernel(),d,1,180,60),last=result.tracks.Drop!.at(-1)!;near(last[2]!,.9,.06,'scaled box bottom rests on scaled floor');
});
h.test('physics respects a rotated parent and rotated floor while returning local tracks',async()=>{
  const d=emptyDocument('parent-physics','Parent physics','physics'),parent=object('Rig');parent.type='EMPTY';delete parent.mesh;
  parent.transform={location:{x:5,y:-2,z:3},rotationEuler:{x:0,y:0,z:Math.PI/2},scale:oneVec()};d.objects.push(parent);
  const floor=addPhysicsObject(d,'Floor','passive',[0,0,0],[3,3,.1]);floor.transform.rotationEuler.y=Math.PI/6;Object.assign(floor,{parent:'Rig'});
  const ball=addPhysicsObject(d,'Drop','active',[0,0,2],[.2,.2,.2],'uv_sphere');Object.assign(ball,{parent:'Rig'});
  const result=await bake(await kernel(),d,1,70,60),last=result.tracks.Drop!.at(-1)!;
  near(.5*last[0]!+Math.cos(Math.PI/6)*last[2]!,.3,.09,'ball contacts the transformed slope in parent-local coordinates');near(last[1]!,0,.1,'parent rotation is removed from baked local positions');
  assertEqual(result.rotationTracks?.Drop?.length,70,'one local quaternion per frame');assertEqual(result.matrixTracks?.Drop?.[0]?.length,16,'exact local pose matrix is available');
});
h.test('physics records actual rotation changes and unit quaternion channels',async()=>{
  const d=emptyDocument('rotation-physics','Rotation physics','physics');addPhysicsObject(d,'Floor','passive',[0,0,0],[5,5,.1]);const drop=addPhysicsObject(d,'Drop','active',[0,0,2],[.25,.25,.7]);drop.transform.rotationEuler.y=Math.PI/6;
  const result=await bake(await kernel(),d,1,180,60),q=result.rotationTracks!.Drop!,first=q[0]!,last=q.at(-1)!;
  assert(q.some(p=>p.some((v,i)=>Math.abs(v-first[i]!)>.01)),'collision changes the authored tilt');for(const p of [first,last])near(Math.hypot(...p),1,.00001,'unit quaternion track');
});
h.test('physics scale and quaternion tracks exactly reconstruct reflected authored poses',async()=>{
  const d=emptyDocument('reflection-physics','Reflection physics','physics'),drop=addPhysicsObject(d,'Drop','active',[2,-1,3],[.5,-.3,.7]);drop.transform.rotationEuler.y=.4;
  const result=await bake(await kernel(),d,1,10,60),p=result.tracks.Drop![9]!,q=result.rotationTracks!.Drop![9]!,s=result.scaleTracks!.Drop![9]!;
  const transform=Object.assign({location:{x:p[0]!,y:p[1]!,z:p[2]!},rotationEuler:zeroVec(),scale:{x:s[0]!,y:s[1]!,z:s[2]!}},{rotationQuaternion:q});
  const matrix=composeTransform(transform);for(let i=0;i<16;i++)near(matrix[i]!,result.matrixTracks!.Drop![9]![i]!,.00001,'reflected local pose component');
});
h.test('physics supports an open character surface through convex collision geometry',async()=>{
  const d=emptyDocument('open-physics','Open physics','physics'),o=addPhysicsObject(d,'Drop','active',[0,0,3],[1,1,1]);d.meshes.Drop={name:'Drop',primitive:null,primitiveParams:{},materials:[],positions:[0,0,0,1,0,0,0,1,0,0,0,1],indices:[0,1,2,0,3,1,0,2,3]};
  const result=await bake(await kernel(),d,1,10,60);assert(result.tracks.Drop![9]![2]!<o.transform.location.z,'open mesh falls as a convex rigid body');
});
h.test('physics rejects evolving local shear instead of exporting an incorrect quaternion pose',async()=>{
  const d=emptyDocument('shear-physics','Shear physics','physics'),parent=object('Stretch');parent.type='EMPTY';delete parent.mesh;parent.transform.scale={x:2,y:1,z:1};d.objects.push(parent);addPhysicsObject(d,'Floor','passive',[0,0,0],[5,5,.1]);
  const drop=addPhysicsObject(d,'Drop','active',[0,0,2],[.25,.25,.8]);drop.transform.rotationEuler.y=.55;Object.assign(drop,{parent:'Stretch'});
  let error='';try{await bake(await kernel(),d,1,180,60);}catch(e){error=String(e);}assert(error.includes('nonsheared frame'),'unsupported local shear is explicit');
});
h.test('physics fractional track sampling interpolates positions',()=>{
  assertDeepEqual(sampleTrack([[0,0,0],[2,4,6]],.25),[.5,1,1.5],'fractional frame interpolation');
});

const logDir=join(__dirname,'../model3d-kernel-logs');mkdirSync(logDir,{recursive:true});
void h.finish(join(logDir,'geometry-results.json'),'model3d-kernel-geometry').then(code=>{process.exitCode=code;});
