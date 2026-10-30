// Klaus 桌面端前端构建配置（frontend → frontend-dist）。
//
// 三个窗口三种形态：
//   - index.html    主窗口，module 入口 src/main.ts
//   - artifact.html 预览窗，module 入口 src/artifact-main.ts（CSP script-src 'self'）
//   - canvas.html   Canvas 预览窗，module 入口 src/canvas-main.tsx；CSP 额外带
//     'unsafe-eval'，因为它要在页内用 Sucrase 编译并求值 .canvas.tsx（理由见
//     src/canvas/loader.ts）
//   - overlay.html  电脑操控光标浮层，自包含内联脚本（CSP 'unsafe-inline'）
//   - quick-input.html 迷你输入窗，CSP 只允许 'unsafe-inline'——不能挂外链
//     script，由 quickInputInline 插件把 bridge/quick-input-api.ts 与
//     src/quick-input-main.ts 打包后依序内联（api 先、页面逻辑后），
//     与旧 build-frontend.mjs 的注入行为一致
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import * as esbuild from 'esbuild'
import { assertSelfHostedFontAssets } from './scripts/frontend-font-assets.mjs'
import { assertFrontendChunkBudget } from './scripts/frontend-bundle-budget.mjs'
import { frontendDiagramWorker } from './scripts/frontend-diagram-worker.mjs'
import { parserModules } from './scripts/frontend-parser-modules.mjs'
import { shikiDataAssetsPlugin } from './scripts/shiki-data-assets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const frontend = join(here, 'frontend')
const DEV_PORT = 5180

function bundleIife(entry: string): string {
  const result = esbuild.buildSync({
    entryPoints: [join(frontend, entry)],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'safari15',
  })
  return result.outputFiles[0].text
}

function injectQuickInput(html: string): string {
  // 两段依序内联到 </body> 前：api 段先（window.klausQuickInput 就位），
  // 页面逻辑段后（迁自原 HTML 内联 <script>，现为 src/quick-input-main.ts）。
  const anchor = html.indexOf('</body>')
  if (anchor === -1) throw new Error('quick-input.html: no </body> anchor found')
  const scripts = `  <script>\n${bundleIife('bridge/quick-input-api.ts')}\n  </script>\n`
    + `  <script>\n${bundleIife('src/quick-input-main.ts')}\n  </script>\n`
  return html.slice(0, anchor) + scripts + html.slice(anchor)
}

function quickInputInline(): Plugin {
  let outDir = ''
  return {
    name: 'klaus:quick-input-inline',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith('/quick-input.html')) return next()
        const html = readFileSync(join(frontend, 'quick-input.html'), 'utf8')
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(injectQuickInput(html))
      })
    },
    closeBundle() {
      const html = readFileSync(join(frontend, 'quick-input.html'), 'utf8')
      writeFileSync(join(outDir, 'quick-input.html'), injectQuickInput(html))
    },
  }
}

// dev 下 HMR 走 WebSocket；index.html 的 meta CSP connect-src 不含 ws，
// WKWebView 对 ws 匹配 'self' 的行为不可靠，显式加白 dev 源。构建产物不动。
function devCspAllowHmr(): Plugin {
  return {
    name: 'klaus:dev-csp-hmr',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        "connect-src 'self' ipc: http://ipc.localhost;",
        `connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:${DEV_PORT} ws://localhost:${DEV_PORT};`,
      )
    },
  }
}

