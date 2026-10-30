import { SHAPES, TONES } from './model';
import type { Data } from '../visuals/data';

export function digramTools(): Data[] {
  const string = { type:'string' }; const number = { type:'number' };
  const id = { ...string,description:'Diagram id. Omit for the newest diagram in this task.' };
  const openId = { ...string,description:'Existing diagram id to reopen. Omit to create a new diagram.' };
  const page = { ...string,description:'Page id or zero-based index as a string. Omit for the first page.' };
  const node = {type:'object',properties:{id:string,shape:{type:'string',enum:SHAPES},x:number,y:number,w:number,h:number,label:string,tone:{type:'string',enum:TONES},variant:{type:'string',enum:['soft','solid','outline','ghost']},icon:string,parent:string,labelAlign:{type:'string',enum:['start','center','end']},labelValign:{type:'string',enum:['top','middle','bottom']},labelPlacement:{type:'string',enum:['inside','below','above']},fontWeight:{type:'string',enum:['regular','medium']},fontSize:number,radius:number,rotate:number,z:number},required:['id','x','y','w','h']};
  const edge = {type:'object',properties:{id:string,from:string,to:string,label:string,tone:{type:'string',enum:TONES},route:{type:'string',enum:['orthogonal','straight','curve']},fromSide:{type:'string',enum:['auto','top','right','bottom','left']},toSide:{type:'string',enum:['auto','top','right','bottom','left']},dash:{type:'boolean'},arrowFrom:{type:'string',enum:['none','arrow','dot','diamond']},arrowTo:{type:'string',enum:['none','arrow','dot','diamond']},waypoints:{type:'array',items:{type:'object',properties:{x:number,y:number},required:['x','y']}}},required:['id','from','to']};
  const spec = (name: string,description: string,properties: Data,required: string[]=[]): Data => ({name,description,inputSchema:{type:'object',properties,...(required.length?{required}:{})}});
  return [
    spec('digram_open','Create a diagram, or reopen its id. Returns id, document and artifact for the editable work panel.',{id:openId,title:string}),
    spec('digram_get','Read the complete current document before editing an existing diagram; retain its version to avoid overwriting a user drag.',{id}),
    spec('digram_edit','Apply ordered edits atomically. update* uses a partial patch; null clears optional fields. Geometry x/y/w/h is authoritative. Use group nodes with child parent ids for layers. Read the current document first and pass expectedVersion.',{id,expectedVersion:number,ops:{type:'array',items:{type:'object',properties:{op:{type:'string',enum:['addNode','updateNode','deleteNode','addEdge','updateEdge','deleteEdge','setPageOptions','addPage','deletePage','setTitle']},page:{type:'string',description:'Page id/index; addPage instead takes a page object.'},id:string,node,edge,patch:{type:'object'},title:string},required:['op']}}},['ops']),
    spec('digram_inspect','Read a compact list of cell ids, shapes, labels and geometry.',{id,page}),
    spec('digram_layout','Arrange boxes by layers, tree, left-to-right flow or a wrapping grid, preserving component sizes.',{id,page,kind:{type:'string',enum:['layers','tree','flow','grid']},direction:{type:'string',enum:['down','right']},gap:number},['kind']),
    spec('digram_icons_search','Search bundled technology, cloud, data and people glyphs; returned keys work with shape icon.',{query:string,limit:{...number,default:40}}),
    spec('digram_icon_get','Read the SVG path for a catalog key or inline path: value.',{key:string},['key']),
    spec('digram_export','Export a requested PNG/JPG/SVG file, or the digram JSON source, and return its path. Export only when the user asks for a file; the panel shows the live diagram.',{id,format:{type:'string',enum:['png','jpg','svg','digram'],default:'png'},scale:{...number,default:2}}),
    spec('digram_history','Read past version numbers and timestamps for a later revert.',{id}),
    spec('digram_revert','Restore a historical version as a new revision, so the revert itself can be undone.',{id,version:number},['version']),
  ];
}
