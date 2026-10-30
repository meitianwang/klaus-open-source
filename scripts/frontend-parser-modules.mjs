import ts from 'typescript'

const moduleQuery = '?klaus-parser-section='
const dependencyPath = '/node_modules/@mermaid-js/parser/dist/chunks/'
const boundaries = [
  ['runtime', null],
  ['ast', '// src/language/generated/ast.ts'],
  ['grammar', '// src/language/generated/grammar.ts'],
  ['services', '// src/language/generated/module.ts'],
]

function fail(message) {
  throw new Error(`Cannot separate diagram parser modules: ${message}`)
}

function encodeVlq(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let encoded = ''
  let remaining = value < 0 ? ((-value) << 1) | 1 : value << 1
  do {
    let digit = remaining & 31
    remaining >>>= 5
    if (remaining) digit |= 32
    encoded += alphabet[digit]
  } while (remaining)
  return encoded
}

function sourceMap(id, source, start, body, prefix) {
  const sourceLine = source.slice(0, start).split('\n').length - 1
  const lineCount = body.split('\n').length
  return {
    version: 3,
    sources: [id],
    sourcesContent: [source],
    names: [],
    mappings: ';'.repeat(prefix.split('\n').length - 1)
      + `AA${encodeVlq(sourceLine)}A` + ';AACA'.repeat(lineCount - 1),
  }
}

/** Restore the generated language modules that the published parser flattens. */
export function separateParserModules(source, id) {
  const file = ts.createSourceFile(id, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  if (file.parseDiagnostics.length) fail('the dependency is not valid JavaScript')
  const declarations = file.statements.filter(ts.isExportDeclaration)
  if (declarations.length !== 1) fail('expected one final named export declaration')
  const exportsNode = declarations[0]
  if (exportsNode !== file.statements.at(-1) || !exportsNode.exportClause
    || !ts.isNamedExports(exportsNode.exportClause) || exportsNode.moduleSpecifier) {
    fail('expected a final local named export declaration')
  }
  const exportStart = exportsNode.getStart(file)
  const sections = boundaries.map(([name, marker], index) => {
    const start = marker ? source.indexOf(marker) : 0
    if (start < 0 || (marker && source.indexOf(marker, start + marker.length) !== -1)) {
      fail(`expected one ${name} source boundary`)
    }
    return { name, index, start, end: exportStart, imports: new Map(), exports: new Set() }
  })
  for (let index = 0; index < sections.length - 1; index++) {
    sections[index].end = sections[index + 1].start
    if (sections[index].end <= sections[index].start) fail('source module boundaries are out of order')
  }
  const sectionAt = position => sections.find(section => position >= section.start && position < section.end)
  const host = {
    getSourceFile: filename => filename === id ? file : undefined,
    getDefaultLibFileName: () => '',
    writeFile() {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: filename => filename === id,
    readFile: filename => filename === id ? source : undefined,
    getCanonicalFileName: filename => filename,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  const checker = ts.createProgram([id], { allowJs: true, noResolve: true, noLib: true }, host).getTypeChecker()
  const bindings = new Map()
  function register(name, section) {
    if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) register(element.name, section)
      }
      return
    }
    if (!ts.isIdentifier(name)) fail('unsupported top-level binding pattern')
    const symbol = checker.getSymbolAtLocation(name)
    if (!symbol || bindings.has(symbol)) fail(`ambiguous top-level binding ${name.text}`)
    bindings.set(symbol, { section, name: name.text })
  }
  for (const statement of file.statements) {
    if (statement === exportsNode) continue
    const section = sectionAt(statement.getStart(file))
    if (!section || statement.end > section.end) fail('a statement crosses a source module boundary')
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) register(declaration.name, section)
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (!statement.name) fail('anonymous top-level declaration')
      register(statement.name, section)
    } else if (ts.isImportDeclaration(statement) || ts.isExportAssignment(statement)) {
      fail('the dependency contains unsupported top-level imports or exports')
    }
  }
  for (const section of sections) {
    function visit(node) {
      if (ts.isIdentifier(node)) {
        const binding = bindings.get(checker.getSymbolAtLocation(node))
        if (binding && binding.section !== section) {
          if (binding.section.index > section.index) fail('a source module now depends on a later initialization stage')
          const names = section.imports.get(binding.section) ?? new Set()
          names.add(binding.name)
          section.imports.set(binding.section, names)
          binding.section.exports.add(binding.name)
        }
      }
      ts.forEachChild(node, visit)
    }
    for (const statement of file.statements) {
      if (statement !== exportsNode && sectionAt(statement.getStart(file)) === section) visit(statement)
    }
  }
  const facade = new Map()
  for (const specifier of exportsNode.exportClause.elements) {
    const localName = specifier.propertyName ?? specifier.name
    const symbol = checker.getExportSpecifierLocalTargetSymbol(specifier)
    const binding = bindings.get(symbol)
    if (!binding || binding.name !== localName.text) fail(`unresolved export ${localName.text}`)
    binding.section.exports.add(binding.name)
    const names = facade.get(binding.section) ?? []
    names.push(specifier.getText(file))
    facade.set(binding.section, names)
  }
  const moduleId = section => `${id}${moduleQuery}${section.name}`
  const modules = new Map()
  for (const section of sections) {
    const imports = [...section.imports].map(([owner, names]) =>
      `import { ${[...names].sort().join(', ')} } from ${JSON.stringify(moduleId(owner))};\n`).join('')
    const body = source.slice(section.start, section.end)
    const code = imports + body + `\nexport { ${[...section.exports].sort().join(', ')} };\n`
    modules.set(moduleId(section), { code, map: sourceMap(id, source, section.start, body, imports) })
  }
  return {
    code: [...facade].map(([section, names]) =>
      `export { ${names.join(', ')} } from ${JSON.stringify(moduleId(section))};`).join('\n'),
    modules,
  }
}

export function parserModules() {
  const modules = new Map()
  return {
    name: 'klaus:diagram-parser-modules',
    enforce: 'pre',
    buildStart() {
      modules.clear()
    },
    resolveId(id) {
      return id.includes(moduleQuery) ? id : undefined
    },
    load(id) {
      return modules.get(id)?.code
    },
    transform(source, id) {
      if (modules.has(id)) return modules.get(id)
      if (id.includes(moduleQuery) || !id.replaceAll('\\', '/').includes(dependencyPath)) return undefined
      if (!source.includes('// src/language/generated/ast.ts')
        && !/\b(?:var|let|const)\s+MermaidGeneratedSharedModule\b/.test(source)) return undefined
      const result = separateParserModules(source, id)
      for (const [moduleId, module] of result.modules) modules.set(moduleId, module)
      return { code: result.code, map: { version: 3, sources: [id], names: [], mappings: '' } }
    },
  }
}
