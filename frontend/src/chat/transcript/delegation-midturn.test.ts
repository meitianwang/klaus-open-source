// A delegation delivered MID-TURN is drained by the engine into the turn's last
// tool result, so it never becomes a `user` message of its own. Its transcript
// presence therefore has to be reconstructed at projection time: the envelope is
// split out of the tool output (segmentsFromBlocks), lifted into a first-class
// `delegation` unit (unitsFromMessages), and kept as a PERSISTENT section of the
// turn fold at its arrival position, so a collapsed turn still shows that a
// message arrived exactly where it arrived (foldUnits). A steered message
// renders exactly like an idle-delivered one, which is the shape these tests pin.
import { describe, expect, test } from 'bun:test'

;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'en', klaus: { media: { url: (p: string) => p } } }

const { unitsFromMessages, foldUnits, segmentsFromBlocks } = await import('./TranscriptView')
const { encodeDelegationEnvelope } = await import('../../../../contracts/thread-delegation')
const { deviceNameForHost, ensureDeviceNamesLoaded, requestDeviceName, setDeviceNamesForTest } = await import('../device-names')
const { renderDelegationLabelHtml, renderDelegationLabelParsedHtml } = await import('./factories')

const ENVELOPE = encodeDelegationEnvelope('Stop and report what you found.', 'sender-thread')
const ENVELOPE_WITH_HOST = encodeDelegationEnvelope('Second arrival.', 'sender-thread', 'remote-host')

function replayMessage(content: any[], overrides: Record<string, unknown> = {}): any {
  return { role: 'assistant', contentBlocks: content, turnId: 'turn-1', ...overrides }
}

describe('a mid-turn delegation is lifted out of its tool result', () => {
  test('segmentsFromBlocks strips the envelope from the tool output and records it', () => {
    const segments = segmentsFromBlocks([
      { type: 'tool_use', id: 'call-1', name: 'read', input: { path: '/tmp/a.ts' }, __result: { content: [{ type: 'text', text: `line one\n${ENVELOPE}` }] } },
    ], undefined)
    const tools = segments.find(s => s.kind === 'tools')
    expect(tools).toBeTruthy()
    expect(tools!.tools![0].output?.text).toBe('line one')
    expect(tools!.delegations).toHaveLength(1)
    expect(tools!.delegations![0].input).toBe('Stop and report what you found.')
    expect(tools!.delegations![0].sourceThreadId).toBe('sender-thread')
  })

  test('unitsFromMessages emits a delegation unit after the tools unit', () => {
    const units = unitsFromMessages([replayMessage([
      { type: 'tool_use', id: 'call-1', name: 'read', input: { path: '/tmp/a.ts' }, __result: { content: [{ type: 'text', text: `out\n${ENVELOPE}` }] } },
    ])])
    const kinds = units.map(u => u.type)
    expect(kinds).toContain('delegation')
    const delegation = units.find(u => u.type === 'delegation')!
    expect(delegation.delegation?.input).toBe('Stop and report what you found.')
    expect(delegation.msg?.text).toContain('sender-thread')
    // The tools unit stays; the envelope no longer rides its output.
    const tools = units.find(u => u.type === 'tools')!
    expect(tools.segment!.tools![0].output?.text).toBe('out')
    expect(tools.segment!.delegations).toHaveLength(0)
  })

  test('two envelopes in one result become two units in arrival order', () => {
    const units = unitsFromMessages([replayMessage([
      { type: 'tool_use', id: 'call-1', name: 'read', input: {}, __result: { content: [{ type: 'text', text: `a\n${ENVELOPE}\nb\n${ENVELOPE_WITH_HOST}\nc` }] } },
    ])])
    const delegations = units.filter(u => u.type === 'delegation')
    expect(delegations).toHaveLength(2)
    expect(delegations[0]!.delegation?.input).toBe('Stop and report what you found.')
    expect(delegations[1]!.delegation?.input).toBe('Second arrival.')
    expect(delegations[1]!.delegation?.sourceHostId).toBe('remote-host')
  })

  test('foldUnits keeps the delegation visible inside the fold at its arrival position', () => {
    const units = unitsFromMessages([
      replayMessage([
        { type: 'text', text: 'working' },
        { type: 'tool_use', id: 'call-1', name: 'read', input: {}, __result: { content: [{ type: 'text', text: `out\n${ENVELOPE}` }] } },
        { type: 'text', text: 'final answer', phase: 'final_answer', isFinalReply: true },
      ], { isFinalReply: true }),
    ])
    const nodes = foldUnits(units, null, { 'turn-1': 'completed' }, {})
    // A steered message renders where it ARRIVED: between
    // the activity that preceded it and the activity that followed, not floated
    // above the whole turn. It is therefore a section of the turn fold — but a
    // persistent one, so collapsing the turn's activity never hides it.
    const standalone = nodes.filter((n): n is Extract<typeof n, { kind: 'unit' }> => n.kind === 'unit' && n.unit.type === 'delegation')
    expect(standalone).toHaveLength(0)
    const fold = nodes.find((n): n is Extract<typeof n, { kind: 'turn-fold' }> => n.kind === 'turn-fold')
    expect(fold).toBeTruthy()
    const insideFold = fold!.items.filter((item: any) => item.kind === 'unit' && item.unit.type === 'delegation')
    expect(insideFold).toHaveLength(1)
    expect((insideFold[0] as any).unit.delegation?.input).toBe('Stop and report what you found.')
    // The bubble sits AFTER the activity section that was running when it
    // arrived, and the fold's message count no longer counts a message as work.
    const delegationIndex = fold!.items.indexOf(insideFold[0] as any)
    expect(delegationIndex).toBeGreaterThan(0)
    expect(fold!.items.slice(0, delegationIndex).some((item: any) =>
      item.kind === 'activity-fold' || (item.kind === 'unit' && item.unit.type === 'tools'))).toBe(true)
  })

  test('plain tool output without an envelope yields no delegation units', () => {
    const units = unitsFromMessages([replayMessage([
      { type: 'tool_use', id: 'call-1', name: 'read', input: {}, __result: { content: [{ type: 'text', text: 'plain output' }] } },
    ])])
    expect(units.filter(u => u.type === 'delegation')).toHaveLength(0)
  })

  test('a turn OPENED by a delivered envelope keeps its bubble outside the fold', () => {
    // The shape the engine produces when a delivery STARTS the recipient's turn:
    // no user row carries the turn id, so the envelope-only user message is the
    // group's FIRST unit. The lift must not depend on the mid-turn payload — an
    // idle-delivered envelope unit carries none, and a payload-gated filter drops
    // exactly this case into the fold (the 0.4.14 regression).
    const units = unitsFromMessages([
      { role: 'user', uuid: 'msg-envelope', text: ENVELOPE },
      replayMessage([
        { type: 'tool_use', id: 'call-1', name: 'read', input: {}, __result: { content: [{ type: 'text', text: 'out' }] } },
        { type: 'text', text: 'done, acknowledged', phase: 'final_answer', isFinalReply: true },
      ], { isFinalReply: true }),
    ])
    const nodes = foldUnits(units, null, { 'turn-1': 'completed' }, {})
    const standalone = nodes.filter((n): n is Extract<typeof n, { kind: 'unit' }> => n.kind === 'unit' && n.unit.type === 'delegation')
    expect(standalone).toHaveLength(1)
    expect(standalone[0]!.unit.msg?.text).toBe(ENVELOPE)
    const fold = nodes.find(n => n.kind === 'turn-fold')
    expect(fold).toBeTruthy()
    const insideFold = fold!.items.filter((item: any) => item.kind === 'unit' && item.unit.type === 'delegation')
    expect(insideFold).toHaveLength(0)
  })
})

