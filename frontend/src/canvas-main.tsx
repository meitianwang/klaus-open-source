// The isolated Canvas panel webview's entry point.
//
// Reads the target path from the query, asks the host for the source and the
// persisted state, compiles, mounts. Everything user-visible that is NOT the
// canvas itself — the title bar, the error panel, the reload — lives here rather
// than in the SDK, because a canvas must not be able to draw over its own chrome.
//
// The bridge import is `bridge/canvas-api`, NOT `bridge/klaus-api`: this page
// evaluates model-authored code, so it gets the four-call canvas surface instead
// of every host capability. Import order matters — `window.klausCanvas` has to
// exist before the frame's first load call.

import '../bridge/canvas-api'
import { installTabFocusPolicy } from './app/tab-focus-policy'

import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'

import { CanvasFrame } from './canvas/CanvasFrame'
import './canvas/canvas-window.css'

installTabFocusPolicy()

function parameter(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? ''
}

const container = document.getElementById('canvas-root')
if (!container) throw new Error('canvas.html is missing #canvas-root')

createRoot(container).render(
  <StrictMode>
    <CanvasFrame filePath={parameter('filePath')} displayName={parameter('displayName')} />
  </StrictMode>,
)
