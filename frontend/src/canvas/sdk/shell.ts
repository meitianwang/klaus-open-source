// How a canvas asks the window to frame it.
//
// Types only — there is nothing to call. A canvas declares
//
//   export const canvasConfig: CanvasRuntimeConfig = { shell: { mode: 'full-bleed' } }
//
// and the window reads that named export after evaluating the module. It cannot
// be a hook: the frame has to know the shell before the first render, and a hook
// only speaks during one.
//
// This lives in the SDK rather than beside the loader that reads it because the
// SDK's `.d.ts` output IS the authoring contract. A canvas has to be able to
// import the type it is annotating, and the SDK declaration build is rooted at
// this directory — a type defined outside it could not be re-exported.

/**
 * `inset` is the default: the frame supplies page padding and a reading-width cap,
 * which is right for a report and wrong for anything that paints to the edge. A
 * slide deck, a full-bleed diagram, or a canvas reproducing a design mock has to
 * draw into the corners, and with padding baked into the frame it simply cannot —
 * so the canvas declares its own shell instead of fighting the frame's CSS with
 * negative margins.
 */
export type CanvasShellMode = 'inset' | 'full-bleed'

export interface CanvasShellConfig {
  mode?: CanvasShellMode
  /** Overrides the frame's padding. Any CSS length; a number means px. */
  padding?: string | number
  background?: string
  color?: string
  fontFamily?: string
  fontSize?: string | number
  lineHeight?: string | number
}

export interface CanvasRuntimeConfig {
  shell?: CanvasShellConfig
}
