// Canvas 编译/求值链路的验收门。
//
// 钉的是「一段模型写的 .canvas.tsx 到底能不能变成一个可挂载的组件」，以及失败时
// 报出来的东西有没有用。后半件同等重要：canvas 是生成代码，失败是常态而不是异
// 常，报错里没有行号和原因就等于让用户去开控制台。
//
// 这里不拉 DOM。compileCanvas / evaluateCanvas 是纯函数，`react` 只在求值时按名
// 注入，所以整条链路在 bun 里直接跑得通 —— 真正需要浏览器的只有「画出来长什么
// 样」，那不是这份测试的事。
import { describe, expect, test } from 'bun:test'

import { CanvasLoadError, compileCanvas, failureHeading, loadCanvas } from './loader'

/** 一个遵守契约的最小 canvas。 */
const GOOD = `import { Stack, H1, Text } from 'klaus/canvas';

export default function Report() {
  return (
    <Stack gap="section">
      <H1>Title</H1>
      <Text tone="secondary">Body</Text>
    </Stack>
  );
}
`

describe('compileCanvas', () => {
  test('抹掉类型、把 JSX 转成 createElement、把 import 转成 require', () => {
    const code = compileCanvas(GOOD)
    expect(code).toContain('require(')
    expect(code).toContain('React.createElement')
    // 类型标注不该留在产物里。
    expect(code).not.toContain('interface ')
    expect(code).not.toContain(': string')
  })

  test('接受 TS 专有语法：interface、泛型、as、可选链', () => {
    const source = `import { Text } from 'klaus/canvas';

interface Row { name: string; count?: number }
const rows: Row[] = [{ name: 'a' }];
function first<T>(list: T[]): T | undefined { return list[0]; }

export default function C() {
  const row = first(rows) as Row | undefined;
  return <Text>{row?.name ?? '-'}</Text>;
}
`
    expect(() => compileCanvas(source)).not.toThrow()
  })

  test('语法错误报成 compile 阶段并带上行号', () => {
    // 第 3 行少一个右括号。
    const broken = `import { Text } from 'klaus/canvas';

export default function C() { return <Text>oops</Text>
`
    try {
      compileCanvas(broken)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasLoadError)
      const failure = error as CanvasLoadError
      expect(failure.stage).toBe('compile')
      expect(typeof failure.line).toBe('number')
      expect(failure.message.length).toBeGreaterThan(0)
    }
  })
})

