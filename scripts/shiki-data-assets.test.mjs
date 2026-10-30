import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'vite'
import { createShikiGrammarLoader, createShikiWasmInstantiator, readShikiGrammarCatalog, shikiDataAssetsPlugin } from './shiki-data-assets.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const catalog = await readShikiGrammarCatalog(root)
await mkdir(join(root, 'dist'), { recursive: true })
const temporary = await mkdtemp(join(root, 'dist/syntax-data-test-'))
after(() => rm(temporary, { recursive: true, force: true }))

function grammarManifest() {
  return Object.fromEntries([...catalog.modules].map(([name, keys]) => [name, keys.map(key => `https://syntax.test/${key}.json`)]))
}

function grammarResponse(url) {
  const key = new URL(url).pathname.slice(1, -5)
  return new Response(catalog.grammars.get(key), { headers: { 'Content-Type': 'application/json' } })
}

test('published language registrations, aliases and embedded ordering survive data serialization', async () => {
  const load = createShikiGrammarLoader(grammarManifest(), grammarResponse)
  const sourceDirectory = dirname(require.resolve('@shikijs/langs'))
  for (const name of catalog.modules.keys()) {
    const original = await import(pathToFileURL(join(sourceDirectory, `${name}.mjs`)).href)
    const loaded = await load(name)
    assert.deepEqual(loaded.default, original.default, name)
    assert(loaded.default.every(Object.isFrozen), name)
  }
  const cpp = await load('cpp')
  assert.deepEqual(cpp.default.map(grammar => grammar.name), ['regexp', 'c', 'glsl', 'cpp-macro', 'regexp', 'c', 'glsl', 'cpp'])
  assert.strictEqual(cpp.default[0], cpp.default[4])
  assert.strictEqual((await load('cpp-macro')).default.at(-1), cpp.default[3])
  assert.strictEqual((await load('cpp')).default, cpp.default)
  assert.strictEqual((await load('elisp')).default[0], (await load('emacs-lisp')).default[0])
})

test('lazy language requests coalesce, preserve module promises and recover from asset failure', async () => {
  let requests = 0
  let fail = true
  const load = createShikiGrammarLoader(grammarManifest(), async url => {
    requests++
    return fail ? new Response('unavailable', { status: 503 }) : grammarResponse(url)
  })
  assert.equal(requests, 0)
  const first = load('emacs-lisp')
  assert.strictEqual(load('emacs-lisp'), first)
  await assert.rejects(first, /Syntax grammar request failed: 503/)
  fail = false
  const recovered = await load('emacs-lisp')
  assert.equal(recovered.default[0].name, 'emacs-lisp')
  assert.equal(requests, 2)
  await load('elisp')
  assert.equal(requests, 2)
  await assert.rejects(load('not-a-language'), /Unknown syntax language/)
})

test('catalog collection observes changed embedded data without a stale module registry', async () => {
  const project = join(temporary, 'catalog-rebuild')
  const packageRoot = join(project, 'node_modules/@shikijs/langs')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(project, 'package.json'), '{}')
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@shikijs/langs', type: 'module', main: 'index.mjs' }))
  await writeFile(join(packageRoot, 'index.mjs'), 'export {}')
  await writeFile(join(packageRoot, 'outer.mjs'), "import inner from './inner.mjs'; export default [...inner,Object.freeze({name:'outer'})]")
  const inner = join(packageRoot, 'inner.mjs')
  await writeFile(inner, "export default [Object.freeze({name:'inner',version:1})]")
  const first = await readShikiGrammarCatalog(project)
  await writeFile(inner, "export default [Object.freeze({name:'inner',version:2})]")
  const second = await readShikiGrammarCatalog(project)
  assert.equal(JSON.parse(first.grammars.get(first.modules.get('outer')[0])).version, 1)
  assert.equal(JSON.parse(second.grammars.get(second.modules.get('outer')[0])).version, 2)
})

test('binary engine data matches the published bytes and its async loader retries failed reads', async () => {
  const bytes = await readFile(require.resolve('shiki/onig.wasm'))
  const inlinePath = join(dirname(require.resolve('@shikijs/engine-oniguruma')), 'wasm-inlined.mjs')
  const original = await import(pathToFileURL(inlinePath).href)
  assert.deepEqual(bytes, Buffer.from(original.wasmBinary))
  assert(WebAssembly.validate(bytes))
  let requests = 0
  const instantiate = createShikiWasmInstantiator('https://syntax.test/engine.wasm', async () => {
    requests++
    return requests === 1 ? new Response('unavailable', { status: 503 }) : new Response(bytes)
  }, async data => ({ instance: { exports: { length: data.byteLength } } }))
  await assert.rejects(instantiate({}), /Syntax engine request failed: 503/)
  assert.equal((await instantiate({})).length, bytes.byteLength)
  assert.equal(requests, 2)
  // A fake instantiator isolates the cache check from the engine's required imports.
  let cachedRequests = 0
  const cached = createShikiWasmInstantiator('https://syntax.test/engine.wasm', async () => {
    cachedRequests++
    return new Response(bytes)
  }, async data => ({ instance: { exports: { length: data.byteLength } } }))
  assert.equal((await cached({})).length, bytes.byteLength)
  assert.equal((await cached({})).length, bytes.byteLength)
  assert.equal(cachedRequests, 1)
})

