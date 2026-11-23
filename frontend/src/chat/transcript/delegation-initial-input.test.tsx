import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { encodeDelegationEnvelope, initialDelegationMetadata } from '../../../../contracts/thread-delegation'

let transcript: typeof import('./TranscriptView')
let factories: typeof import('./factories')
const originalWindow = (globalThis as any).window
const vector = JSON.parse(readFileSync(new URL('../../../../contracts/vectors/thread-delegation-vectors.json', import.meta.url), 'utf8')).initialInput
const prompt = vector.input as string
const envelope = encodeDelegationEnvelope(prompt, 'creator')
const message = (extra: Record<string, unknown> = {}) => ({ role: 'user', uuid: 'initial', turnId: 'turn-1', text: envelope, ...extra })
const marked = () => message({ localRender: initialDelegationMetadata(prompt) })
const answer = { role: 'assistant', uuid: 'answer', turnId: 'turn-1', isFinalReply: true, contentBlocks: [
  { type: 'text', text: 'Checking the task.', phase: 'commentary' },
  { type: 'tool_use', id: 'read', name: 'read', input: { path: '/fixture' }, __result: { content: [{ type: 'text', text: 'result' }] } },
  { type: 'text', text: 'Finished.', phase: 'final_answer', isFinalReply: true },
] }