// Canvas 独立预览：dev 下把 ~/.klaus/canvas/canvases 里的 .canvas.tsx 源码喂给
// canvas.html，让 SDK 能在浏览器里直接迭代（bridge/canvas-api.ts 的 dev stub 打
// 这个端点）。没有它，改一个组件就得重新打包+重启 app 才能看一眼。
//
// apply: 'serve' —— 只在 dev server 存在；构建产物里没有这条路由，生产页面也走不到
// 这里（dev stub 被 import.meta.env.DEV 编译期消掉了）。
//
// 作用域与 Rust 侧 canvas::scope_allows 一致：必须在 canvas 根目录内、必须是
// .canvas.tsx。dev server 只监听 127.0.0.1，但「本机上任意网页都能请求它」是真
// 的，所以这条路由不能变成任意文件读取。
function canvasDevSource(): Plugin {
  return {
    name: 'klaus:canvas-dev-source',
    apply: 'serve',
    configureServer(server) {
      const canvasRoot = join(
        process.env.KLAUS_CONFIG_DIR || join(homedir(), '.klaus'),
        'canvas',
      )
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next()
        const canvasesDir = join(canvasRoot, 'canvases')

        // The switcher's list. Mirrors the shell's `canvas:list`: only
        // `.canvas.tsx` under the canvas root, newest first.
        if (req.url.startsWith('/__canvas__/list')) {
          let canvases: { filePath: string; name: string; modifiedMs: number }[] = []
          try {
            canvases = readdirSync(canvasesDir)
              .filter((name) => name.endsWith('.canvas.tsx'))
              .map((name) => {
                const full = join(canvasesDir, name)
                return {
                  filePath: full,
                  name: name.slice(0, -'.canvas.tsx'.length),
                  modifiedMs: statSync(full).mtimeMs,
                }
              })
              .sort((a, b) => b.modifiedMs - a.modifiedMs)
          } catch {
            canvases = []
          }
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: true, canvases }))
          return
        }

        if (!req.url.startsWith('/__canvas__/load')) return next()
        const requested = new URL(req.url, 'http://localhost').searchParams.get('filePath') || ''
        const target = resolve(requested)
        const inside = target === canvasRoot || target.startsWith(canvasRoot + sep)
        if (!inside || !target.endsWith('.canvas.tsx')) {
          res.statusCode = 403
          res.end('not a canvas inside the canvas root')
          return
        }
        try {
          const source = readFileSync(target, 'utf8')
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ source }))
        } catch (error) {
          res.statusCode = 404
          res.end(error instanceof Error ? error.message : 'cannot read that canvas')
        }
      })
    },
  }
}

