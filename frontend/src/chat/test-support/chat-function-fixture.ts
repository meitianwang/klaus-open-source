import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createSourceFile, forEachChild, isFunctionDeclaration, ScriptTarget, transpileModule } from 'typescript'

/** Execute selected production closures with explicit host and state boundaries. */
export function chatFunctionFixture<T>(names: string[], context: Record<string, unknown>, result = `{ ${names.join(', ')} }`): T {
  const source = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
  const ast = createSourceFile('chat.ts', source, ScriptTarget.ESNext, true)
  const declarations = new Map<string, string>()
  function collect(node: any) {
    if (isFunctionDeclaration(node) && node.name && names.includes(node.name.text)) declarations.set(node.name.text, node.getText(ast))
    forEachChild(node, collect)
  }
  collect(ast)
  for (const name of names) if (!declarations.has(name)) throw new Error(`Missing production function: ${name}`)
  const script = transpileModule([...declarations.values(), `(${result})`].join('\n'), {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText
  return runInNewContext(script, context) as T
}
