// Shared SVG escaping. render.ts is the single trust boundary for the panel's
// innerHTML injection: every document-sourced string reaching the markup goes
// through these two functions. chart.ts must use the same pair so the boundary
// stays exactly one definition wide.

/** SVG 文本节点转义。`&` 必须先换，否则会二次转义已生成的实体。 */
export function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;')
}