describe('evaluateCanvas', () => {
  test('返回默认导出的组件，且它能被调用', () => {
    const { component: Canvas } = loadCanvas(GOOD)
    expect(typeof Canvas).toBe('function')
    // 调用一次拿到 React 元素树：证明注入的 React 与 SDK 组件确实通了，
    // 而不只是「编译过了」。
    const element = (Canvas as unknown as () => unknown)()
    expect(element).toBeTruthy()
    expect((element as { type?: unknown }).type).toBeTruthy()
  })

  test('SDK 的具名导入拿到的是真组件，不是 undefined', () => {
    const source = `import { Stack, Table, LineChart, useHostTheme } from 'klaus/canvas';
export default function C() {
  return { Stack, Table, LineChart, useHostTheme };
}
`
    const { component: Canvas } = loadCanvas(source)
    const bag = (Canvas as unknown as () => Record<string, unknown>)()
    const missing = ['Stack', 'Table', 'LineChart', 'useHostTheme'].filter(
      (name) => typeof bag[name] !== 'function',
    )
    expect(missing).toEqual([])
  })

  test('从 react 具名导入是允许的 —— 运行时提供 react', () => {
    const source = `import { useState } from 'react';
import { Text } from 'klaus/canvas';
export default function C() { return <Text>{typeof useState}</Text>; }
`
    expect(() => loadCanvas(source)).not.toThrow()
  })

  test('导入并使用 SDK 以外的模块，在求值阶段失败且报出具体 specifier', () => {
    // 必须真的用上 `z`：TypeScript 的 import elision 会把「导入但从未使用」的绑定
    // 整条删掉（下一条测试钉了这个事实），那种情况运行时根本看不到。
    const source = `import { z } from 'zod';
export default function C() { return z; }
`
    try {
      loadCanvas(source)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasLoadError)
      const failure = error as CanvasLoadError
      expect(failure.stage).toBe('evaluate')
      expect(failure.message).toContain("'zod'")
      expect(failure.message).toContain('klaus/canvas')
    }
  })

  test('未被使用的非法 import 会被 elide 掉，所以运行时拦不住它', () => {
    // 这不是缺陷，是分工：静态校验（宿主的 canvas_check）不看使用情况，一律按
    // import 语句报错；运行时的 require 白名单只是兜底。把这条写成测试，是为了
    // 别人不会误以为「运行时能拦住所有非法 import」而去弱化 canvas_check。
    const source = `import { z } from 'zod';
export default function C() { return null; }
`
    expect(() => loadCanvas(source)).not.toThrow()
    expect(compileCanvas(source)).not.toContain('zod')
  })

  test('没有默认导出报成 export 阶段', () => {
    const source = `import { Text } from 'klaus/canvas';
export const C = () => <Text>x</Text>;
`
    try {
      loadCanvas(source)
      throw new Error('should have thrown')
    } catch (error) {
      const failure = error as CanvasLoadError
      expect(failure.stage).toBe('export')
      expect(failure.message).toContain('no default export')
    }
  })

  test('默认导出不是函数也报成 export 阶段，措辞与缺失区分开', () => {
    const source = `export default { not: 'a component' };
`
    try {
      loadCanvas(source)
      throw new Error('should have thrown')
    } catch (error) {
      const failure = error as CanvasLoadError
      expect(failure.stage).toBe('export')
      expect(failure.message).toContain('not a component')
    }
  })

  test('模块顶层抛错报成 evaluate 阶段并保留原始信息', () => {
    const source = `import { Text } from 'klaus/canvas';
throw new Error('boom at module scope');
export default function C() { return <Text>x</Text>; }
`
    try {
      loadCanvas(source)
      throw new Error('should have thrown')
    } catch (error) {
      const failure = error as CanvasLoadError
      expect(failure.stage).toBe('evaluate')
      expect(failure.message).toContain('boom at module scope')
    }
  })
})

describe('failureHeading', () => {
  // 错误阶段的文案必须两两不同。这不是措辞洁癖：浏览器里实测到过「文件不存在」
  // 被报成 "failed while rendering"，把读者指向一份根本没被读到的代码。
  const STAGES = ['load', 'compile', 'evaluate', 'export', 'render'] as const

  test('每个阶段都有自己的文案，没有两个阶段共用一句', () => {
    const headings = STAGES.map(failureHeading)
    expect(new Set(headings).size).toBe(STAGES.length)
    for (const heading of headings) {
      expect(heading.length).toBeGreaterThan(0)
    }
  })

  test('读不到文件不能说成渲染失败', () => {
    expect(failureHeading('load')).toBe('This canvas could not be read')
    expect(failureHeading('load')).not.toBe(failureHeading('render'))
  })

  test('编译/导出/求值各自的文案与它们的失败对得上', () => {
    expect(failureHeading('compile')).toBe('This canvas does not compile')
    expect(failureHeading('export')).toBe('This canvas has no component to render')
    expect(failureHeading('evaluate')).toBe('This canvas failed while loading')
    expect(failureHeading('render')).toBe('This canvas failed while rendering')
  })
})

