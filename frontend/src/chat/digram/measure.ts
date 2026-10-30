// 文字度量与折行。
//
// 为什么要有这一层：SVG 的 `<text>` 不会自己折行，折行必须在生成路径前算完。而
// 「算宽度」在面板里和在测试里是两种环境——面板有 canvas 可以真量，bun 测试里没有
// DOM。所以度量做成可注入的：面板注入 canvas 版，测试注入确定性版，`render()`
// 本身保持纯函数，golden 快照才稳。
//
// 节点的 w/h 是权威的（见 digram.rs 的格式说明），所以这里只做两件事：把标签折成
// 能塞进给定宽度的若干行，塞不下时按档降字号到下限。永不改框。

export interface TextMeasurer {
  /** 一行文字在给定字号/字重下的像素宽度。 */
  width(text: string, fontSize: number, weight: 'regular' | 'medium'): number
}

/** 降字号的下限。再小就不是「挤一挤」而是不可读了，此时宁可截断。 */
const MIN_FONT_SIZE = 9
/** 每档降 1px。 */
const FONT_STEP = 1
/** 行高倍数。 */
export const LINE_HEIGHT = 1.35

/**
 * 确定性度量：按字符类别估宽，不依赖任何环境。
 *
 * 测试用它（golden 快照要可复现），面板拿不到 canvas 时也退到它。估值刻意保守
 * （偏宽），宁可多折一行也不要在真实字体下溢出框。
 */
export const approximateMeasurer: TextMeasurer = {
  width(text, fontSize, weight) {
    let em = 0
    for (const char of text) {
      em += charWidthEm(char)
    }
    // medium 比 regular 略宽。
    return em * fontSize * (weight === 'medium' ? 1.03 : 1)
  },
}

/** 单字符的宽度（em）。分类而非查表：一张真实字宽表会和实际字体绑死，而这里的
 *  用途是「够准的估计」，分类足够且不会随字体版本漂移。 */
function charWidthEm(char: string): number {
  const code = char.codePointAt(0) ?? 32
  // CJK、假名、全角标点：方块字，一个字一个 em。
  if (
    (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 1
  }
  if (char === ' ') return 0.28
  if ('iljI.,:;\'"|!`'.includes(char)) return 0.28
  if ('ftr()[]{}/\\-'.includes(char)) return 0.36
  if ('mwMW@'.includes(char)) return 0.85
  if (char >= 'A' && char <= 'Z') return 0.66
  if (char >= '0' && char <= '9') return 0.56
  return 0.54
}

/** canvas 版度量。面板里用，字体栈与主题一致。measureText 结果按 (字号,字重,文本)
 *  记忆化：一次重渲要量成百上千个词，重复量同一个词是纯浪费。 */
export function canvasMeasurer(fontFamily: string): TextMeasurer {
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas')
  const ctx = canvas?.getContext('2d') ?? null
  if (!ctx) return approximateMeasurer
  const cache = new Map<string, number>()
  return {
    width(text, fontSize, weight) {
      const key = `${fontSize}|${weight}|${text}`
      const hit = cache.get(key)
      if (hit !== undefined) return hit
      ctx.font = `${weight === 'medium' ? 500 : 400} ${fontSize}px ${fontFamily}`
      const measured = ctx.measureText(text).width
      // 缓存无界会随会话涨；到量就整清，比 LRU 简单且这里的重建成本可忽略。
      if (cache.size > 4000) cache.clear()
      cache.set(key, measured)
      return measured
    },
  }
}

export interface WrappedText {
  lines: string[]
  fontSize: number
  /** 整块文字的高度，行高已计入。 */
  height: number
  /** 最宽一行的宽度。 */
  width: number
  /** 是否有内容被丢弃（降到下限仍塞不下）。渲染面据此加省略号。 */
  truncated: boolean
}

/**
 * 把标签折进 `maxWidth` × `maxHeight`。
 *
 * 先按给定字号折行；行数超出高度就降一档再试，直到 `MIN_FONT_SIZE`。到下限仍超出
 * 就截断并标记——静默丢字会让作者以为文字写进去了。
 */
export function wrapLabel(
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontSize: number,
  weight: 'regular' | 'medium',
  measurer: TextMeasurer,
): WrappedText {
  const trimmed = text.replace(/\r/g, '')
  if (!trimmed) {
    return { lines: [], fontSize, height: 0, width: 0, truncated: false }
  }
  let size = Math.max(MIN_FONT_SIZE, fontSize)
  for (;;) {
    const lines = layoutLines(trimmed, maxWidth, size, weight, measurer)
    const height = lines.length * size * LINE_HEIGHT
    if (height <= maxHeight || size <= MIN_FONT_SIZE) {
      const maxLines = Math.max(1, Math.floor(maxHeight / (size * LINE_HEIGHT)))
      const truncated = lines.length > maxLines
      const kept = truncated ? lines.slice(0, maxLines) : lines
      if (truncated && kept.length) {
        kept[kept.length - 1] = ellipsize(kept[kept.length - 1], maxWidth, size, weight, measurer)
      }
      return {
        lines: kept,
        fontSize: size,
        height: kept.length * size * LINE_HEIGHT,
        width: kept.reduce((widest, line) => Math.max(widest, measurer.width(line, size, weight)), 0),
        truncated,
      }
    }
    size -= FONT_STEP
  }
}

/** 一次折行：显式换行优先，然后按词/字断。 */
function layoutLines(
  text: string,
  maxWidth: number,
  fontSize: number,
  weight: 'regular' | 'medium',
  measurer: TextMeasurer,
): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      out.push('')
      continue
    }
    let line = ''
    for (const token of tokenize(paragraph)) {
      const candidate = line + token
      if (line && measurer.width(candidate.trimEnd(), fontSize, weight) > maxWidth) {
        out.push(line.trimEnd())
        // 行首不留空格：换行后的前导空白会让居中看起来偏了。
        line = token.trimStart()
      } else {
        line = candidate
      }
      // 单个 token 本身就超宽（长标识符、长串 CJK）时硬断，否则会溢出框。
      while (measurer.width(line, fontSize, weight) > maxWidth && line.length > 1) {
        let cut = line.length - 1
        while (cut > 1 && measurer.width(line.slice(0, cut), fontSize, weight) > maxWidth) cut -= 1
        out.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    if (line.trimEnd()) out.push(line.trimEnd())
    else if (!out.length) out.push('')
  }
  return out
}

/**
 * 切词。拉丁文按空白后断，CJK 每字可断——CJK 没有词间空格，只按空白断会把一整句
 * 中文当成一个不可断的 token，然后被上面的硬断逻辑切在随机位置。
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let buffer = ''
  for (const char of text) {
    if (isCjk(char)) {
      if (buffer) {
        tokens.push(buffer)
        buffer = ''
      }
      tokens.push(char)
      continue
    }
    buffer += char
    if (char === ' ') {
      tokens.push(buffer)
      buffer = ''
    }
  }
  if (buffer) tokens.push(buffer)
  return tokens
}

function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xff60)
  )
}

function ellipsize(
  line: string,
  maxWidth: number,
  fontSize: number,
  weight: 'regular' | 'medium',
  measurer: TextMeasurer,
): string {
  const suffix = '…'
  if (measurer.width(line + suffix, fontSize, weight) <= maxWidth) return line + suffix
  let cut = line.length
  while (cut > 0 && measurer.width(line.slice(0, cut) + suffix, fontSize, weight) > maxWidth) {
    cut -= 1
  }
  return line.slice(0, cut) + suffix
}
