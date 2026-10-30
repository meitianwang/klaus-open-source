import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { build, createLogger } from 'vite'
import { parserModules, separateParserModules } from './frontend-parser-modules.mjs'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cases = [
  ['info', 'info\nshowInfo', 'Info'],
  ['packet', 'packet\n0-7: "Header"', 'Packet'],
  ['pie', 'pie\n"Tea": 42\n"Coffee": 58', 'Pie'],
  ['treeView', 'treeView-beta\n"Root"\n    "Child"', 'TreeView'],
  ['architecture', 'architecture-beta\nservice db(database)[Database]\nservice api(server)[API]\napi:R --> L:db', 'Architecture'],
  ['gitGraph', 'gitGraph\ncommit id: "start"\nbranch feature\ncheckout feature\ncommit\ncheckout main\nmerge feature', 'GitGraph'],
  ['eventmodeling', 'eventmodeling', 'EventModel'],
  ['radar', 'radar-beta\naxis a["A"], b["B"]\ncurve c["C"]{1, 2}', 'Radar'],
  ['railroad', 'railroad-beta\nrule = terminal("text");', 'Railroad'],
  ['railroadEbnf', 'railroad-ebnf-beta\nrule = "text";', 'RailroadEbnf'],
  ['railroadAbnf', 'railroad-abnf-beta\nrule = "text";', 'RailroadAbnf'],
  ['railroadPeg', 'railroad-peg-beta\nrule <- "text";', 'RailroadPeg'],
  ['treemap', 'treemap\n"Root"\n    "Child": 12', 'Treemap'],
  ['wardley', 'wardley-beta\ncomponent Database [0.8, 0.3]', 'Wardley'],
  ['cynefin', 'cynefin-beta\nclear\n"Routine work"', 'Cynefin'],
]

function plain(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => key.startsWith('$') ? undefined : item))
}

test('production diagram parser assets preserve language services and stay within the chunk budget', async t => {
  await mkdir(join(desktop, 'dist'), { recursive: true })
  const fixture = await mkdtemp(join(desktop, 'dist', 'parser-modules-'))
  try {
    const entry = join(fixture, 'entry.mjs')
    const output = join(fixture, 'output')
    await writeFile(entry, "export * from '@mermaid-js/parser'\n")
    const warnings = []
    const logger = createLogger('info')
    const originalWarn = logger.warn.bind(logger)
    logger.warn = (message, options) => {
      warnings.push(message)
      originalWarn(message, options)
    }
    await build({
      configFile: false,
      root: desktop,
      customLogger: logger,
      plugins: [parserModules()],
      build: {
        target: 'safari15',
        outDir: output,
        emptyOutDir: true,
        minify: true,
        // This fixture imports emitted modules in Node; browser coverage exercises preload behavior.
        modulePreload: false,
        sourcemap: true,
        rollupOptions: {
          input: entry,
          preserveEntrySignatures: 'strict',
          output: {
            strictExecutionOrder: true,
            entryFileNames: 'parser.mjs',
            chunkFileNames: '[name]-[hash].mjs',
            codeSplitting: { groups: [{ name: 'vendor', test: /node_modules/, maxSize: 400_000 }] },
          },
        },
      },
    })
    await t.test('all emitted JavaScript remains below 500 kB without build warnings', async () => {
      assert.deepEqual(warnings, [])
      const assets = (await readdir(output)).filter(name => name.endsWith('.mjs'))
      assert.ok(assets.length > 1)
      for (const name of assets) {
        const size = (await stat(join(output, name))).size
        assert.ok(size < 500_000, `${name} is ${size} bytes`)
      }
      const maps = await Promise.all((await readdir(output)).filter(name => name.endsWith('.map'))
        .map(name => readFile(join(output, name), 'utf8').then(JSON.parse)))
      assert.ok(maps.some(map => map.sources.some(source => source.includes('@mermaid-js/parser/dist/chunks/'))))
      assert.ok(maps.every(map => map.sources.filter(source => source.includes('?klaus-parser-section='))
        .every(source => source.includes('@mermaid-js/parser/dist/chunks/'))))
      assert.ok(maps.some(map => map.sourcesContent?.some(source => source?.includes('// src/language/generated/grammar.ts'))))
    })
    const parser = await import(pathToFileURL(join(output, 'parser.mjs')).href)
    for (const [language, source, type] of cases) {
      await t.test(`${language} parses its complete emitted language service`, async () => {
        const value = await parser.parse(language, source)
        assert.equal(value.$type, type)
        assert.equal(value.$cstNode.text, source)
        const repeated = await parser.parse(language, source)
        assert.deepEqual(plain(repeated), plain(value))
      })
      if (language !== 'treeView') await t.test(`${language} preserves lexical errors`, async () => {
        await assert.rejects(parser.parse(language, `${source}\n\u0000`), error => {
          assert.ok(error instanceof parser.MermaidParseError)
          assert.ok(error.result.lexerErrors.length > 0)
          return true
        })
      })
      await t.test(`${language} preserves parser errors`, async () => {
        await assert.rejects(parser.parse(language, ''), error => {
          assert.ok(error instanceof parser.MermaidParseError)
          assert.ok(error.result.parserErrors.length > 0)
          return true
        })
      })
    }
    await t.test('generated tables, converters, and public AST guards retain structured values', async () => {
      const pie = await parser.parse('pie', cases.find(([language]) => language === 'pie')[1])
      assert.ok(parser.isPie(pie))
      assert.deepEqual(plain(pie.sections), [{ label: 'Tea', value: 42 }, { label: 'Coffee', value: 58 }])
      const packet = await parser.parse('packet', cases.find(([language]) => language === 'packet')[1])
      assert.deepEqual(plain(packet.blocks), [{ start: 0, end: 7, label: 'Header' }])
      const tree = await parser.parse('treeView', cases.find(([language]) => language === 'treeView')[1])
      assert.deepEqual(plain(tree.nodes), [{ name: 'Root' }, { indent: 4, name: 'Child' }])
      const architecture = await parser.parse('architecture', cases.find(([language]) => language === 'architecture')[1])
      assert.ok(parser.isArchitecture(architecture))
      assert.equal(architecture.services[0].title, 'Database')
      assert.equal(architecture.edges[0].lhsId, 'api')
      assert.equal(architecture.edges[0].rhsId, 'db')
      const radar = await parser.parse('radar', cases.find(([language]) => language === 'radar')[1])
      assert.deepEqual(plain(radar.curves[0].entries), [{ value: 1 }, { value: 2 }])
    })
    await t.test('unsupported language errors remain explicit', async () => {
      await assert.rejects(parser.parse('missing-language', 'info'), /Unknown diagram type: missing-language/)
    })
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

test('dependency shape changes fail with an actionable build error', () => {
  assert.throws(() => separateParserModules('export const unsupported = true', '/parser.mjs'), /Cannot separate diagram parser modules/)
  const plugin = parserModules()
  assert.throws(() => plugin.transform('var MermaidGeneratedSharedModule = {}; export { MermaidGeneratedSharedModule };', '/node_modules/@mermaid-js/parser/dist/chunks/changed.mjs'), /expected one ast source boundary/)
})
