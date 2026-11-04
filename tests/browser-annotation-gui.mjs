import { execFileSync } from 'node:child_process'
import { buildSync } from 'esbuild'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const worktree = process.cwd()
const outDir = join(worktree, 'dist', 'annotation-worktree-gui')
mkdirSync(outDir, { recursive: true })
buildSync({
  entryPoints: [join(worktree, 'tests', 'browser-annotation-gui-entry.tsx')],
  bundle: true, format: 'iife', jsx: 'automatic', target: 'es2022',
  outfile: join(outDir, 'entry.js'),
})

writeFileSync(join(outDir, 'index.html'), `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>browser annotation fixture</title>
<link rel="stylesheet" href="entry.css">
<style>html,body{margin:0;background:#111}#root{position:relative;width:900px;height:700px}</style>
</head>
<body><div id="root"></div><script src="entry.js"></script></body>
</html>
`)

const chrome = process.env.KLAUS_TEST_CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const profile = mkdtempSync(join(outDir, 'chrome-profile-'))
let raw
try {
  raw = execFileSync(chrome, [
    '--headless=new', '--disable-gpu', `--user-data-dir=${profile}`,
    '--dump-dom', '--virtual-time-budget=8000', `file://${join(outDir, 'index.html')}`,
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
} finally { rmSync(profile, { recursive: true, force: true }) }
writeFileSync(join(worktree, 'dist', 'annotation-worktree-gui-dom.log'), raw)
const match = raw.match(/<pre id="result">([^<]*)<\/pre>/)
if (!match) throw new Error('The annotation GUI fixture produced no result element. See dist/annotation-worktree-gui-dom.log')
const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const result = JSON.parse(decoded)
writeFileSync(join(worktree, 'dist', 'annotation-worktree-gui-result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exit(1)
