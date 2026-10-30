// bun:test 的最小类型声明：仓库不装 bun-types（bun 只作为测试 runner 使用，
// tsc 由 vite/client types 驱动），测试文件里用到的 API 在此声明。
// bun 运行时提供真实实现，这份声明只服务 tsc。
declare module 'bun:test' {
  /** The matchers the tests name; anything else resolves through the index signature. */
  interface Matchers {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    [matcher: string]: (...args: unknown[]) => void
  }
  export function describe(label: string, fn: () => void): void
  export function test(label: string, fn: () => void | Promise<void>): void
  export function it(label: string, fn: () => void | Promise<void>): void
  export function beforeAll(fn: () => void | Promise<void>): void
  export function afterAll(fn: () => void | Promise<void>): void
  export function beforeEach(fn: () => void | Promise<void>): void
  export function afterEach(fn: () => void | Promise<void>): void
  // `.not` carries the same matcher surface, and it has to be declared next to
  // the index signature rather than through it: the signature types every member
  // as a callable, so `expect(x).not.toContain(...)` would resolve `.not` to a
  // function and then fail on the matcher behind it.
  export function expect(value: unknown): Matchers & { not: Matchers }
}
