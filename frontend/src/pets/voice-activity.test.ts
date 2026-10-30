import { describe, expect, test } from "bun:test";
import { VoiceActivityDetector } from "./voice-activity";
const audio = (amplitude: number, milliseconds = 100) => {
  const bytes = new ArrayBuffer(((16000 * milliseconds) / 1000) * 2);
  const view = new DataView(bytes);
  for (let index = 0; index < bytes.byteLength; index += 2)
    view.setInt16(index, Math.sin(index * 0.1) * amplitude * 32767, true);
  return bytes;
};
describe("live spoken turn segmentation", () => {
  test("background noise never creates a spoken turn", () => {
    const detector = new VoiceActivityDetector();
    for (let index = 0; index < 80; index++) {
      const result = detector.push(audio(0.004));
      expect(result.speechStarted).toBe(false);
      expect(result.utteranceEnded).toBe(false);
    }
  });
  test("sustained speech starts once and silence closes one complete utterance", () => {
    const detector = new VoiceActivityDetector();
    expect(detector.push(audio(0.25)).speechStarted).toBe(false);
    expect(detector.push(audio(0.25)).speechStarted).toBe(true);
    for (let index = 0; index < 7; index++)
      expect(detector.push(audio(0)).utteranceEnded).toBe(false);
    expect(detector.push(audio(0))).toMatchObject({
      speechStarted: false,
      utteranceEnded: true,
      reason: "silence",
    });
    expect(detector.push(audio(0))).toMatchObject({
      speechStarted: false,
      utteranceEnded: false,
    });
  });
  test("brief pauses preserve the current turn while a bounded long turn finalizes", () => {
    const detector = new VoiceActivityDetector({ maximumMs: 1000 });
    detector.push(audio(0.3));
    detector.push(audio(0.3));
    for (let index = 0; index < 4; index++)
      expect(detector.push(audio(0)).utteranceEnded).toBe(false);
    for (let index = 0; index < 4; index++)
      expect(detector.push(audio(0.3)).utteranceEnded).toBe(false);
    expect(detector.push(audio(0.3))).toMatchObject({
      utteranceEnded: true,
      reason: "maximum",
    });
  });
  test("a partial final PCM frame contributes its actual duration", () => {
    const detector = new VoiceActivityDetector({
      startMs: 150,
      silenceMs: 150,
    });
    detector.push(audio(0.2));
    expect(detector.push(audio(0.2, 50)).speechStarted).toBe(true);
    expect(detector.push(audio(0, 50)).utteranceEnded).toBe(false);
    expect(detector.push(audio(0))).toMatchObject({
      utteranceEnded: true,
      reason: "silence",
    });
    expect(() => detector.push(new ArrayBuffer(3))).toThrow(
      "incomplete PCM sample",
    );
  });
});