export default defineConfig({
  root: frontend,
  plugins: [frontendDiagramWorker(), parserModules(), shikiDataAssetsPlugin({ root: here }), react(), quickInputInline(), devCspAllowHmr(), canvasDevSource(), {
    name: 'klaus:renderer-chunk-budget',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const result = assertFrontendChunkBudget(bundle)
        console.info(`[frontend-chunks] ${result.chunks} JavaScript chunks checked; largest ${result.largest} bytes`)
      },
    },
  }, {
    name: 'klaus:self-hosted-fonts',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const result = assertSelfHostedFontAssets(bundle)
        console.info(`[font-assets] ${result.fonts} same-origin fonts checked across ${result.stylesheets} stylesheets`)
      },
    },
  }, {
    // three.js (~530 kB) must stay OFF the startup graph: the 3D panel is lazy,
    // so a session that never opens it should never download a WebGL stack. The
    // `model3d-3d` group's maxSize below is what keeps the shared runtime helper
    // out of the viewport chunk — but that is a size heuristic, and a future edit
    // that grows the viewport could silently flip it. This guard walks the real
    // chunk graph after bundling and FAILS the build if three is statically
    // reachable from the index entry, so the regression cannot ship quietly.
    name: 'klaus:three-not-on-startup',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        // The main window's entry chunk is the one whose facade is index.html
        // (Vite uses the HTML file as the entry, not src/main.ts).
        const chunks = Object.values(bundle).filter((chunk): chunk is Extract<typeof chunk, { type: 'chunk' }> => chunk.type === 'chunk')
        const start = chunks.find(chunk => chunk.isEntry && typeof chunk.facadeModuleId === 'string' && chunk.facadeModuleId.endsWith('/frontend/index.html'))
        if (!start) return
        const isThree = (code: string): boolean => code.includes('WebGLRenderer')
        // Walk STATIC edges only (`imports`). `dynamicImports` is the lazy
        // boundary we are protecting, so it is deliberately not followed.
        const seen = new Set<string>()
        const stack = [start.fileName]
        const onStartup: string[] = []
        const petWindowOnStartup: string[] = []
        const voiceWindowOnStartup: string[] = []
        while (stack.length) {
          const name = stack.pop()!
          if (seen.has(name)) continue
          seen.add(name)
          const chunk = bundle[name]
          if (!chunk || chunk.type !== 'chunk') continue
          if (isThree(chunk.code ?? '')) onStartup.push(name)
          if (Object.keys(chunk.modules).some(id => /[\\/]frontend[\\/]src[\\/]pets[\\/]main\.tsx(?:\?|$)/.test(id))) {
            petWindowOnStartup.push(name)
          }
          if (Object.keys(chunk.modules).some(id => /[\\/]frontend[\\/]src[\\/]chat[\\/]voice-chat[\\/]overlay\.(?:tsx|css)(?:\?|$)/.test(id))) {
            voiceWindowOnStartup.push(name)
          }
          stack.push(...chunk.imports)
        }
        if (petWindowOnStartup.length) {
          throw new Error(`The companion window entry is statically reachable from the main window (${petWindowOnStartup.join(', ')}). `
            + `Keep the pet-window code-splitting group separate so its window stylesheet cannot enter the main window.`)
        }
        if (voiceWindowOnStartup.length) {
          throw new Error(`The voice overlay entry is statically reachable from the main window (${voiceWindowOnStartup.join(', ')}). `
            + `Keep the voice-window code-splitting group separate so its window stylesheet cannot enter the main window.`)
        }
        if (onStartup.length) {
          throw new Error(`three.js is statically reachable from the index entry (${onStartup.join(', ')}). `
            + `The 3D viewport must stay behind its dynamic import — lower the 'model3d-3d' group maxSize in vite.config.mts so the shared runtime helper is not bundled into the three chunk.`)
        }
      },
    },
  }],
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'safari15',
    // Small KaTeX fonts must remain files because font-src allows only 'self'.
    assetsInlineLimit: filePath => /\.(?:woff2?|ttf|otf|eot)$/i.test(filePath) ? false : undefined,
    outDir: join(here, 'frontend-dist'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Preserve the ordered window bridge initialization while splitting
        // the desktop and Markdown dependencies into bounded cacheable chunks.
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            // Keep window-wide pet styles on the pet entry. Shared pet components
            // can still be used by settings without importing the window reset.
            { name: 'pet-window', test: /frontend[\\/]src[\\/]pets[\\/](?:main\.tsx|pet\.css)(?:$|\?)/, includeDependenciesRecursively: false, maxSize: 400_000 },
            // Floating voice controls own their document reset; shared voice
            // components remain available to the main conversation surface.
            { name: 'voice-window', test: /frontend[\\/]src[\\/]chat[\\/]voice-chat[\\/]overlay\.(?:tsx|css)(?:$|\?)/, includeDependenciesRecursively: false, maxSize: 400_000 },
            // three.js (~530 kB) backs only the 3D panel, which panel.ts reaches
            // through a dynamic import. Without its own group the viewport joins
            // the 'desktop' group by size, that group is statically reachable
            // from the chat entry, and the dynamic import collapses into a plain
            // one — putting a WebGL stack every session downloads on the
            // startup path even when the panel is never opened. Group order
            // matters: the first matching group wins.
            { name: 'model3d-3d', test: /frontend\/src\/chat\/model3d\/(?:viewport|pathtrace)|node_modules\/(?:three|three-gpu-pathtracer|three-mesh-bvh|xatlas-web)\//, maxSize: 10_000 },
            { name: 'vendor', test: /node_modules/, maxSize: 400_000 },
            { name: 'desktop', test: /frontend\/src\//, maxSize: 400_000 },
          ],
        },
      },
      input: {
        index: join(frontend, 'index.html'),
        artifact: join(frontend, 'artifact.html'),
        canvas: join(frontend, 'canvas.html'),
        overlay: join(frontend, 'overlay.html'),
        recorder: join(frontend, 'recorder.html'),
        pet: join(frontend, 'pet.html'),
        'voice-chat': join(frontend, 'voice-chat.html'),
      },
    },
  },
})
