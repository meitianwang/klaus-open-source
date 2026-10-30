import { ImageZoomCommands, readImageZoomCommand, type ImageZoomCommand } from '../main/app/image-zoom-commands'
import { Harness, assertEqual, assertDeepEqual } from './harness'
import { join } from 'node:path'
const h = new Harness()
const key = { type: 'keyDown', key: '=', shift: false, control: false, alt: false, meta: true }
h.test('platform zoom keys include physical and numpad keys and retain modifier exclusions', () => {
  assertEqual(readImageZoomCommand(key, 'darwin'), 'in', 'Cmd Equal steps in')
  assertEqual(readImageZoomCommand({ ...key, key: '+', code: 'NumpadAdd' }, 'darwin'), 'in', 'numpad in')
  assertEqual(readImageZoomCommand({ ...key, key: '_', code: 'Minus', shift: true }, 'darwin'), 'out', 'shifted minus')
  assertEqual(readImageZoomCommand({ ...key, key: '0', code: 'Numpad0' }, 'darwin'), 'fit', 'reset is Fit')
  for (const extra of [{ alt: true }, { control: true }, { isComposing: true }, { type: 'keyUp' }])
    assertEqual(readImageZoomCommand({ ...key, ...extra }, 'darwin'), null, 'unowned modifier or event')
  assertEqual(readImageZoomCommand({ ...key, key: '0', shift: true }, 'darwin'), null, 'shift reset excluded')
  assertEqual(readImageZoomCommand({ ...key, control: true, meta: false }, 'win32'), 'in', 'Windows Control')
  assertEqual(readImageZoomCommand({ ...key, control: true, meta: false, key: '-' }, 'linux'), 'out', 'Linux Control')
})
h.test('image zoom ownership suppresses native window zoom and absent ownership falls back', async () => {
  const native: ImageZoomCommand[] = [], scripts: string[] = []
  let answer: unknown = true, detached = 0, prevented = 0
  let listener: any
  const router = new ImageZoomCommands({
    onBeforeInput: value => { listener = value; return () => { detached++ } },
    evaluate: async value => { scripts.push(value); return answer },
    nativeZoom: value => { native.push(value) },
  }, 'darwin')
  router.start(); router.start()
  listener({ preventDefault: () => { prevented++ } }, key)
  await router.dispatch('fit')
  assertEqual(prevented, 1, 'accelerator prevented before dispatch')
  assertEqual(scripts.length, 2, 'commands reach renderer once')
  assertDeepEqual(native, [], 'active image owns zoom')
  answer = false
  await router.dispatch('in')
  assertDeepEqual(native, [], 'failed but owned image does not zoom window')
  answer = null
  await router.dispatch('out')
  assertDeepEqual(native, ['out'], 'absent image uses window')
  router.close(); await router.dispatch('in')
  assertEqual(detached, 1, 'listener removed once')
  assertDeepEqual(native, ['out'], 'closed router does not deliver')
})
h.test('queued menu commands keep the originating renderer and native fallback together', async () => {
  const calls: string[] = []
  let release!: () => void
  const router = new ImageZoomCommands({
    onBeforeInput: () => () => {},
    evaluate: async () => { calls.push('main evaluate'); return true },
    nativeZoom: () => { calls.push('main native') },
  })
  const origin = {
    evaluate: async () => { calls.push('origin evaluate'); await new Promise<void>(resolve => { release = resolve }); return null },
    nativeZoom: () => { calls.push('origin native') },
  }
  const first = router.dispatch('in', origin)
  const second = router.dispatch('fit')
  await Promise.resolve()
  release(); await first; await second
  assertDeepEqual(calls, ['origin evaluate', 'origin native', 'main evaluate'], 'fallback retains the original window across await and queue')
  router.close()
})
void h.finish(join(__dirname, 'image-zoom-commands.result.json'), 'image-zoom-commands').then(code => { process.exitCode = code })
