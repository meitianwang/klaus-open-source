export interface ShortcutEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}
export function shortcutLabel(value: string, macOS: boolean): string {
  return value
    .replaceAll("CommandOrControl", macOS ? "⌘" : "Ctrl")
    .replaceAll("Super", macOS ? "⌘" : "Win")
    .replaceAll("Alt", macOS ? "⌥" : "Alt")
    .replaceAll("Shift", "⇧")
    .replaceAll("+", " ");
}
export function captureShortcut(event: ShortcutEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(event.key)) return null;
  if (event.key === "Backspace" || event.key === "Delete") return "";
  const parts: string[] = [];
  if (event.metaKey) parts.push("Super");
  if (event.ctrlKey) parts.push("Control");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  const key =
    event.code === "Space"
      ? "Space"
      : event.key.length === 1
        ? event.key.toUpperCase()
        : event.key;
  if (key === "Escape" || key === "Tab") return null;
  if (!parts.length && !/^F\d+$/.test(key)) return null;
  return [...parts, key].join("+");
}
