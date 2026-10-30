export type PetAnimation =
  | "failed"
  | "idle"
  | "jumping"
  | "review"
  | "running"
  | "running-left"
  | "running-right"
  | "waving"
  | "waiting";
export interface PetFrame {
  row: number;
  column: number;
  duration: number;
}
export const SPRITE = {
  columns: 8,
  cellWidth: 192,
  cellHeight: 208,
  width: 1536,
  v1Height: 1872,
  v2Height: 2288,
} as const;
const row = (
  index: number,
  count: number,
  duration: number,
  last: number,
): PetFrame[] =>
  Array.from({ length: count }, (_, column) => ({
    row: index,
    column,
    duration: column === count - 1 ? last : duration,
  }));
const idle = [280, 110, 110, 140, 140, 320].map((duration, column) => ({
  row: 0,
  column,
  duration,
}));
export const IDLE_FRAMES = idle.map((frame) => ({
  ...frame,
  duration: frame.duration * 6,
}));
export const ANIMATIONS: Record<PetAnimation, readonly PetFrame[]> = {
  failed: row(5, 8, 140, 240),
  idle,
  jumping: row(4, 5, 140, 280),
  review: row(8, 6, 150, 280),
  running: row(7, 6, 120, 220),
  "running-left": row(2, 8, 120, 220),
  "running-right": row(1, 8, 120, 220),
  waving: row(3, 4, 140, 280),
  waiting: row(6, 6, 150, 260),
};
export function animationSequence(
  state: PetAnimation,
  reducedMotion: boolean,
  loop = false,
): { frames: readonly PetFrame[]; loopStart: number | null } {
  const frames = ANIMATIONS[state];
  if (reducedMotion) return { frames: [frames[0]!], loopStart: null };
  if (state === "idle") return { frames: IDLE_FRAMES, loopStart: 0 };
  if (loop) return { frames, loopStart: 0 };
  const start = [...frames, ...frames, ...frames];
  return { frames: [...start, ...IDLE_FRAMES], loopStart: start.length };
}
export function lookFrame(
  rect: { left: number; top: number; width: number; height: number },
  pointer: { x: number; y: number },
  version: 1 | 2,
): PetFrame | null {
  if (version !== 2) return null;
  const x = pointer.x - rect.left - rect.width / 2,
    y = pointer.y - rect.top - rect.height / 2;
  if (Math.hypot(x, y) <= 1) return null;
  const direction =
    Math.round((((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360) / 22.5) % 16;
  return {
    row: 9 + Math.floor(direction / 8),
    column: direction % 8,
    duration: 0,
  };
}
export function framePosition(frame: PetFrame, version: 1 | 2): string {
  return `${(frame.column / 7) * 100}% ${(frame.row / ((version === 2 ? 11 : 9) - 1)) * 100}%`;
}