describe('the device dimension of a cross-computer delegation', () => {
  const REMOTE = encodeDelegationEnvelope('Hello from the other machine.', 'thread-a', 'device-mini')

  test('a local delivery keeps the unqualified provenance line', () => {
    const html = renderDelegationLabelHtml(encodeDelegationEnvelope('hi', 'thread-a'))
    expect(html).toContain('Sent by Klaus from another chat')
    expect(html).not.toContain('computer')
  })

  test('this computer\'s device id still offers a local source link', () => {
    setDeviceNamesForTest([{ id: 'device-pro', name: 'This computer', isCurrent: true }], 'device-pro')
    const html = renderDelegationLabelParsedHtml('device-pro', 'thread-a')
    expect(html).toContain('Sent by Klaus from another chat')
    expect(html).toContain('data-delegation-source-id="thread-a"')
  })

  test('a cross-computer delivery names the sending computer once resolved', () => {
    setDeviceNamesForTest([{ id: 'device-mini', name: 'Mac mini' }], 'device-pro')
    const html = renderDelegationLabelHtml(REMOTE)
    expect(html).toContain('Sent by a chat on Mac mini')
    expect(html).not.toContain('another chat')
    expect(html).not.toContain('data-delegation-source-id')
  })

  test('an unresolvable remote host says another computer, never a raw id', () => {
    setDeviceNamesForTest([], 'device-pro')
    const html = renderDelegationLabelParsedHtml('device-unknown')
    expect(html).toContain('Sent by a chat on another computer')
    expect(html).not.toContain('device-unknown')
    expect(html).not.toContain('<button')
  })

  test('the mid-turn card carries the same device-qualified line', () => {
    setDeviceNamesForTest([{ id: 'device-mini', name: 'Mac mini' }], 'device-pro')
    const html = renderDelegationLabelParsedHtml('device-mini')
    expect(html).toContain('Sent by a chat on Mac mini')
  })

  test('an unknown device found after the first list refreshes the label once', async () => {
    const original = (window as any).klaus
    let calls = 0
    ;(window as any).klaus = { ...original, settings: { ...original?.settings, mobileBridge: { devices: async () => {
      calls++
      return { ok: true, devices: calls === 1 ? [] : [{ id: 'late-device', name: 'Mac mini' }] }
    } } } }
    try {
      await ensureDeviceNamesLoaded()
      expect(deviceNameForHost('late-device')).toBe('')
      requestDeviceName('late-device')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls).toBe(2)
      expect(renderDelegationLabelParsedHtml('late-device')).toContain('Sent by a chat on Mac mini')
      requestDeviceName('late-device')
      expect(calls).toBe(2)
    } finally {
      ;(window as any).klaus = original
    }
  })

  test('an unresolved device is retried on a later render, not on every render', async () => {
    const original = (window as any).klaus
    const originalNow = Date.now
    let now = 1_000_000
    let calls = 0
    Date.now = () => now
    ;(window as any).klaus = { ...original, settings: { ...original?.settings, mobileBridge: { devices: async () => {
      calls++
      return { ok: true, devices: calls === 1 ? [] : [{ id: 'device-later', name: 'Mac mini' }] }
    } } } }
    try {
      expect(deviceNameForHost('device-later')).toBe('')
      await new Promise(resolve => setTimeout(resolve, 0))
      requestDeviceName('device-later')
      expect(calls).toBe(1)
      now += 60_000
      requestDeviceName('device-later')
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(calls).toBe(2)
      expect(deviceNameForHost('device-later')).toBe('Mac mini')
    } finally {
      Date.now = originalNow
      ;(window as any).klaus = original
    }
  })
})
