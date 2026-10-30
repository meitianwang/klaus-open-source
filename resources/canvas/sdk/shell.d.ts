/**
 * `inset` is the default: the frame supplies page padding and a reading-width cap,
 * which is right for a report and wrong for anything that paints to the edge. A
 * slide deck, a full-bleed diagram, or a canvas reproducing a design mock has to
 * draw into the corners, and with padding baked into the frame it simply cannot —
 * so the canvas declares its own shell instead of fighting the frame's CSS with
 * negative margins.
 */
export type CanvasShellMode = 'inset' | 'full-bleed';
export interface CanvasShellConfig {
    mode?: CanvasShellMode;
    /** Overrides the frame's padding. Any CSS length; a number means px. */
    padding?: string | number;
    background?: string;
    color?: string;
    fontFamily?: string;
    fontSize?: string | number;
    lineHeight?: string | number;
}
export interface CanvasRuntimeConfig {
    shell?: CanvasShellConfig;
}
