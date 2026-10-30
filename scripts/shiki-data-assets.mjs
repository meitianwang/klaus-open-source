import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

const grammarRuntimeId = '\0klaus:shiki-grammar-data'
const wasmRuntimeId = '\0klaus:shiki-wasm-data'
const grammarImport = /\bimport\(\s*(["'])@shikijs\/langs\/([^"']+)\1\s*\)/g

async function collectShikiGrammarCatalog(root) {
  const { readdir } = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const { dirname, join, resolve } = await import('node:path')
  const { pathToFileURL } = await import('node:url')
  const require = createRequire(pathToFileURL(join(resolve(root), 'package.json')))
  const directory = dirname(require.resolve('@shikijs/langs'))
  const names = (await readdir(directory)).filter(name => name.endsWith('.mjs') && name !== 'index.mjs').sort()
  const modules = new Map()
  const grammars = new Map()
  const identities = new Map()
  for (const file of names) {
    const { default: registrations } = await import(pathToFileURL(join(directory, file)).href)
    if (!Array.isArray(registrations)) throw new Error(`Invalid syntax language module: ${file}`)
    const keys = registrations.map(registration => {
      if (!registration || typeof registration !== 'object' || !Object.isFrozen(registration)) {
        throw new Error(`Invalid syntax grammar in ${file}`)
      }
      let key = identities.get(registration)
      if (key === undefined) {
        key = `${String(registration.name ?? 'grammar').replace(/[^a-z0-9_-]/gi, '-')}-${grammars.size}`
        identities.set(registration, key)
        grammars.set(key, JSON.stringify(registration))
      }
      return key
    })
    modules.set(file.slice(0, -4), keys)
  }
  return { modules, grammars, files: names.map(name => join(directory, name)) }
}

/** A fresh module registry also observes changed embedded grammars during rebuilds. */
export function readShikiGrammarCatalog(root) {
  const source = `const {parentPort,workerData}=require('node:worker_threads');
(${collectShikiGrammarCatalog.toString()})(workerData).then(value=>parentPort.postMessage(value));`
  return new Promise((accept, reject) => {
    const worker = new Worker(source, { eval: true, workerData: root })
    let delivered = false
    worker.once('message', value => { delivered = true; accept(value) })
    worker.once('error', reject)
    worker.once('exit', code => { if (!delivered) reject(new Error(`Syntax grammar collection failed: ${code}`)) })
  })
}

/** A language keeps its original ordered registrations and shares embedded grammar objects. */
export function createShikiGrammarLoader(modules, fetchResource = fetch) {
  const languages = new Map()
  const grammars = new Map()
  function loadGrammar(url) {
    let pending = grammars.get(url)
    if (pending) return pending
    pending = Promise.resolve().then(async () => {
      const response = await fetchResource(url)
      if (!response.ok) throw new Error(`Syntax grammar request failed: ${response.status} ${url}`)
      return Object.freeze(await response.json())
    }).catch(error => {
      if (grammars.get(url) === pending) grammars.delete(url)
      throw error
    })
    grammars.set(url, pending)
    return pending
  }
  return function loadLanguage(name) {
    let pending = languages.get(name)
    if (pending) return pending
    pending = Promise.resolve().then(async () => {
      if (!Object.prototype.hasOwnProperty.call(modules, name)) throw new Error(`Unknown syntax language: ${name}`)
      return { default: await Promise.all(modules[name].map(loadGrammar)) }
    }).catch(error => {
      if (languages.get(name) === pending) languages.delete(name)
      throw error
    })
    languages.set(name, pending)
    return pending
  }
}

/** Keep the existing async engine-instantiator contract while loading binary bytes directly. */
export function createShikiWasmInstantiator(url, fetchResource = fetch, instantiate = WebAssembly.instantiate) {
  let binary
  return async function getWasmInstance(imports) {
    if (!binary) {
      const pending = Promise.resolve().then(async () => {
        const response = await fetchResource(url)
        if (!response.ok) throw new Error(`Syntax engine request failed: ${response.status} ${url}`)
        return response.arrayBuffer()
      }).catch(error => {
        if (binary === pending) binary = undefined
        throw error
      })
      binary = pending
    }
    const { instance } = await instantiate(await binary, imports)
    return instance.exports
  }
}

/**
 * Ship syntax tables as lazy data assets instead of escaped JavaScript string literals.
 * @returns {import('vite').Plugin}
 */
export function shikiDataAssetsPlugin({ root }) {
  const require = createRequire(pathToFileURL(join(resolve(root), 'package.json')))
  const shikiDirectory = dirname(require.resolve('shiki'))
  const grammarDirectory = dirname(require.resolve('@shikijs/langs'))
  const engineDirectory = dirname(require.resolve('@shikijs/engine-oniguruma'))
  const shikiPrefix = shikiDirectory.split(sep).join('/') + '/'
  let catalogPromise
  const getCatalog = () => catalogPromise ??= readShikiGrammarCatalog(root)
  let grammarRuntime
  let wasmRuntime
  return {
    name: 'klaus:syntax-data-assets',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      catalogPromise = undefined
      grammarRuntime = undefined
      wasmRuntime = undefined
      for (const file of [join(grammarDirectory, '../package.json'), join(grammarDirectory, '../LICENSE'),
        join(engineDirectory, '../LICENSE'), require.resolve('shiki/onig.wasm')]) this.addWatchFile(file)
    },
    resolveId(id) {
      if (id === grammarRuntimeId) return grammarRuntimeId
      if (id === 'shiki/wasm') return wasmRuntimeId
    },
    async load(id) {
      if (id === grammarRuntimeId) {
        if (grammarRuntime) return grammarRuntime
        const catalog = await getCatalog()
        for (const file of catalog.files) this.addWatchFile(file)
        this.emitFile({ type: 'asset', name: 'syntax-grammars-LICENSE.txt', source: await readFile(join(grammarDirectory, '../LICENSE')) })
        const references = new Map()
        for (const [key, source] of catalog.grammars) {
          const reference = this.emitFile({ type: 'asset', name: `syntax-${key}.json`, source })
          references.set(key, `import.meta.ROLLUP_FILE_URL_${reference}`)
        }
        const modules = [...catalog.modules].map(([name, keys]) => `${JSON.stringify(name)}:[${keys.map(key => references.get(key)).join(',')}]`).join(',')
        grammarRuntime = `export const loadShikiGrammar = (${createShikiGrammarLoader.toString()})({${modules}});`
        return grammarRuntime
      }
      if (id === wasmRuntimeId) {
        if (wasmRuntime) return wasmRuntime
        const source = await readFile(require.resolve('shiki/onig.wasm'))
        this.emitFile({ type: 'asset', name: 'syntax-engine-LICENSE.txt', source: await readFile(join(engineDirectory, '../LICENSE')) })
        const reference = this.emitFile({ type: 'asset', name: 'syntax-oniguruma.wasm', source })
        wasmRuntime = `const getWasmInstance = (${createShikiWasmInstantiator.toString()})(import.meta.ROLLUP_FILE_URL_${reference});
export {getWasmInstance as default, getWasmInstance};`
        return wasmRuntime
      }
    },
    async transform(code, id) {
      if (!id.split(sep).join('/').startsWith(shikiPrefix) || !code.includes('@shikijs/langs/')) return
      const catalog = await getCatalog()
      let changed = false
      const result = code.replace(grammarImport, (_match, _quote, name) => {
        if (!catalog.modules.has(name)) throw new Error(`Missing syntax language data: ${name}`)
        changed = true
        return `__klausLoadShikiGrammar(${JSON.stringify(name)})`
      })
      if (changed) return { code: `import {loadShikiGrammar as __klausLoadShikiGrammar} from ${JSON.stringify(grammarRuntimeId)};
${result}`, map: null }
    },
  }
}
