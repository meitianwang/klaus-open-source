const metrics = ['boxSizing', 'width', 'height', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'letterSpacing', 'lineHeight', 'textAlign', 'textIndent', 'textTransform', 'wordSpacing', 'tabSize', 'direction'] as const;

/** Measures the selected textarea caret in viewport coordinates using its actual layout metrics. */
export function textareaCaretPoint(input: HTMLTextAreaElement): { x: number; y: number } | null {
  if (document.activeElement !== input) return null;
  const style = getComputedStyle(input), rect = input.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const mirror = document.createElement('div'), marker = document.createElement('span');
  for (const key of metrics) mirror.style[key] = style[key];
  Object.assign(mirror.style, { position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`, margin: '0', visibility: 'hidden', pointerEvents: 'none', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden' });
  const caret = input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd;
  mirror.textContent = input.value.slice(0, caret ?? input.value.length);
  marker.textContent = '\u200b'; mirror.appendChild(marker); mirror.appendChild(document.createTextNode(input.value.slice(caret ?? input.value.length))); document.body.appendChild(mirror);
  try {
    mirror.scrollTop = input.scrollTop; mirror.scrollLeft = input.scrollLeft;
    const position = marker.getBoundingClientRect(), lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
    return { x: Math.max(rect.left, Math.min(rect.right, position.left)), y: Math.max(rect.top, Math.min(rect.bottom, position.top + lineHeight / 2)) };
  } finally { mirror.remove(); }
}
