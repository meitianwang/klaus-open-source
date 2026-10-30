// UI token audit — keeps the renderer stylesheets on the unified design scale.
//
// Scans frontend/css/*.css plus every src/**/*.module.css (Batch 5 拆出的
// 组件样式同受护栏，否则 module 化就成了 token 逃逸通道) and reports
// declarations that bypass the design tokens introduced during the UI
// consolidation:
//   - font-size: must be var(--text-*)/var(--code-font-size), an em-based
//     content-typography ratio, clamp(...) for responsive heroes, or inherit/0
//   - font-weight: must be var(--weight-*) or inherit
//   - border-radius: components must be var(--radius-*), 999px, 50%, or 0
//   - line-height: must use a leading token, 1/1.25/1.4/1.5/1.6, or px for fixed-height
//     controls, inherit, or normal
//   - no hex fallbacks inside var(--fg/--bg/--accent/--danger/--warning/
//     --success/--info) — tokens are always defined, fallbacks drifted once
//   - the specific off-palette hexes removed during consolidation must not
//     come back
//   - every animation name a *.module.css references must have an @keyframes in
//     that same file — CSS Modules localizes animation names, so borrowing a
//     keyframes from css/styles.css compiles to a scoped name nothing defines
//     and the element silently renders frozen
//
// Usage: node scripts/ui-token-audit.mjs   (exit 1 when violations found)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = join(dirname(fileURLToPath(import.meta.url)), '../frontend')
const cssFiles = [
  join(frontend, 'css/styles.css'),
  join(frontend, 'css/motion.css'),
]
// src/**/*.module.css 递归收集
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name.endsWith('.module.css')) cssFiles.push(p)
  }
}
walk(join(frontend, 'src'))

const violations = []
let scanned = 0

const fsOk = /^var\(--|^\d*\.?\d+em$|^clamp\(|^inherit$|^0$/
const fwOk = /^var\(--|^inherit$/
const lhOk = /^var\(--leading-[a-z-]+\)$|^1(\.25|\.4|\.5|\.6)?$|^\d+px$|^inherit$|^normal$/
const radiusComponentOk = /^var\(--|^999px$|^50%$|^0$|^inherit$/
const themedToken = /^var\(--(fg|fg-secondary|fg-tertiary|fg-quaternary|bg|bg-surface|bg-elevated|bg-hover|accent|accent-text|accent-hover|danger|danger-bg|danger-text|warning|warning-bg|success|success-bg|info|info-bg),\s*#/

const bannedHexes = ['#c84545', '#d49a2c', '#e5484d', '#b45309', '#0285ff']

// animation shorthand keywords that are values, not keyframes names
const animationKeywords = new Set([
  'none', 'initial', 'inherit', 'unset', 'revert', 'normal', 'reverse',
  'alternate', 'alternate-reverse', 'forwards', 'backwards', 'both',
  'running', 'paused', 'infinite', 'linear', 'ease', 'ease-in', 'ease-out',
  'ease-in-out', 'step-start', 'step-end',
])

for (const file of cssFiles) {
  const short = file.replace(frontend + '/', '')
  const lines = readFileSync(file, 'utf8').split('\n')
  scanned += lines.length
  const report = (line, rule, text) =>
    violations.push(`${short}:L${line} [${rule}] ${text.trim().slice(0, 110)}`)

  lines.forEach((raw, i) => {
    const line = i + 1
    const decl = raw.match(/(?<!-)\bfont-size:\s*([^;]+);/)
    if (decl && !fsOk.test(decl[1].trim())) report(line, 'font-size', raw)

    const fw = raw.match(/\bfont-weight:\s*([^;]+);/)
    if (fw && !fwOk.test(fw[1].trim())) report(line, 'font-weight', raw)

    const br = raw.match(/\bborder-radius:\s*([^;]+);/)
    if (br) {
      const bad = br[1].trim().split(/\s+/).filter((c) => !radiusComponentOk.test(c))
      if (bad.length > 0) report(line, `border-radius:${bad.join(',')}`, raw)
    }

    const lh = raw.match(/\bline-height:\s*([^;]+);/)
    if (lh && !lhOk.test(lh[1].trim())) report(line, 'line-height', raw)

    for (const m of raw.matchAll(/var\([^)]*\)/g)) {
      if (themedToken.test(m[0])) report(line, 'var-fallback', raw)
    }

    for (const hex of bannedHexes) {
      if (raw.toLowerCase().includes(hex)) report(line, `banned-hex:${hex}`, raw)
    }
  })

  // Animation names are per-file in CSS Modules — collect definitions and
  // references over the whole file, then report references nothing defines.
  if (file.endsWith('.module.css')) {
    const text = lines.join('\n')
    const defined = new Set(
      [...text.matchAll(/@keyframes\s+([A-Za-z_-][\w-]*)/g)].map((m) => m[1]),
    )
    lines.forEach((raw, i) => {
      const decl = raw.match(/\banimation(?:-name)?:\s*([^;]+);/)
      if (!decl) return
      for (const token of decl[1].trim().split(/[,\s]+/)) {
        if (!/^[A-Za-z_-][\w-]*$/.test(token)) continue
        if (animationKeywords.has(token) || defined.has(token)) continue
        report(i + 1, `keyframes-undefined:${token}`, raw)
      }
    })
  }
}

if (violations.length > 0) {
  console.error(`UI token audit FAILED — ${violations.length} violation(s):`)
  for (const v of violations) console.error('  ' + v)
  process.exit(1)
}
console.log(`UI token audit passed (${cssFiles.length} files, ${scanned} lines scanned).`)
