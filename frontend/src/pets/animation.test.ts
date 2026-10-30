import { describe, expect, test } from "bun:test";
import {
  animationSequence,
  ANIMATIONS,
  framePosition,
  lookFrame,
  SPRITE,
} from "./animation";

describe("desktop pet animation contract", () => {
  test("sprite sheets preserve the complete supported grid", () => {
    expect(SPRITE.columns * SPRITE.cellWidth).toBe(1536);
    expect(SPRITE.cellHeight * 9).toBe(1872);
    expect(SPRITE.cellHeight * 11).toBe(2288);
    expect(
      Object.values(ANIMATIONS).map((frames) => [frames[0].row, frames.length]),
    ).toEqual([
      [5, 8],
      [0, 6],
      [4, 5],
      [8, 6],
      [7, 6],
      [2, 8],
      [1, 8],
      [3, 4],
      [6, 6],
    ]);
  });
  test("reactions play three times then continue the slow idle loop", () => {
    const sequence = animationSequence("jumping", false);
    expect(sequence.loopStart).toBe(15);
    expect(sequence.frames.slice(0, 5).map((frame) => frame.duration)).toEqual([
      140, 140, 140, 140, 280,
    ]);
    expect(sequence.frames.slice(15).map((frame) => frame.duration)).toEqual([
      1680, 660, 660, 840, 840, 1920,
    ]);
    expect(animationSequence("waiting", false, true).loopStart).toBe(0);
  });
  test("reduced motion uses a single static state frame", () => {
    for (const state of Object.keys(ANIMATIONS) as Array<
      keyof typeof ANIMATIONS
    >) {
      const sequence = animationSequence(state, true);
      expect(sequence.frames).toEqual([ANIMATIONS[state][0]]);
      expect(sequence.loopStart).toBeNull();
    }
  });
  test("all sixteen cursor directions resolve to independent gaze frames", () => {
    const rect = { left: 0, top: 0, width: 192, height: 208 };
    for (let index = 0; index < 16; index++) {
      const radians = (index * Math.PI) / 8;
      expect(
        lookFrame(
          rect,
          { x: 96 + Math.sin(radians) * 300, y: 104 - Math.cos(radians) * 300 },
          2,
        ),
      ).toEqual({
        row: 9 + Math.floor(index / 8),
        column: index % 8,
        duration: 0,
      });
    }
    expect(lookFrame(rect, { x: 96, y: 104 }, 2)).toBeNull();
    expect(lookFrame(rect, { x: 900, y: 900 }, 1)).toBeNull();
    expect(framePosition({ row: 10, column: 7, duration: 0 }, 2)).toBe(
      "100% 100%",
    );
  });
});
