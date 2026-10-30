// 门禁：随 SDK 一起发布的 recipe，里面的 ```tsx 示例必须真的能编译并渲染。
//
// 为什么这条比"导入名存在"更重要：recipe 是模型**照抄**的样板。示例里一个错的
// prop、一个已经改名的组件、一个语法笔误，都会被原样抄进用户的 canvas，然后在
// canvas_check 或者渲染时炸——而错的源头在我们发布的文件里，不在模型。
//
// Rust 侧的 recipe_examples_only_import_exports_that_exist 只看 import 行。它抓不到
// 「组件存在但 props 传错」和「JSX 写坏了」。这里把每个示例真的过一遍 loader：
// Sucrase 编译 → 求值 → 调用组件函数拿到元素树，等于把渲染前的整条链路走完。
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { loadCanvas } from './loader'

// src/canvas/ → src → frontend → desktop → apps → 仓库根，五层。
const RECIPES_DIR = fileURLToPath(
  new URL('../../../resources/canvas/recipes', import.meta.url),
)

/** 一个 recipe 文件里的一段 tsx 代码块。 */
interface Example {
  file: string
  index: number
  code: string
}

/**
 * 抽出所有 ```tsx 代码块。
 *
 * 只认 tsx 围栏：recipe 里也有 markdown 表格和 json，误把它们当代码会得到一堆
 * 假失败。
 */
function examples(): Example[] {
  const out: Example[] = []
  for (const file of readdirSync(RECIPES_DIR).filter((n) => n.endsWith('.md'))) {
    const body = readFileSync(`${RECIPES_DIR}/${file}`, 'utf8')
    const fence = /```tsx\n([\s\S]*?)```/g
    let match: RegExpExecArray | null
    let index = 0
    while ((match = fence.exec(body)) !== null) {
      out.push({ file, index: index++, code: match[1] })
    }
  }
  return out
}

const ALL = examples()

describe('shipped recipe examples', () => {
  test('每个 recipe 至少带一个 tsx 示例 —— 否则上面的断言是空转', () => {
    const files = new Set(ALL.map((e) => e.file))
    // index.md 是目录，没有示例是对的；其余 *.recipe.md 都该有。
    const recipeFiles = readdirSync(RECIPES_DIR).filter((n) => n.endsWith('.recipe.md'))
    expect(recipeFiles.length).toBeGreaterThanOrEqual(6)
    const missing = recipeFiles.filter((n) => !files.has(n))
    expect(missing).toEqual([])
  })

  test('每个示例都能编译、求值、并真的渲染出标记', () => {
    const failures: string[] = []
    for (const example of ALL) {
      try {
        const { component: Canvas } = loadCanvas(example.code)
        expect(typeof Canvas).toBe('function')
        // 用真的 React 渲染器，不是直接调用组件函数。直接调用对用了 hook 的
        // 示例会报 "Invalid hook call" —— 那是测试法错了，不是示例错了。
        // renderToStaticMarkup 还顺带把整棵树跑完，能抳到「组件存在但 prop 传错」
        // 和「子节点里引用了 undefined」这类只有渲染时才炸的问题。
        const markup = renderToStaticMarkup(createElement(Canvas))
        if (!markup || markup.length === 0) {
          failures.push(`${example.file}#${example.index}: 渲染出的标记是空的`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failures.push(`${example.file}#${example.index}: ${message}`)
      }
    }
    expect(failures).toEqual([])
  })

  test('示例只从 klaus/canvas 导入 —— 与 canvas_check 的规则一致', () => {
    const offenders: string[] = []
    for (const example of ALL) {
      const specifiers = [...example.code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1])
      for (const specifier of specifiers) {
        if (specifier !== 'klaus/canvas' && !specifier.startsWith('react')) {
          offenders.push(`${example.file}#${example.index}: ${specifier}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('示例都有默认导出 —— 抄过去才是一个能挂载的 canvas', () => {
    const missing = ALL.filter((e) => !e.code.includes('export default')).map(
      (e) => `${e.file}#${e.index}`,
    )
    expect(missing).toEqual([])
  })
})
