import { ANIMATIONS, type PetAnimation } from "./animation";

/**
 * Reactions she may start on her own while nobody is interacting with her, so
 * an untouched companion still feels alive between breathing frames.
 */
export const SPONTANEOUS_ANIMATIONS: readonly PetAnimation[] = [
  "jumping",
  "waving",
  "waiting",
  "running",
];

/** Random wait between two self-started reactions: 45s to 3min. */
export const SPONTANEOUS_DELAY_MS = { min: 45000, max: 180000 } as const;

/** A self-started reaction plays three loops, then she settles back to idle. */
export const ONE_SHOT_LOOPS = 3;

export function spontaneousDelay(random: () => number): number {
  const span = SPONTANEOUS_DELAY_MS.max - SPONTANEOUS_DELAY_MS.min;
  return SPONTANEOUS_DELAY_MS.min + Math.floor(random() * (span + 1));
}

/** Uniform pick that never repeats the reaction she just did. */
export function pickSpontaneousAnimation(
  random: () => number,
  previous: PetAnimation | null = null,
): PetAnimation {
  const pool = SPONTANEOUS_ANIMATIONS.filter((name) => name !== previous);
  return pool[Math.floor(random() * pool.length)]!;
}

/** Wall-clock length of one reaction: three loops of its frame durations. */
export function oneShotDuration(state: PetAnimation): number {
  return (
    ONE_SHOT_LOOPS *
    ANIMATIONS[state].reduce((total, frame) => total + frame.duration, 0)
  );
}

export type PetTaskStatus = "running" | "waiting" | "completed" | "failed";

/**
 * Precedence for what she is doing right now: an interaction-driven reaction
 * wins, then a self-started one, then the busiest task's state, then the wake
 * wave, and finally breathing.
 */
export function resolveActiveAnimation(input: {
  reaction: PetAnimation | null;
  spontaneous: PetAnimation | null;
  topTaskStatus: PetTaskStatus | undefined;
  firstAwake: boolean;
}): PetAnimation {
  const { reaction, spontaneous, topTaskStatus, firstAwake } = input;
  if (reaction) return reaction;
  if (spontaneous) return spontaneous;
  if (topTaskStatus === "completed") return "review";
  if (topTaskStatus) return topTaskStatus;
  return firstAwake ? "waving" : "idle";
}

/** Everything that must be quiet before she may start something on her own. */
export interface SpontaneousGate {
  visible: boolean;
  menuOpen: boolean;
  stashed: boolean;
  editing: boolean;
  voicePanel: boolean;
  attachmentMenu: boolean;
  greeting: boolean;
  reducedMotion: boolean;
  busyTasks: number;
  /** An interaction-driven reaction is already playing. */
  reacting: boolean;
}

export function spontaneousAllowed(gate: SpontaneousGate): boolean {
  return (
    gate.visible &&
    !gate.menuOpen &&
    !gate.stashed &&
    !gate.editing &&
    !gate.voicePanel &&
    !gate.attachmentMenu &&
    !gate.greeting &&
    !gate.reducedMotion &&
    !gate.reacting &&
    gate.busyTasks === 0
  );
}
