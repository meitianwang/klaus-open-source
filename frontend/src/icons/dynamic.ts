// Runtime context usage is drawn as a neutral track and a clockwise progress arc.
export function contextPieSvg(pct: number): string {
  const used = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0
  return `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">`
    + `<circle cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="2" opacity="0.16"/>`
    + `<circle class="ctx-usage-progress" cx="6" cy="6" r="5" fill="none" stroke="currentColor" stroke-width="2"`
    + ` stroke-linecap="round" pathLength="100" stroke-dasharray="100" stroke-dashoffset="${100 - used}"`
    + ` opacity="${used === 0 ? 0 : 1}" transform="rotate(-90 6 6)"/>`
    + `</svg>`
}

// 回合进度环（composer 上方的进度/审查胶囊用）：底圈是余量、弧线是已完成的
// 待办。饼图那种实心扇区在这里读不出「差多少」，所以走环形而不是复用上面的
// 生成器。弧长靠 stroke-dasharray 走一圈周长，不手算 path 端点。
export function progressRingSvg(pct: number): string {
  const r = 5.5
  const circumference = 2 * Math.PI * r
  const ratio = Math.max(0, Math.min(1, pct / 100))
  const dash = (circumference * ratio).toFixed(3)
  const gap = (circumference * (1 - ratio)).toFixed(3)
  return `<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">`
    + `<circle cx="7" cy="7" r="${r}" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.25"/>`
    + `<circle cx="7" cy="7" r="${r}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"`
    + ` stroke-dasharray="${dash} ${gap}" transform="rotate(-90 7 7)"/>`
    + `</svg>`
}
