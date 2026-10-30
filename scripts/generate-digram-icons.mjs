// Generate a diagram icon catalog (`icons/index.json`) for a diagram plugin package.
//
// The catalog maps a key like `phosphor:cpu` to the raw SVG path `d` for that
// glyph, drawn from the @phosphor-icons/core package the frontend already
// depends on (no new dependency, no bundled binary asset). The diagram renderer
// scales the path from phosphor's 256 grid into the node box.
//
// Only single-path glyphs are included: a diagram icon is a one-colour mark
// filled with the node's text colour, and multi-path phosphor glyphs (a handful)
// do not survive being flattened to one path.
//
// Run: node apps/desktop/scripts/generate-digram-icons.mjs --out <plugin>/icons/index.json [--only cpu,database]
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = join(here, '..')
export const PHOSPHOR_REGULAR = join(desktopRoot, 'node_modules/@phosphor-icons/core/assets/regular')

// One <path d="..."/> and nothing else. Multi-path or shape-element glyphs are
// skipped rather than mangled.
export function singlePathD(svg) {
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*\/?>/g)]
  if (paths.length !== 1) return null
  if (/<(circle|rect|line|polyline|polygon|ellipse)\b/.test(svg)) return null
  return paths[0][1]
}

/** Build a key-sorted catalog; `only` restricts it to the named glyphs. */
export function digramIconCatalog({ directory = PHOSPHOR_REGULAR, only } = {}) {
  const wanted = only ? new Set(only) : undefined
  const catalog = {}
  let skipped = 0
  for (const file of readdirSync(directory).sort()) {
    if (!file.endsWith('.svg')) continue
    const name = file.replace(/\.svg$/, '')
    if (wanted && !wanted.has(name)) continue
    const d = singlePathD(readFileSync(join(directory, file), 'utf8'))
    if (d) catalog[`phosphor:${name}`] = d
    else skipped += 1
  }
  if (wanted) for (const name of wanted) if (!(`phosphor:${name}` in catalog)) throw new Error(`No single-path phosphor glyph named ${name}`)
  return { catalog, skipped }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, only: { type: 'string' } } })
  if (!values.out) throw new Error('--out <file> is required')
  const outFile = resolve(values.out)
  const { catalog, skipped } = digramIconCatalog({ only: values.only?.split(',').map(name => name.trim()).filter(Boolean) })
  mkdirSync(dirname(outFile), { recursive: true })
  // Key-sorted output keeps regenerations a stable diff.
  writeFileSync(outFile, JSON.stringify(catalog))
  const bytes = readFileSync(outFile).length
  console.log(`digram icons: ${Object.keys(catalog).length} glyphs, ${skipped} skipped, ${(bytes / 1024).toFixed(0)}KB -> ${outFile}`)
}
