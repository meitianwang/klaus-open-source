// Guard: every CSS-module class key a component reads through its `styles`
// binding must exist in the module it came from. A key with no rule in the
// stylesheet hashes to `undefined` at runtime, so the element silently ships
// the literal class "undefined" — invisible in bun's fake DOM (module imports
// are plain strings there) and only caught by a headless-Chrome probe. This
// test makes the class of bug (subagent-row-status-label, 2026-09-27) fail at
// the gate instead of in production.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name !== 'node_modules' && !name.startsWith('.')) sourceFiles(full, out)
    } else if (/\.(ts|tsx)$/.test(name) && !name.includes('.test.')) out.push(full)
  }
  return out
}

const cssDefinedKeys = new Map<string, Set<string>>()
function definedKeys(cssPath: string): Set<string> {
  let keys = cssDefinedKeys.get(cssPath)
  if (keys) return keys
  keys = new Set<string>()
  try {
    // Keys that only appear inside :global(...) are global classes, not module
    // exports; reading them through `styles` would still hash to undefined.
    const css = readFileSync(cssPath, 'utf8').replace(/:global\([^)]*\)/g, ' ')
    for (const match of css.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)) keys.add(match[1])
  } catch { /* unresolved module is reported by the import check below */ }
  cssDefinedKeys.set(cssPath, keys)
  return keys
}

// Follow a re-export hop (overview/shared.ts re-exports overview.module.css's
// styles) so the guard covers indirect bindings too.
function cssForSpecifier(spec: string, fromDir: string): string | null {
  if (spec.endsWith('.module.css')) return path.resolve(fromDir, spec)
  const candidates = [path.resolve(fromDir, spec + '.ts'), path.resolve(fromDir, spec)]
  for (const candidate of candidates) {
    let body = ''
    try { body = readFileSync(candidate, 'utf8') } catch { continue }
    if (!/export\s+\{[^}]*\bstyles\b[^}]*\}/.test(body)) continue
    const inner = body.match(/import\s+styles\s+from\s+'([^']+\.module\.css)'/)
    if (inner) return path.resolve(path.dirname(candidate), inner[1])
  }
  return null
}

interface Violation { file: string; key: string; module: string }

function violations(): Violation[] {
  const found: Violation[] = []
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    const imports = [...source.matchAll(/^import\s+(?:styles|\{[^}\n]*\bstyles\b[^}]*\})\s+from\s+'([^']+)'/gm)]
    if (imports.length === 0) continue
    let cssPath: string | null = null
    for (const match of imports) {
      cssPath = cssForSpecifier(match[1], path.dirname(file))
      if (cssPath) break
    }
    if (!cssPath) continue
    const defined = definedKeys(cssPath)
    // Import lines themselves contain `styles.module.css`-shaped substrings;
    // usage scanning must not see them.
    const body = source.replace(/^import[^\n]*$/gm, '')
    for (const match of body.matchAll(/(?<![.\w])styles\[\s*['"]([^'"]+)['"]\s*\]/g)) {
      if (!defined.has(match[1])) found.push({ file: path.relative(SRC, file), key: match[1], module: path.relative(SRC, cssPath) })
    }
    for (const match of body.matchAll(/(?<![.\w])styles\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      if (!defined.has(match[1])) found.push({ file: path.relative(SRC, file), key: match[1], module: path.relative(SRC, cssPath) })
    }
  }
  return found
}

describe('css module key integrity', () => {
  test('every styles[...] / styles.x key exists in its module', () => {
    expect(violations()).toEqual([])
  })
})
