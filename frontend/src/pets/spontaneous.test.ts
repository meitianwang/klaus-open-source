import { describe, expect, test } from "bun:test";
import { ANIMATIONS } from "./animation";
import {
  ONE_SHOT_LOOPS,
  SPONTANEOUS_ANIMATIONS,
  SPONTANEOUS_DELAY_MS,
  oneShotDuration,
  pickSpontaneousAnimation,
  spontaneousAllowed,
  spontaneousDelay,
  type SpontaneousGate,
} from "./spontaneous";

const quiet: SpontaneousGate = {
  visible: true,
  menuOpen: false,
  stashed: false,
  editing: false,
  voicePanel: false,
  attachmentMenu: false,
  greeting: false,
  reducedMotion: false,
  busyTasks: 0,
  reacting: false,
};

describe("desktop pet spontaneous behaviour", () => {
  test("the quiet wait stays inside the declared cadence window", () => {
    for (const random of [0, 0.25, 0.5, 0.999999]) {
      const delay = spontaneousDelay(() => random);
      expect(delay).toBeGreaterThanOrEqual(SPONTANEOUS_DELAY_MS.min);
      expect(delay).toBeLessThanOrEqual(SPONTANEOUS_DELAY_MS.max);
    }
    expect(spontaneousDelay(() => 0)).toBe(SPONTANEOUS_DELAY_MS.min);
    expect(spontaneousDelay(() => 0.999999)).toBe(SPONTANEOUS_DELAY_MS.max);
  });
  test("picks stay inside the reaction set and never repeat the last one", () => {
    let previous: (typeof SPONTANEOUS_ANIMATIONS)[number] | null = null;
    for (let index = 0; index < 400; index += 1) {
      const next = pickSpontaneousAnimation(Math.random, previous);
      expect(SPONTANEOUS_ANIMATIONS.includes(next)).toBe(true);
      expect(next).not.toBe(previous);
      previous = next;
    }
  });
  test("every reaction is a known one-shot animation of three loops", () => {
    for (const name of SPONTANEOUS_ANIMATIONS)
      expect(ANIMATIONS[name]).toBeDefined();
    // jumping: 4 frames of 140ms plus a 280ms hold, three times.
    expect(oneShotDuration("jumping")).toBe(ONE_SHOT_LOOPS * (140 * 4 + 280));
    expect(oneShotDuration("running")).toBe(ONE_SHOT_LOOPS * (120 * 5 + 220));
  });
  test("the gate opens only while everything is quiet", () => {
    expect(spontaneousAllowed(quiet)).toBe(true);
    const flips: Array<[keyof SpontaneousGate, boolean | number]> = [
      ["visible", false],
      ["menuOpen", true],
      ["stashed", true],
      ["editing", true],
      ["voicePanel", true],
      ["attachmentMenu", true],
      ["greeting", true],
      ["reducedMotion", true],
      ["busyTasks", 1],
      ["reacting", true],
    ];
    for (const [key, value] of flips)
      expect(spontaneousAllowed({ ...quiet, [key]: value })).toBe(false);
  });
});
