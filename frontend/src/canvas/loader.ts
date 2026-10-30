// Compiling and mounting a `.canvas.tsx`.
//
// The transform is Sucrase: strip TypeScript, turn JSX into calls, rewrite the
// ES imports to `require`. That last flag is what makes the rest of this simple.
// The alternatives were worse:
//
//   - A blob URL plus a real `import()` needs `script-src blob:` AND an import
//     map pointing at a build-hashed SDK chunk, so the page would have to learn
//     its own asset hashes.
//   - A local HTTP server to serve the module the way an IDE does means a port,
//     a lifetime, and an origin to defend, for one page in one window.
//
// Compiling to CommonJS and calling the factory with a `require` we control needs
// neither. `require` is a closed map — the SDK, React, React's JSX runtimes —
// so an import of anything else fails with a message naming the specifier
// instead of a bare `Cannot find module`.
//
// That map is a BACKSTOP, not the gate. TypeScript import elision drops any
// binding the module never uses, so `import { z } from 'zod'` followed by no use
// of `z` never reaches `require` at all (pinned in loader.test.ts). The gate is
// the host's `canvas_check`, which reads import STATEMENTS and does not care
// whether they are used. Weakening that check on the theory that the runtime will
// catch a bad import would let the unused half through silently.
//
// This does mean the page runs `new Function`, so its CSP carries
// `'unsafe-eval'`. That is not a new capability boundary: the code being
// evaluated was written to disk by an agent that already has a shell, and the
// page is deliberately loaded WITHOUT the `window.klaus` bridge so a canvas has
// only the narrow SDK surface to reach for.

import { transform } from 'sucrase'
import * as React from 'react'
import type { ComponentType } from 'react'

import * as canvasSdk from './sdk'
import type { CanvasRuntimeConfig, CanvasShellConfig } from './sdk/shell'

export type { CanvasRuntimeConfig, CanvasShellConfig, CanvasShellMode } from './sdk/shell'

/** What a canvas module is allowed to import, by specifier. */
const MODULES: Record<string, unknown> = {
  'klaus/canvas': canvasSdk,
  react: React,
  // Sucrase's JSX output calls the classic `React.createElement`, so the
  // automatic runtimes are here only for a canvas that imports them by hand.
  'react/jsx-runtime': React,
  'react/jsx-dev-runtime': React,
}

/**
 * Where a failure happened. The page renders each kind differently: a compile
 * error can point at a line, a mount error has a component stack instead.
 *
 * `load` is the host leg — the file is missing, unreadable, or out of scope — and
 * it exists so the panel does not tell the user a canvas "failed while
 * rendering" when it was never read in the first place.
 */
export type CanvasFailureStage = 'load' | 'compile' | 'evaluate' | 'export'

export class CanvasLoadError extends Error {
  constructor(
    readonly stage: CanvasFailureStage,
    message: string,
    readonly line?: number,
  ) {
    super(message)
    this.name = 'CanvasLoadError'
  }
}

/**
 * The headline the failure panel shows for each stage.
 *
 * Lives here, next to the stages themselves, so adding a stage without giving it
 * a headline is a type error rather than a silent fall-through to "failed while
 * rendering" — which is exactly how a missing FILE ended up reported as a
 * rendering fault. `render` is the boundary's own stage: a throw from inside the
 * mounted tree, which is not a `CanvasLoadError` at all.
 */
export function failureHeading(stage: CanvasFailureStage | 'render'): string {
  switch (stage) {
    case 'load':
      return 'This canvas could not be read'
    case 'compile':
      return 'This canvas does not compile'
    case 'evaluate':
      return 'This canvas failed while loading'
    case 'export':
      return 'This canvas has no component to render'
    case 'render':
      return 'This canvas failed while rendering'
  }
}

/**
 * Sucrase reports a syntax error with a `(line:column)` suffix on the message and
 * a `loc` on the error object. Pull the line out so the page can show it, and
 * keep the raw message — it is the most specific thing anyone has about the
 * failure.
 */
function compileErrorFrom(error: unknown): CanvasLoadError {
  const raw = error instanceof Error ? error.message : String(error)
  const loc = (error as { loc?: { line?: number } } | null)?.loc
  const fromLoc = typeof loc?.line === 'number' ? loc.line : undefined
  const fromMessage = /\((\d+):\d+\)/.exec(raw)
  const line = fromLoc ?? (fromMessage ? Number(fromMessage[1]) : undefined)
  // Sucrase prefixes its own file label; it is noise in a one-file world.
  const message = raw.replace(/^Error: /, '').replace(/^unknown: /, '')
  return new CanvasLoadError('compile', message, line)
}