// 浏览器里真实验过的三份坏 canvas，原文搬过来钉住。人工跑一次只能证明当时对，
// 写成测试才能证明以后也对 —— 包括「阶段归因」和「报错里有没有可操作的细节」。
describe('浏览器验过的失败样本', () => {
  test('JSX 标签未闭合 → compile 阶段 + 行号', () => {
    const source = `import { Stack, Text } from 'klaus/canvas';

export default function Broken() {
  return (
    <Stack>
      <Text>missing a closing tag
    </Stack>
  );
}
`
    try {
      loadCanvas(source)
      throw new Error('should have thrown')
    } catch (error) {
      const failure = error as CanvasLoadError
      expect(failure.stage).toBe('compile')
      // 行号是修一个语法错唯一真正有用的信息。
      expect(typeof failure.line).toBe('number')
      expect(failureHeading(failure.stage)).toBe('This canvas does not compile')
    }
  })

  test('只有具名导出 → export 阶段', () => {
    const source = `import { Stack, Text } from 'klaus/canvas';

export const NotDefault = () => (
  <Stack>
    <Text>This canvas exports a name, not a default.</Text>
  </Stack>
);
`
    try {
      loadCanvas(source)
      throw new Error('should have thrown')
    } catch (error) {
      const failure = error as CanvasLoadError
      expect(failure.stage).toBe('export')
      expect(failureHeading(failure.stage)).toBe('This canvas has no component to render')
    }
  })

  test('导入并使用 zod → evaluate 阶段，且报出 specifier', () => {
    const source = `import { Stack } from 'klaus/canvas';
import { z } from 'zod';

export default function BadImport() {
  return <Stack>{String(z)}</Stack>;
}
`
    try {
      loadCanvas(source)
      throw new Error('should have thrown')
    } catch (error) {
      const failure = error as CanvasLoadError
      expect(failure.stage).toBe('evaluate')
      expect(failure.message).toContain("'zod'")
      expect(failure.message).toContain('klaus/canvas')
      expect(failureHeading(failure.stage)).toBe('This canvas failed while loading')
    }
  })
})

describe('canvasConfig', () => {
  test('没声明时 config 是空的 —— 默认外壳由 frame 决定，不由 loader 编造', () => {
    const { config } = loadCanvas(GOOD)
    expect(config).toEqual({})
  })

  test('读出 full-bleed 外壳声明', () => {
    const source = `import { Text } from 'klaus/canvas';
import type { CanvasRuntimeConfig } from 'klaus/canvas';
export const canvasConfig: CanvasRuntimeConfig = {
  shell: { mode: 'full-bleed', background: '#101014' },
};
export default function C() { return <Text>x</Text>; }
`
    const { config } = loadCanvas(source)
    expect(config.shell?.mode).toBe('full-bleed')
    expect(config.shell?.background).toBe('#101014')
  })

  test('数值型 padding / fontSize / lineHeight 都留下', () => {
    const source = `import { Text } from 'klaus/canvas';
export const canvasConfig = { shell: { padding: 0, fontSize: 15, lineHeight: 1.6 } };
export default function C() { return <Text>x</Text>; }
`
    const { config } = loadCanvas(source)
    expect(config.shell?.padding).toBe(0)
    expect(config.shell?.fontSize).toBe(15)
    expect(config.shell?.lineHeight).toBe(1.6)
  })

  test('乱写的字段被丢掉，而 canvas 照样能挂载', () => {
    // 关键性质：配置错了不能让页面变白。组件才是用户要的东西。
    const source = `import { Text } from 'klaus/canvas';
export const canvasConfig = {
  shell: { mode: 'sideways', padding: true, background: 42, bogus: 'x' },
};
export default function C() { return <Text>x</Text>; }
`
    const { component, config } = loadCanvas(source)
    expect(typeof component).toBe('function')
    expect(config).toEqual({})
  })

  test('canvasConfig 不是对象时当没声明处理，不抛', () => {
    for (const value of ['"nope"', '42', 'null', 'undefined', '[]']) {
      const source = `import { Text } from 'klaus/canvas';
export const canvasConfig = ${value};
export default function C() { return <Text>x</Text>; }
`
      const { config } = loadCanvas(source)
      expect(config).toEqual({})
    }
  })

  test('只有 shell 之外的键时也算空 —— 不把未知形状原样透给 frame', () => {
    const source = `import { Text } from 'klaus/canvas';
export const canvasConfig = { theme: 'dark', layout: 'grid' };
export default function C() { return <Text>x</Text>; }
`
    expect(loadCanvas(source).config).toEqual({})
  })
})
