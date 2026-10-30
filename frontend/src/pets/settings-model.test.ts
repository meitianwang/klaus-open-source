import { describe, expect, test } from "bun:test";
import {
  captureShortcut,
  shortcutLabel,
  type ShortcutEvent,
} from "./settings-model";
const key = (patch: Partial<ShortcutEvent>): ShortcutEvent => ({
  key: "p",
  code: "KeyP",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...patch,
});
describe("desktop companion shortcut editor", () => {
  test("captures physical Space and global modifier combinations", () => {
    expect(
      captureShortcut(key({ key: " ", code: "Space", altKey: true })),
    ).toBe("Alt+Space");
    expect(captureShortcut(key({ metaKey: true, altKey: true }))).toBe(
      "Super+Alt+P",
    );
    expect(captureShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(
      "Control+Shift+P",
    );
  });
  test("rejects plain typing, modifiers and navigation while allowing clear", () => {
    expect(captureShortcut(key({}))).toBeNull();
    expect(captureShortcut(key({ key: "Alt", altKey: true }))).toBeNull();
    expect(captureShortcut(key({ key: "Escape" }))).toBeNull();
    expect(captureShortcut(key({ key: "Backspace" }))).toBe("");
    expect(captureShortcut(key({ key: "F8", code: "F8" }))).toBe("F8");
  });
  test("renders platform-specific modifier labels", () => {
    expect(shortcutLabel("Alt+Space", true)).toBe("⌥ Space");
    expect(shortcutLabel("CommandOrControl+Shift+P", false)).toBe("Ctrl ⇧ P");
  });
});
