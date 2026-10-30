import { deflateSync, inflateSync } from 'node:zlib';
import type { Texture3D } from './model';

export interface TextureStroke { uv: number[]; radius: number; color: number[]; strength?: number; mode?:'paint'|'replace'|'erase' }
const SIGNATURE = Buffer.from([137,80,78,71,13,10,26,10]);
const MAX_PIXELS = 16_777_216;
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, bytes: Buffer): Buffer {
  const name = Buffer.from(type), out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length); name.copy(out,4); bytes.copy(out,8);
  out.writeUInt32BE(crc32(Buffer.concat([name,bytes])),bytes.length+8); return out;
}
function dimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS) throw new Error('Texture dimensions must be positive integers and at most 16 million pixels.');
}
function colorBytes(color: number[]): number[] {
  if (![3,4].includes(color.length) || color.some(v => !Number.isFinite(v) || v < 0 || v > 1)) throw new Error('Texture color must be RGB or RGBA values from 0 to 1.');
  return [...color.slice(0,3),color[3] ?? 1].map(v => Math.round(v*255));
}
export function encodeTexturePng(width: number,height: number,pixels: Uint8Array): Buffer {
  dimensions(width,height); if (pixels.length !== width*height*4) throw new Error('RGBA texture buffer length does not match its dimensions.');
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const stride=width*4, scanlines=Buffer.alloc((stride+1)*height);
  for(let y=0;y<height;y++)Buffer.from(pixels.buffer,pixels.byteOffset+y*stride,stride).copy(scanlines,y*(stride+1)+1);
  return Buffer.concat([SIGNATURE,chunk('IHDR',header),chunk('IDAT',deflateSync(scanlines)),chunk('IEND',Buffer.alloc(0))]);
}
export function decodeTexturePng(input: Buffer): {width:number;height:number;pixels:Uint8Array} {
  if(!input.subarray(0,8).equals(SIGNATURE))throw new Error('Texture painting currently requires an 8-bit RGB/RGBA PNG source.');
  let offset=8,width=0,height=0,channels=0,ended=false;const compressed:Buffer[]=[];
  while(offset+12<=input.length){
    const size=input.readUInt32BE(offset),type=input.toString('ascii',offset+4,offset+8);
    if(size>input.length-offset-12)throw new Error('Truncated PNG chunk.');
    const data=input.subarray(offset+8,offset+8+size);
    if(crc32(input.subarray(offset+4,offset+8+size))!==input.readUInt32BE(offset+8+size))throw new Error('PNG checksum mismatch.');
    if(type==='IHDR'){
      if(size!==13 || width)throw new Error('Invalid PNG header.');
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);dimensions(width,height);
      if(data[8]!==8 || ![2,6].includes(data[9]!) || data[10]!==0 || data[11]!==0 || data[12]!==0)throw new Error('Texture painting supports non-interlaced 8-bit RGB/RGBA PNG images.');
      channels=data[9]===6?4:3;
    } else if(type==='IDAT')compressed.push(data);
    else if(type==='IEND'){ended=true;break;}
    offset+=size+12;
  }
  if(!width || !compressed.length || !ended)throw new Error('PNG is missing header, pixels or terminator.');
  const stride=width*channels,expected=(stride+1)*height;
  const raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});
  if(raw.length!==expected)throw new Error('PNG scanline length mismatch.');
  const decoded=new Uint8Array(stride*height),pixels=new Uint8Array(width*height*4);
  const paeth=(a:number,b:number,c:number):number=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){
    const filter=raw[y*(stride+1)]!;if(filter>4)throw new Error('Invalid PNG filter.');
    for(let x=0;x<stride;x++){
      const a=x>=channels?decoded[y*stride+x-channels]!:0,b=y?decoded[(y-1)*stride+x]!:0,c=y&&x>=channels?decoded[(y-1)*stride+x-channels]!:0;
      const predictor=filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0;
      decoded[y*stride+x]=(raw[y*(stride+1)+x+1]!+predictor)&255;
    }
  }
  for(let i=0;i<width*height;i++){pixels[i*4]=decoded[i*channels]!;pixels[i*4+1]=decoded[i*channels+1]!;pixels[i*4+2]=decoded[i*channels+2]!;pixels[i*4+3]=channels===4?decoded[i*channels+3]!:255;}
  return {width,height,pixels};
}
export function createTexture(name:string,width:number,height:number,color:number[]):Texture3D {
  dimensions(width,height);const rgba=colorBytes(color),pixels=new Uint8Array(width*height*4);
  for(let i=0;i<pixels.length;i+=4)pixels.set(rgba,i);
  return {name,mimeType:'image/png',dataBase64:encodeTexturePng(width,height,pixels).toString('base64')};
}
export function paintTexture(texture:Texture3D,strokes:TextureStroke[]):{texture:Texture3D;pixelsChanged:number} {
  if(!strokes.length || strokes.length>512)throw new Error('Texture painting accepts 1 to 512 strokes.');
  const image=decodeTexturePng(Buffer.from(texture.dataBase64,'base64')),changed=new Set<number>();
  for(const stroke of strokes){
    if(stroke.mode!==undefined&&!['paint','replace','erase'].includes(stroke.mode))throw new Error('Texture brush mode must be paint, replace or erase.');
    if(stroke.uv.length!==2 || stroke.uv.some(v=>!Number.isFinite(v)) || !Number.isFinite(stroke.radius) || stroke.radius<=0 || stroke.radius>1)throw new Error('A texture stroke needs a finite UV pair and a radius from 0 to 1.');
    const color=colorBytes(stroke.color),strength=stroke.strength??1;
    if(!Number.isFinite(strength) || strength<0 || strength>1)throw new Error('Texture stroke strength must be from 0 to 1.');
    const cx=stroke.uv[0]!*(image.width-1),cy=(1-stroke.uv[1]!)*(image.height-1),radius=stroke.radius*Math.max(image.width,image.height);
    for(let y=Math.max(0,Math.floor(cy-radius));y<=Math.min(image.height-1,Math.ceil(cy+radius));y++)for(let x=Math.max(0,Math.floor(cx-radius));x<=Math.min(image.width-1,Math.ceil(cx+radius));x++){
      const distance=Math.hypot(x-cx,y-cy);if(distance>radius)continue;
      const coverage=(1-distance/radius)**2*strength,weight=coverage*(color[3]!/255),pixel=y*image.width+x;
      if(stroke.mode==='erase'){
        const alpha=Math.round(image.pixels[pixel*4+3]!*(1-coverage));
        if(alpha!==image.pixels[pixel*4+3]){image.pixels[pixel*4+3]=alpha;changed.add(pixel);}continue;
      }
      if(stroke.mode==='replace'){
        let change=false;for(let c=0;c<4;c++){const before=image.pixels[pixel*4+c]!,after=Math.round(before*(1-coverage)+color[c]!*coverage);image.pixels[pixel*4+c]=after;change ||= before!==after;}if(change)changed.add(pixel);continue;
      }
      if(weight===0)continue;
      const oldAlpha=image.pixels[pixel*4+3]!/255,newAlpha=weight+oldAlpha*(1-weight);
      let actualChange=false;
      for(let c=0;c<3;c++){
        const before=image.pixels[pixel*4+c]!,after=Math.round((color[c]!*weight+before*oldAlpha*(1-weight))/newAlpha);
        image.pixels[pixel*4+c]=after;actualChange ||= before!==after;
      }
      const alpha=Math.round(newAlpha*255);actualChange ||= image.pixels[pixel*4+3]!==alpha;image.pixels[pixel*4+3]=alpha;
      if(actualChange)changed.add(pixel);
    }
  }
  return {texture:{...texture,mimeType:'image/png',dataBase64:encodeTexturePng(image.width,image.height,image.pixels).toString('base64')},pixelsChanged:changed.size};
}
