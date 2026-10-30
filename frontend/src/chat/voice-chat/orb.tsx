import { useEffect, useRef } from 'react';
import watercolorUrl from './watercolor.webp';
import { VoiceSurfaceRenderer } from './surface-renderer';

export interface VoiceOrbInputs { microphone: number; output: number; outputBands?: number[]; activity: string; muted: boolean; reducedMotion?: boolean }
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number, target: number, delta: number, attack: number, release: number) => value + (target - value) * (1 - Math.exp(-delta / (target > value ? attack : release)));

/** Owns the GPU material, audio smoothing, resize and graphics-loss fallback. */
export function VoiceOrb({ inputs }: { inputs: VoiceOrbInputs }) {
  const canvas = useRef<HTMLCanvasElement>(null), latest = useRef(inputs); latest.current = inputs;
  useEffect(() => {
    const element = canvas.current!;
    let disposed = false, frame = 0, fallback: HTMLCanvasElement | undefined, renderer: VoiceSurfaceRenderer | undefined;
    let microphone = 0, output = 0, previous = performance.now(), elapsed = 0, waveFrame = 350, textureFrame = 350;
    let speakingDrive = 0, speakingVelocity = 0, speakingBoost = 0, edgeWarp = 0, edgeVelocity = 0, amplitude = 1, flowBoost = 0;
    let scaleLevel = 0, listen = 0, speak = 0, think = 0;
    const cumulative = [0, 0, 0, 0], watercolor = [0, 0, 0], phases = [0, 2.1, 4.2];
    const fallbackDraw = () => {
      if (disposed) return;
      if (!fallback) { fallback = element.ownerDocument.createElement('canvas'); fallback.className = element.className; element.after(fallback); element.hidden = true; }
      const context = fallback.getContext('2d'); if (!context) return;
      const size = Math.max(1, Math.round(element.clientWidth * Math.min(devicePixelRatio, 2)));
      if (fallback.width !== size) fallback.width = fallback.height = size;
      context.clearRect(0, 0, size, size);
      const radius = size * .29 * (1 + clamp(latest.current.output) * .12), gradient = context.createLinearGradient(size * .3, size * .2, size * .65, size * .8);
      gradient.addColorStop(0, '#2758e2'); gradient.addColorStop(.46, '#658ce6'); gradient.addColorStop(1, '#b6c8fa');
      context.fillStyle = gradient; context.beginPath(); context.arc(size / 2, size / 2, radius, 0, Math.PI * 2); context.fill();
      frame = requestAnimationFrame(fallbackDraw);
    };
    const fail = () => { cancelAnimationFrame(frame); renderer?.dispose(); renderer = undefined; fallbackDraw(); };
    const lost = (event: Event) => { event.preventDefault(); fail(); }; element.addEventListener('webglcontextlost', lost);
    const initialize = async () => {
      try {
        const gl = element.getContext('webgl2', { alpha: true, premultipliedAlpha: true }); if (!gl) { fail(); return; }
        const image = new Image(); image.src = watercolorUrl; await image.decode(); if (disposed) return;
        renderer = new VoiceSurfaceRenderer(gl, image);
        const draw = (now: number) => {
          if (disposed || !renderer) return;
          const delta = Math.min(.05, Math.max(0, (now - previous) / 1000)); previous = now;
          const current = latest.current;
          if (!current.reducedMotion) elapsed += delta;
          microphone = smooth(microphone, current.muted ? 0 : clamp(current.microphone * 1.75), delta, .09, .3);
          output = smooth(output, clamp(current.output), delta, .045, .14);
          const speaking = current.activity === 'speaking', thinking = current.activity === 'thinking';
          listen = smooth(listen, speaking || thinking ? 0 : 1, delta, .28, .28);
          speak = smooth(speak, speaking ? 1 : 0, delta, .28, .28); think = smooth(think, thinking ? 1 : 0, delta, .28, .28);
          const bands = current.outputBands ?? [output, output, output, output];
          for (let index = 0; index < 4; index++) cumulative[index] += (bands[index] ?? 0) * delta * 60 * 40 * (1 - Math.exp(-delta / 2));
          const energy = output >= .024 ? clamp(Math.max(...cumulative) / 12) : 0, waveform = Math.pow(1 - Math.exp(-output * 4), 1.15);
          speakingDrive = smooth(speakingDrive, waveform, delta, .045, .14);
          const targetBoost = speakingDrive * .56 * (1.8 + Math.max(output, energy) * 4.6);
          const steps = Math.max(1, Math.ceil(delta * 120)), step = delta / steps;
          for (let index = 0; index < steps; index++) {
            speakingVelocity += ((targetBoost - speakingBoost) * Math.pow(Math.PI * 12, 2) - speakingVelocity * .76 * Math.PI * 24) * step; speakingBoost += speakingVelocity * step;
            edgeVelocity += ((microphone * .102 - edgeWarp) * Math.pow(Math.PI * 14, 2) - edgeVelocity * .36 * Math.PI * 28) * step; edgeWarp += edgeVelocity * step;
          }
          amplitude = smooth(amplitude, 1 + waveform * .5, delta, .1, .28); flowBoost = smooth(flowBoost, Math.max(output, energy) * .96, delta, .055, .16);
          const offsets = watercolor.map((value, index) => {
            watercolor[index] = smooth(value, output >= .024 ? clamp(cumulative[index]! / 12) : 0, delta, .07, .22);
            phases[index] += delta * .65 * [.72, 1, 1.28][index]! * (1 + watercolor[index]! * 1.5);
            return [Math.cos(phases[index]!) * watercolor[index]! * .1 + Math.sin(elapsed * .65 + index * 2.1) * energy * .3, Math.sin(phases[index]!) * watercolor[index]! * .1];
          });
          if (!current.reducedMotion) { waveFrame += delta * 24 * Math.max(.72, 1 + speakingBoost); textureFrame += delta * 24 * (1 + flowBoost); }
          scaleLevel = smooth(scaleLevel, output, delta, .09, .3);
          const normalized = clamp((scaleLevel - .04) / .42), scaleAudio = normalized * normalized * (3 - 2 * normalized);
          const state = Math.max(listen, speak, think), stateAmount = clamp(state / .9), stateEase = stateAmount * stateAmount * (3 - 2 * stateAmount);
          const radius = Math.min(.34, .34 * (.88 + .06 * think) * (.82 + .18 * stateEase) + scaleAudio * .34 * .12 + (1 - think) * (1 - scaleAudio) * (Math.sin(elapsed * Math.PI * .34) * .5 + .5) * .34 * .01);
          const size = Math.max(1, Math.round(element.clientWidth * Math.min(devicePixelRatio, 2)));
          if (element.width !== size) element.width = element.height = size;
          try {
            renderer.draw({ waveFrame, baseShaderFrame: 350 + elapsed * 24, waveAmplitude: amplitude, textureFlowFrame: textureFrame, textureEdgeWarp: edgeWarp, listeningTextureNoiseScale: 1 + microphone * 1.2,
              speakingWatercolorOffset0: offsets[0]!, speakingWatercolorOffset1: offsets[1]!, speakingWatercolorOffset2: offsets[2]!, accentColor: [53 / 255, 102 / 255, 240 / 255, 1],
              micLevel: microphone, surfaceScale: radius * 2, userSpeakingScale: microphone > .48 ? 1 : 0, connectionRevealAmount: 1, preConnectionDotVisibility: 0, preConnectionDotColor: [0, 0, 0, 1] });
          } catch { fail(); return; }
          element.dataset.renderer = 'webgl'; frame = requestAnimationFrame(draw);
        }; frame = requestAnimationFrame(draw);
      } catch { if (!disposed) fail(); }
    }; void initialize();
    return () => { disposed = true; cancelAnimationFrame(frame); fallback?.remove(); renderer?.dispose(); element.removeEventListener('webglcontextlost', lost); };
  }, []);
  return <canvas ref={canvas} className="voice-chat-orb" aria-hidden="true" />;
}
