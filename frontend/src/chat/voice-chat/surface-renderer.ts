import surfaceVertex from './surface.vert.glsl?raw';
import surfaceFragment from './surface.frag.glsl?raw';
import maskVertex from './mask.vert.glsl?raw';
import maskFragment from './mask.frag.glsl?raw';

export interface VoiceSurfaceFrame {
  waveFrame: number; baseShaderFrame: number; waveAmplitude: number; textureFlowFrame: number;
  textureEdgeWarp: number; listeningTextureNoiseScale: number;
  speakingWatercolorOffset0: number[]; speakingWatercolorOffset1: number[]; speakingWatercolorOffset2: number[];
  accentColor: number[]; micLevel: number; surfaceScale: number; userSpeakingScale: number;
  connectionRevealAmount: number; preConnectionDotVisibility: number; preConnectionDotColor: number[];
}

function createProgram(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram(); if (!program) throw new Error('Voice visualization is unavailable');
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type); if (!shader) throw new Error('Voice visualization is unavailable');
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { const error = gl.getShaderInfoLog(shader); gl.deleteShader(shader); throw new Error(error || 'Voice visualization could not initialize'); }
    gl.attachShader(program, shader); gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { const error = gl.getProgramInfoLog(program); gl.deleteProgram(program); throw new Error(error || 'Voice visualization could not initialize'); }
  return program;
}

/** Separates the animated material from full resolution, premultiplied edge coverage. */
export class VoiceSurfaceRenderer {
  private readonly surface: WebGLProgram;
  private readonly mask: WebGLProgram;
  private readonly positions: WebGLBuffer;
  private readonly generated: WebGLBuffer;
  private readonly paper: WebGLTexture;
  private readonly interior: WebGLTexture;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly uniformBuffer: WebGLBuffer;
  private readonly data: Float32Array;
  private readonly fields: Array<{ key: keyof VoiceSurfaceFrame; offset: number }>;
  private size = 0;
  constructor(private readonly gl: WebGL2RenderingContext, image: HTMLImageElement) {
    this.surface = createProgram(gl, surfaceVertex, surfaceFragment); this.mask = createProgram(gl, maskVertex, maskFragment);
    this.positions = this.buffer(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
    this.generated = this.buffer(new Float32Array([0, 0, .5, 1, 0, .5, 0, 1, .5, 0, 1, .5, 1, 0, .5, 1, 1, .5]));
    this.paper = gl.createTexture()!; gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.paper);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1); gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image); gl.generateMipmap(gl.TEXTURE_2D);
    this.interior = gl.createTexture()!; gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.interior);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.framebuffer = gl.createFramebuffer()!; gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.interior, 0);
    const block = gl.getUniformBlockIndex(this.surface, 'VoiceSurfaceUniforms');
    this.data = new Float32Array(gl.getActiveUniformBlockParameter(this.surface, block, gl.UNIFORM_BLOCK_DATA_SIZE) / 4);
    const indices = gl.getActiveUniformBlockParameter(this.surface, block, gl.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES) as number[];
    const offsets = gl.getActiveUniforms(this.surface, indices, gl.UNIFORM_OFFSET) as number[];
    this.fields = Array.from(indices, (index, position) => ({ key: gl.getActiveUniform(this.surface, index)!.name.split('.').at(-1)! as keyof VoiceSurfaceFrame, offset: offsets[position]! / 4 }));
    this.uniformBuffer = gl.createBuffer()!; gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniformBuffer); gl.bufferData(gl.UNIFORM_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW); gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this.uniformBuffer); gl.uniformBlockBinding(this.surface, block, 0);
    gl.useProgram(this.surface); gl.uniform1i(gl.getUniformLocation(this.surface, 'uPaperTexture'), 0);
    gl.useProgram(this.mask); gl.uniform1i(gl.getUniformLocation(this.mask, 'uInteriorTexture'), 1);
  }
  private buffer(data: Float32Array): WebGLBuffer { const gl = this.gl, buffer = gl.createBuffer()!; gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return buffer; }
  private attributes(program: WebGLProgram, material: boolean): void {
    const gl = this.gl, position = gl.getAttribLocation(program, 'aPosition');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions); gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    if (material) { const generated = gl.getAttribLocation(program, 'aGenerated'); gl.bindBuffer(gl.ARRAY_BUFFER, this.generated); gl.enableVertexAttribArray(generated); gl.vertexAttribPointer(generated, 3, gl.FLOAT, false, 0, 0); }
  }
  draw(frame: VoiceSurfaceFrame): void {
    const gl = this.gl, size = gl.drawingBufferWidth;
    if (this.size !== size) { this.size = size; gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.interior); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer); gl.viewport(0, 0, size, size); gl.useProgram(this.surface); this.attributes(this.surface, true);
    for (const { key, offset } of this.fields) { const value = frame[key]; if (typeof value === 'number') this.data[offset] = value; else if (value) this.data.set(value, offset); }
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniformBuffer); gl.bufferSubData(gl.UNIFORM_BUFFER, 0, this.data); gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.useProgram(this.mask); this.attributes(this.mask, false);
    for (const key of ['baseShaderFrame', 'micLevel', 'surfaceScale', 'userSpeakingScale', 'connectionRevealAmount', 'preConnectionDotVisibility'] as const) gl.uniform1f(gl.getUniformLocation(this.mask, `u${key[0]!.toUpperCase()}${key.slice(1)}`), frame[key]);
    gl.uniform4fv(gl.getUniformLocation(this.mask, 'uPreConnectionDotColor'), frame.preConnectionDotColor); gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  dispose(): void { const gl = this.gl; gl.deleteBuffer(this.positions); gl.deleteBuffer(this.generated); gl.deleteBuffer(this.uniformBuffer); gl.deleteTexture(this.paper); gl.deleteTexture(this.interior); gl.deleteFramebuffer(this.framebuffer); gl.deleteProgram(this.surface); gl.deleteProgram(this.mask); }
}