/** Transform canvas source to a CommonJS factory body. */
export function compileCanvas(source: string): string {
  try {
    return transform(source, {
      transforms: ['typescript', 'jsx', 'imports'],
      // The classic runtime keeps `React` as the only implicit dependency, which
      // is one thing to inject rather than a runtime import the loader would
      // have to resolve before the module body runs.
      jsxRuntime: 'classic',
      production: true,
    }).code
  } catch (error) {
    throw compileErrorFrom(error)
  }
}

/** The shape a canvas module exposes after evaluation. */
interface CanvasModule {
  default?: unknown
  canvasConfig?: unknown
}

/**
 * How the window frames the canvas. The shape lives in `sdk/shell.ts` — a canvas
 * has to be able to import it to annotate its own `canvasConfig`, and only the
 * SDK's declaration output reaches a canvas.
 */

/** A loaded canvas: its component, plus whatever shell it asked for. */
export interface LoadedCanvas {
  component: ComponentType
  config: CanvasRuntimeConfig
}

/**
 * Read the optional `canvasConfig` export.
 *
 * Deliberately lenient. A malformed config must not stop a canvas from
 * rendering: the component is the thing the user asked for, and refusing to
 * mount it because `shell.padding` was a boolean would trade a cosmetic mistake
 * for a blank window. Unknown fields and wrong types are dropped.
 */
function readConfig(module: CanvasModule): CanvasRuntimeConfig {
  const raw = module.canvasConfig
  if (!raw || typeof raw !== 'object') return {}
  const shellRaw = (raw as { shell?: unknown }).shell
  if (!shellRaw || typeof shellRaw !== 'object') return {}
  const source = shellRaw as Record<string, unknown>
  const shell: CanvasShellConfig = {}
  if (source.mode === 'full-bleed' || source.mode === 'inset') shell.mode = source.mode
  for (const key of ['padding', 'fontSize', 'lineHeight'] as const) {
    const value = source[key]
    if (typeof value === 'string' || typeof value === 'number') shell[key] = value
  }
  for (const key of ['background', 'color', 'fontFamily'] as const) {
    const value = source[key]
    if (typeof value === 'string') shell[key] = value
  }
  return Object.keys(shell).length > 0 ? { shell } : {}
}

/**
 * Evaluate a compiled canvas and return its default export plus its config.
 *
 * The factory gets `exports`, `module`, and `require` — the three names Sucrase's
 * CommonJS output uses — and nothing else it could not already reach through
 * globals. `React` is injected as a parameter because the classic JSX transform
 * emits bare `React.createElement` calls.
 */
export function evaluateCanvas(compiled: string): LoadedCanvas {
  const exports: CanvasModule = {}
  const module = { exports }
  const require = (specifier: string): unknown => {
    const resolved = MODULES[specifier]
    if (!resolved) {
      throw new CanvasLoadError(
        'evaluate',
        `cannot import '${specifier}': a canvas may only import from 'klaus/canvas'`,
      )
    }
    return resolved
  }
  try {
    // eslint-disable-next-line no-new-func -- see the module comment: the CSP
    // grant is deliberate and the input is agent-authored code from disk.
    const factory = new Function('exports', 'module', 'require', 'React', compiled)
    factory(exports, module, require, React)
  } catch (error) {
    if (error instanceof CanvasLoadError) throw error
    throw new CanvasLoadError('evaluate', error instanceof Error ? error.message : String(error))
  }
  // `module.exports` first: a canvas that assigned the whole object replaced the
  // one the factory was handed, so reading only `exports` would miss everything.
  const resolved = (module.exports as CanvasModule) ?? exports
  const component = resolved.default ?? exports.default
  if (typeof component !== 'function') {
    throw new CanvasLoadError(
      'export',
      component === undefined
        ? 'no default export: a canvas must `export default` its top-level React component'
        : 'the default export is not a component: `export default` must be a function returning JSX',
    )
  }
  return { component: component as ComponentType, config: readConfig(resolved) }
}

/** Compile and evaluate in one step. */
export function loadCanvas(source: string): LoadedCanvas {
  return evaluateCanvas(compileCanvas(source))
}