beforeAll(async () => {
  ;(globalThis as any).window = {
    addEventListener: () => {}, currentLang: 'en',
    klaus: { media: { url: (path: string) => path } },
  }
  transcript = await import('./TranscriptView')
  factories = await import('./factories')
})
afterAll(() => {
  if (originalWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = originalWindow
})

describe('a created conversation starts with an owner input', () => {
  test('the display metadata matches the committed contract', () => {
    expect(initialDelegationMetadata(prompt)).toEqual(vector.displayMetadata)
  })

  test('live and saved input keep their source envelope while projecting as a user', () => {
    const saved = transcript.unitsFromMessages([marked()])[0]!
    const live = transcript.liveUserRenderUnits({ turnId: 'turn-1', msg: marked() })[0]!
    expect(saved.type).toBe('user')
    expect(live.type).toBe('user')
    expect(saved.msg.text).toBe(envelope)
    expect(factories.userCopyText(saved.msg, true)).toBe(prompt)
    expect(factories.userCopyText(live.msg, true)).toBe(prompt)
  })

  test('completed and manually collapsed work keep the initial input above the fold', () => {
    const units = transcript.unitsFromMessages([marked(), answer])
    for (const collapsed of [undefined, false, true]) {
      const nodes = transcript.foldUnits(units, null, { 'turn-1': 'completed' },
        collapsed === undefined ? {} : { 'turn:turn-1': !collapsed })
      expect(nodes[0]?.kind).toBe('unit')
      expect((nodes[0] as any).unit.type).toBe('user')
      expect((nodes[0] as any).unit.msg.uuid).toBe('initial')
      const fold = nodes.find(node => node.kind === 'turn-fold')
      expect(fold).toBeTruthy()
      expect(fold!.items.some((node: any) => node.kind === 'unit' && node.unit.msg?.uuid === 'initial')).toBe(false)
    }
  })

  test('a live input acknowledgement arriving after work still leads the turn', () => {
    const nodes = transcript.groupLiveActivityUnits([
      { type: 'live-text', key: 'work', turnId: 'turn-1', text: 'Checking.', phase: 'commentary' },
      { type: 'live-user', key: 'initial', turnId: 'turn-1', msg: marked() },
      { type: 'live-text', key: 'done', turnId: 'turn-1', text: 'Finished.', phase: 'final_answer' },
    ] as any, {}, false, false)
    expect(nodes[0]?.kind).toBe('unit')
    expect((nodes[0] as any).unit.key).toBe('initial')
    expect(nodes.find(node => node.kind === 'turn')).toBeTruthy()
  })

  test('a final reply before the initial input acknowledgement does not put the input below the reply', () => {
    const nodes = transcript.groupLiveActivityUnits([
      { type: 'live-text', key: 'work', turnId: 'turn-1', text: 'Checking.', phase: 'commentary' },
      { type: 'live-text', key: 'done', turnId: 'turn-1', text: 'Finished.', phase: 'final_answer' },
      { type: 'live-user', key: 'initial', turnId: 'turn-1', msg: marked() },
    ] as any, {}, false, false)
    expect((nodes[0] as any).unit.key).toBe('initial')
    const replay = transcript.foldUnits(transcript.unitsFromMessages([answer, marked()]), null, { 'turn-1': 'completed' }, {})
    expect((replay[0] as any).unit.msg.uuid).toBe('initial')
  })

  test('the real row uses the owner side, keeps provenance and copies only the task', () => {
    const html = renderToStaticMarkup(<transcript.StaticTranscriptView container={{} as HTMLElement} running={false} msgs={[marked()]} />)
    expect(html).toContain('data-owner-sender="true"')
    expect(html).toContain('data-owner-sender-col')
    expect(html).not.toContain('data-agent-sender-col')
    expect(html).not.toContain('data-external-sender="true"')
    expect(html).toContain('Sent by Klaus from another chat')
    expect(html).toContain(`data-copy-text="${prompt}"`)
    expect(html).not.toContain('&lt;klaus-delegation&gt;')
  })

  test('later coordination stays on the agent side even when it starts a new turn', () => {
    const followUp = message({ uuid: 'coordination', turnId: 'turn-2', text: encodeDelegationEnvelope('Also check the log.', 'creator') })
    expect(transcript.unitsFromMessages([marked(), followUp]).map(unit => unit.type)).toEqual(['user', 'delegation'])
    const html = renderToStaticMarkup(<transcript.StaticTranscriptView container={{} as HTMLElement} running={false} msgs={[followUp]} />)
    expect(html).toContain('data-agent-sender-col')
    expect(html).toContain('data-external-sender="true"')
    expect(html).not.toContain('data-owner-sender="true"')
  })

  test('legacy creation promotes only the first input from its recorded creator', () => {
    const rows = [message(), message({ uuid: 'later', turnId: 'turn-2' })]
    const units = transcript.unitsFromMessages(rows, 'creator')
    expect(units.map(unit => unit.type)).toEqual(['user', 'delegation'])
    expect(units[0]!.msg.localRender).toEqual(vector.displayMetadata)
    expect(factories.userCopyText(units[0]!.msg, true)).toBe(prompt)
  })

  test('a bounded recent page without confirmed creation context keeps coordination as delegation', () => {
    expect(transcript.unitsFromMessages([message()])[0]!.type).toBe('delegation')
    expect(transcript.unitsFromMessages([message()], 'different-creator')[0]!.type).toBe('delegation')
    expect(transcript.unitsFromMessages([
      message({ text: 'An earlier owner input.' }), message({ uuid: 'later' }),
    ], 'creator').map(unit => unit.type)).toEqual(['user', 'delegation'])
  })

  test('the initial input is editable using its persisted identity', () => {
    const units = transcript.unitsFromMessages([marked()])
    expect(transcript.editTargetFor(units, [])).toEqual({ uuid: 'initial', turnId: 'turn-1' })
  })

  test('a mobile turn opener leads the running turn with image and file previews while steers stay inline', () => {
    const openerMsg = {
      role: 'user',
      uuid: 'mobile-open-1',
      turnId: 'turn-mobile',
      text: 'Check this rendering\n\nAttached:\n- /fixture/notes.txt',
      contentBlocks: [
        { type: 'text', text: 'Check this rendering\n\nAttached:\n- /fixture/notes.txt' },
        { type: 'image', path: '/fixture/photo.jpg', name: 'photo.jpg' },
      ],
      localRender: {
        clientMessageId: 'mobile-client-1',
        displayText: 'Check this rendering',
        attachments: [{ type: 'file', name: 'notes.txt', path: '/fixture/notes.txt', mimeType: 'text/plain' }],
        inputPresentation: { version: 1, kind: 'turn' },
      },
    }
    const steerMsg = {
      role: 'user',
      uuid: 'mobile-steer-1',
      turnId: 'turn-mobile',
      steered: true,
      text: 'Also check dark mode',
      contentBlocks: [{ type: 'text', text: 'Also check dark mode' }],
      localRender: {
        clientMessageId: 'mobile-client-2',
        inputPresentation: { version: 1, kind: 'steer' },
      },
    }
    const nodes = transcript.groupLiveActivityUnits([
      { type: 'live-text', key: 'work-1', turnId: 'turn-mobile', text: 'Inspecting.', phase: 'commentary' },
      { type: 'live-user', key: 'open-key', turnId: 'turn-mobile', msg: openerMsg },
      { type: 'live-compaction', key: 'compact-1', turnId: 'turn-mobile', trigger: 'auto' },
      { type: 'live-user', key: 'steer-key', turnId: 'turn-mobile', msg: steerMsg },
    ] as any, {}, true, false)
    expect(nodes[0]?.kind).toBe('unit')
    expect((nodes[0] as any).unit?.key).toBe('open-key')
    const turnNode = nodes.find(node => node.kind === 'turn') as any
    expect(turnNode?.items?.some((node: any) => node.kind === 'unit' && node.unit?.key === 'steer-key')).toBe(true)

    const html = renderToStaticMarkup(<transcript.StaticTranscriptView container={{} as HTMLElement} running={false} msgs={[openerMsg]} />)
    expect(html).toContain('Check this rendering')
    expect(html).toContain('/fixture/photo.jpg')
    expect(html).toContain('notes.txt')
  })
})