test('emitted assets preserve JS highlighting and optional binary-engine tokenization', async () => {
  const entry = join(temporary, 'entry.mjs')
  await writeFile(entry, `export {bundledLanguages,createHighlighter,createJavaScriptRegexEngine,createOnigurumaEngine} from 'shiki';\nexport {default as instantiateWasm} from 'shiki/wasm';\n`)
  const outDir = join(temporary, 'built')
  const plugin = shikiDataAssetsPlugin({ root })
  const configuration = {
    configFile: false, root, logLevel: 'warn', plugins: [plugin],
    build: { target: 'safari15', outDir, minify: true, rollupOptions: { input: entry, preserveEntrySignatures: 'strict', output: { entryFileNames: 'entry.mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' } } },
  }
  await build(configuration)
  await build(configuration)
  const configurationFile = join(temporary, 'vite.config.mjs')
  await writeFile(configurationFile, `import {shikiDataAssetsPlugin} from ${JSON.stringify(join(root, 'scripts/shiki-data-assets.mjs'))};
export default {root:${JSON.stringify(root)},plugins:[shikiDataAssetsPlugin({root:${JSON.stringify(root)}})],
build:${JSON.stringify(configuration.build)}};`)
  const result = await build({ configFile: configurationFile, logLevel: 'warn' })
  const output = Array.isArray(result) ? result.flatMap(item => item.output) : result.output
  const chunks = output.filter(item => item.type === 'chunk')
  assert(chunks.every(chunk => Buffer.byteLength(chunk.code) < 500_000))
  assert(!chunks.some(chunk => Object.keys(chunk.modules).some(id => /@shikijs\/langs\/dist\/(?:cpp|emacs-lisp)\.mjs$|wasm-inlined\.mjs$/.test(id))))
  const cppAsset = output.find(item => item.type === 'asset' && /syntax-cpp-\d+-/.test(item.fileName))
  const lispAsset = output.find(item => item.type === 'asset' && /syntax-emacs-lisp-\d+-/.test(item.fileName))
  const wasmAsset = output.find(item => item.type === 'asset' && item.fileName.endsWith('.wasm'))
  assert(cppAsset && lispAsset && wasmAsset)
  assert.equal(JSON.parse(String(cppAsset.source)).name, 'cpp')
  assert.equal(JSON.parse(String(lispAsset.source)).name, 'emacs-lisp')
  const nativeFetch = globalThis.fetch
  const requested = []
  const emittedAssets = new Map(output.filter(item => item.type === 'asset').map(item => [`/${item.fileName}`, join(outDir, item.fileName)]))
  globalThis.fetch = async (url, options) => {
    // Root-relative build URLs use the renderer's document origin in the application.
    const path = emittedAssets.get(String(url)) ?? (String(url).startsWith('file:') ? fileURLToPath(url) : undefined)
    if (!path) return nativeFetch(url, options)
    requested.push(String(url))
    return new Response(await readFile(path))
  }
  const loaded = await import(pathToFileURL(join(outDir, 'entry.mjs')).href)
  const samples = [['cpp', '#include <vector>\nint main() { return 42; }'], ['emacs-lisp', '(defun sample (x) (+ x 1))']]
  try {
    assert.equal(requested.length, 0, 'importing the loader does not fetch syntax data')
    const cpp = await loaded.bundledLanguages.cpp()
    assert.deepEqual(cpp.default.map(grammar => grammar.name), ['regexp', 'c', 'glsl', 'cpp-macro', 'regexp', 'c', 'glsl', 'cpp'])
    assert.strictEqual((await loaded.bundledLanguages.elisp()).default, (await loaded.bundledLanguages['emacs-lisp']()).default)
    assert(!requested.some(url => url.endsWith('.wasm')), 'language loading does not fetch the optional engine')
    const js = await loaded.createHighlighter({ themes: ['github-light'], langs: ['cpp', 'emacs-lisp'], engine: loaded.createJavaScriptRegexEngine() })
    const direct = await import(pathToFileURL(require.resolve('shiki')).href)
    const original = await direct.createHighlighter({ themes: ['github-light'], langs: ['cpp', 'emacs-lisp'], engine: direct.createJavaScriptRegexEngine() })
    for (const [lang, source] of samples) {
      const actual = js.codeToTokens(source, { lang, theme: 'github-light' })
      const expected = original.codeToTokens(source, { lang, theme: 'github-light' })
      assert.deepEqual(actual.tokens, expected.tokens)
      assert.deepEqual([actual.fg, actual.bg, actual.themeName], [expected.fg, expected.bg, expected.themeName])
    }
    js.dispose(); original.dispose()
    assert(!requested.some(url => url.endsWith('.wasm')), 'JS highlighting never requests the optional binary')
    const wasm = await loaded.createHighlighter({ themes: ['github-light'], langs: ['cpp', 'emacs-lisp'], engine: loaded.createOnigurumaEngine(loaded.instantiateWasm) })
    for (const [lang, source] of samples) assert(wasm.codeToTokens(source, { lang, theme: 'github-light' }).tokens.flat().some(token => token.color))
    wasm.dispose()
    assert.equal(requested.filter(url => url.endsWith('.wasm')).length, 1)
  } finally { globalThis.fetch = nativeFetch }
})
