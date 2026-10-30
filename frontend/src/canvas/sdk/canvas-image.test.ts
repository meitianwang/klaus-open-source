// canvasImage 的门禁。
//
// 它是 SDK 里唯一一个「把用户给的字符串变成浏览器能加载的 URL」的导出，也是唯一
// 一个之前一行测试都没有的导出。错了的表现是图片不显示——没有报错、没有诊断，
// 只有一个空框，所以它必须被钉住。
//
// 这里不测 useHostTheme 那类 hook：它们要 React 渲染器，已经由 recipes.test.ts 的
// renderToStaticMarkup 覆盖。canvasImage 是纯函数，直接测。
import { describe, expect, test } from 'bun:test'

import { canvasImage, initCanvasHost } from './hooks'

const CANVAS = '/Users/x/.klaus/canvas/canvases/report.canvas.tsx'

function seed(filePath = CANVAS) {
  initCanvasHost({ filePath, themeKind: 'dark', locale: 'en', data: {} })
}

describe('canvasImage', () => {
  test('Electron media URLs preserve the real path for the restricted host route', () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'klaus-app:' } })
    try {
      seed()
      const url = new URL(canvasImage('./截图 a.png'))
      expect(url.pathname).toBe('/canvas-asset')
      expect(url.searchParams.get('path')).toBe('/Users/x/.klaus/canvas/canvases/截图 a.png')
      expect(new URL(canvasImage('file:///tmp/shot.png')).searchParams.get('path')).toBe('/tmp/shot.png')
      expect(canvasImage('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
      seed('C:\\Users\\x\\canvases\\report.canvas.tsx')
      expect(new URL(canvasImage('./image.png')).searchParams.get('path')).toBe('C:/Users/x/canvases/image.png')
      expect(new URL(canvasImage('./image #?.png')).searchParams.get('path')).toBe('C:/Users/x/canvases/image #?.png')
      expect(new URL(canvasImage('D:\\media\\image.png')).searchParams.get('path')).toBe('D:/media/image.png')
      expect(new URL(canvasImage('file://server/share/image.png')).searchParams.get('path')).toBe('//server/share/image.png')
    } finally {
      if (previous) Object.defineProperty(globalThis, 'location', previous)
      else Reflect.deleteProperty(globalThis, 'location')
    }
  })
  test('已经能用的 URL 原样返回', () => {
    seed()
    // data / http(s) / file / blob 四种在页面里本来就能加载，改写它们只会弄坏。
    expect(canvasImage('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(canvasImage('https://klaus-ai.cn/a.png')).toBe('https://klaus-ai.cn/a.png')
    expect(canvasImage('http://localhost/a.png')).toBe('http://localhost/a.png')
    expect(canvasImage('file:///tmp/a.png')).toBe('file:///tmp/a.png')
    expect(canvasImage('blob:abc-123')).toBe('blob:abc-123')
  })

  test('大小写不敏感 —— HTTPS: 也算已经能用的 URL', () => {
    seed()
    expect(canvasImage('HTTPS://klaus-ai.cn/a.png')).toBe('HTTPS://klaus-ai.cn/a.png')
    expect(canvasImage('Data:image/png;base64,AA')).toBe('Data:image/png;base64,AA')
  })

  test('相对路径按 canvas 自己的目录解析成 file: URL', () => {
    seed()
    // 这是主用途：agent 把截图存在 canvas 旁边，canvas 用 './shot.png' 引它。
    expect(canvasImage('./shot.png')).toBe(
      'file:///Users/x/.klaus/canvas/canvases/shot.png',
    )
    // 不带 ./ 的裸文件名同样解析。
    expect(canvasImage('shot.png')).toBe('file:///Users/x/.klaus/canvas/canvases/shot.png')
    // 子目录保留。
    expect(canvasImage('assets/shot.png')).toBe(
      'file:///Users/x/.klaus/canvas/canvases/assets/shot.png',
    )
  })

  test('路径里的空格和非 ASCII 被编码，斜杠保留', () => {
    seed()
    const url = canvasImage('my shot.png')
    // encodeURI 而不是 encodeURIComponent：斜杠必须活下来，否则整条路径塌成一段。
    expect(url).toBe('file:///Users/x/.klaus/canvas/canvases/my%20shot.png')
    expect(url.startsWith('file:///Users/x/')).toBe(true)

    const chinese = canvasImage('截图.png')
    expect(chinese.startsWith('file:///Users/x/.klaus/canvas/canvases/')).toBe(true)
    expect(chinese).toContain('%')
  })

  test('空字符串返回空 —— 不是一个指向目录的 URL', () => {
    seed()
    // 返回目录 URL 会让 <img> 去加载一个目录，浏览器控制台冒一个无用的错。
    expect(canvasImage('')).toBe('')
    expect(canvasImage('   ')).toBe('')
  })

  test('canvas 路径未知时退回相对路径，不拼出半个 file: URL', () => {
    seed('')
    // 半个 URL（file://shot.png）会指向一台叫 shot.png 的主机，比不改写更糟。
    expect(canvasImage('./shot.png')).toBe('shot.png')
    expect(canvasImage('shot.png')).toBe('shot.png')
  })
})
