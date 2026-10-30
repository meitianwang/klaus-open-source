import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ActivityToolData } from './activity-tool-model'
import { agentActionKind, agentActionLabel, agentActionPresentation, isAgentActionToolName, isAgentMessageNoticeToolName, isHiddenAgentMessageTool } from './activity-agent-action-model'
import { AgentActionActivityTool } from './activity-agent-action'
import communicationVectors from '../../../../contracts/vectors/subagent-communication-vectors.json'

const tool = (toolName: string, args: unknown = {}, overrides: Partial<ActivityToolData> = {}): ActivityToolData => ({ toolCallId: 'control-1', toolName, args, state: 'done', ...overrides })
const render = (value: ActivityToolData, open = true, locale = 'en') => renderToStaticMarkup(<AgentActionActivityTool tool={value} open={open} onToggle={() => {}} locale={locale} />)

describe('agent control semantics', () => {
  test('successful messaging reports acceptance independently of queue processing and recipient work', () => {
    for (const [toolName, output] of [
      ['send_message', '{"ok":true,"agentId":"child","resumed":false,"message":"Message queued for subagent: child"}'],
      ['followup_task', '{"ok":true,"agentId":"child","resumed":false}'],
      ['followup_task', '{"ok":true,"agentId":"child","resumed":true}'],
      ['SendMessage', '{"ok":true,"recipients":["child"],"delivery":"queued"}'],
    ]) {
      const value = tool(toolName, { to: 'child', message: 'Check the result' }, { output })
      const model = agentActionPresentation(value)!
      expect(model.state).toBe('done')
      expect(model.agents[0].status).toBeUndefined()
      expect(model.output).toBe(output)
      expect(agentActionLabel(model.action, model.state, 'en')).toBe('Messaged')
      expect(agentActionLabel(model.action, model.state, 'zh')).toBe('已发送消息')
      for (const [locale, label] of [['en', 'Sent message to Agent'], ['zh', '已向 智能体 发送消息']]) {
        const html = render(value, true, locale)
        expect(html).toContain(label)
        expect(html).toContain('data-agent-message-notice')
        expect(html).not.toContain('Check the result')
        expect(html).not.toContain('<button')
        expect(html).not.toContain('aria-expanded')
      }
    }
    const failed = agentActionPresentation(tool('send_message', { to: 'child' }, { output: '{"ok":false,"resumed":false,"delivery":"queued"}' }))!
    expect(failed.state).toBe('error')
    expect(agentActionLabel(failed.action, failed.state, 'zh')).toBe('无法发送消息')
  })
  test('recognizes control tools and Klaus built-ins without treating result retrieval or spawn as controls', () => {
    expect(['send_input', 'send_message', 'followup_task', 'SendMessage', 'functions.send_message'].map(agentActionKind)).toEqual(Array(5).fill('message'))
    expect(['interrupt_agent', 'task_stop'].map(agentActionKind)).toEqual(['interrupt', 'interrupt'])
    expect(['list_agents', 'ListPeers', 'resume_agent', 'close_agent'].map(agentActionKind)).toEqual(['list', 'list', 'resume', 'close'])
    for (const name of ['task_output', 'spawn_agent', 'task', 'WaitForTeammates', 'shell', 'mcp__collaboration__send_message', 'mcp__slack__send_message']) expect(isAgentActionToolName(name)).toBe(false)
    expect(agentActionPresentation(tool('task_output'))).toBeNull()
  })

  test('separates successful messaging from the recipient lifecycle', () => {
    const model = agentActionPresentation(tool('send_input', { id: 'agent-1', message: 'Continue the review.' }, { output: '{"submission_id":"submission-1"}' }))!
    expect(model).toMatchObject({ action: 'message', state: 'done', count: 1, prompt: 'Continue the review.' })
    expect(model.agents).toEqual([{ id: 'agent-1', name: 'agent-1' }])
    expect(model.agents[0].status).toBeUndefined()
    const listed = agentActionPresentation(tool('list_agents', {}, { output: '{"agents":[{"id":"agent-1","name":"Review","status":"failed"}]}' }))!
    expect(listed.state).toBe('done')
    expect(listed.agents[0].status).toBe('failed')
  })

  test('uses actual SendMessage recipients, including an empty broadcast', () => {
    const message = tool('SendMessage', { to: '*', message: 'Check the API.' }, { output: '{"ok":true,"recipients":["b","a","b"],"message":"Sent to 2 teammate(s)."}' })
    expect(agentActionPresentation(message)?.agents.map(agent => agent.id)).toEqual(['a', 'b'])
    const empty = agentActionPresentation({ ...message, output: '{"ok":true,"recipients":[],"message":"No recipients."}' })!
    expect(empty.count).toBe(0)
    expect(empty.agents).toEqual([])
    expect(empty.output).toContain('No recipients.')
  })

  test('reads real ListPeers activity without marking idle agents completed', () => {
    const model = agentActionPresentation(tool('ListPeers', {}, { output: '{"ok":true,"peers":[{"peer":"reader","active":true},{"peer":"reviewer","active":false}]}' }))!
    expect(model.agents.map(agent => [agent.name, agent.status])).toEqual([['reader', 'running'], ['reviewer', 'idle']])
    expect(agentActionPresentation(tool('ListPeers', {}, { output: '{"peers":[]}' }))?.count).toBe(0)
  })

  test('preserves recipient names, roles, state messages and prompt from structured wrappers', () => {
    const output = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ receiverThreads: [{ threadId: 'a', thread: { agentNickname: 'Review', agentRole: 'explorer', model: 'model-x' } }], agentsStates: { a: { status: 'running', message: 'Inspecting files' }, b: { status: 'completed', message: 'Result' } } }) }] })
    const model = agentActionPresentation(tool('list_agents', {}, { output }))!
    expect(model.agents[0]).toMatchObject({ id: 'a', name: 'Review', role: 'explorer', model: 'model-x', status: 'running', statusMessage: 'Inspecting files' })
    expect(model.agents[1]).toMatchObject({ id: 'b', status: 'completed', statusMessage: 'Result' })
    expect(model.count).toBe(2)
  })

  test('maps task_stop aliases to interruption while retaining its real result', () => {
    const model = agentActionPresentation(tool('task_stop', { shell_id: 'background-1' }, { output: '{"task_id":"background-1","task_type":"agent","message":"Stopped background task background-1."}' }))!
    expect(model.action).toBe('interrupt')
    expect(model.agents).toEqual([{ id: 'background-1', name: 'background-1' }])
    expect(model.output).toContain('Stopped background task')
  })

  test('retains error and interrupted operations independently of returned target status', () => {
    const failed = agentActionPresentation(tool('resume_agent', { id: 'a' }, { output: '{"is_error":true,"output":{"status":{"running":null}}}' }))!
    expect(failed.state).toBe('error')
    expect(failed.agents[0].status).toBe('running')
    expect(agentActionLabel(failed.action, failed.state, 'en')).toBe('Failed to resume')
    for (const action of ['message', 'interrupt', 'list', 'resume', 'close'] as const) expect(agentActionLabel(action, 'interrupted', 'en')).toBe('Interrupted')
    expect(agentActionLabel('message', 'error', 'en', true)).toBe('Failed messaging')
    expect(agentActionLabel('message', 'error', 'en', true, true)).toBe('Failed to message')
  })

  test('does not discard structured input text or unknown result fields', () => {
    const args = { target: 'a', input: [{ type: 'text', text: 'First line' }, { type: 'text', text: '<instruction>Second line</instruction>' }], interrupt: false }
    const model = agentActionPresentation(tool('send_input', args, { output: 'Unhandled wire result\n<result>' }))!
    expect(model.prompt).toBe('First line\n<instruction>Second line</instruction>')
    expect(model.input).toContain('"interrupt": false')
    expect(model.output).toBe('Unhandled wire result\n<result>')
  })
})

describe('agent control disclosure', () => {
  test('parent mail names its direction before and after the resolved delivery', () => {
    const vector = communicationVectors.parentAction
    for (const row of vector.cases) for (const [locale, labels] of Object.entries(row.destination === 'parent' ? vector.nestedLabels : vector.labels)) {
      for (const state of ['running', 'done', 'error', 'interrupted', 'awaiting-approval'] as const) {
        const value = tool('send_message', { ...row.arguments, message: vector.message }, {
          state, sessionId: row.sessionId, parentAgentId: row.parentAgentId, output: state === 'running' ? undefined : JSON.stringify(row.output),
        })
        const html = render(value, false, locale)
        if (state === 'done') expect(html).toContain(labels.done)
        else expect(html).toBe('')
        expect(render(value, true, locale)).toBe(html)
        expect(html).not.toContain(vector.message)
        expect(html).not.toContain('<button')
        expect(html).not.toContain('<details')
        expect(html).not.toContain('aria-expanded')
        expect(html).not.toContain('data-agent-message-content')
        expect(html).not.toContain('data-klaus-tip')
      }
    }
  })

  test('named parent and peer recipients remain text rather than navigation controls', () => {
    for (const parentAgentId of ['direct-parent', 'another-parent']) {
      const value = tool('send_message', { target: 'direct-parent', message: 'PRIVATE BODY' }, {
        sessionId: 'root', parentAgentId,
        output: '{"ok":true,"agentId":"direct-parent","agentName":"Parent review"}',
      })
      const html = render(value)
      expect(html).toContain('Sent message to Parent review')
      expect(html).not.toContain('PRIVATE BODY')
      expect(html).not.toContain('<button')
      expect(html).not.toContain('aria-expanded')
    }
    const missing = tool('send_message', { target: 'child' })
    expect(render(missing)).toBe('')
    expect(isHiddenAgentMessageTool(missing)).toBe(true)
    expect(render({ ...missing, output: '' })).toContain('Sent message to Agent')
    expect(render({ ...missing, output: '{"ok":true,"recipients":[]}' })).toBe('')
  })
  test('parent alias resolves once and failed delivery never claims success', () => {
    const value = tool('SendMessage', { target: 'parent', message: 'Report' }, { output: '{"ok":true,"agentId":"root-agent"}' })
    expect(agentActionPresentation(value)).toMatchObject({ count: 1, toParent: true, agents: [{ id: 'root-agent', isParent: true }] })
    for (const locale of ['en', 'zh']) {
      expect(render({ ...value, output: '{"ok":false}' }, false, locale)).toBe('')
      expect(isHiddenAgentMessageTool({ ...value, output: '{"ok":false}' })).toBe(true)
    }
    for (const state of ['interrupted', 'awaiting-approval'] as const) {
      const html = render({ ...value, state }, false, 'zh')
      expect(html).toBe('')
      expect(isHiddenAgentMessageTool({ ...value, state })).toBe(true)
    }
    expect(agentActionPresentation(tool('send_message', { to: 'sibling' }, { parentAgentId: 'direct-parent' }))?.toParent).toBe(false)
  })

  test('uses an explicit task description and keeps unresolved IDs out of the display name', () => {
    const output = JSON.stringify({ agents: [{ id: 'child-uuid', name: 'explorer', description: '检查权限' }] })
    const html = render(tool('list_agents', {}, { output }), true, 'zh-CN')
    expect(html).toMatch(/<span(?: [^>]*)?>检查权限<\/span>/)
    const pending = render(tool('send_message', { target: 'child-uuid', message: 'Continue.' }, { output: '{"ok":true}' }), true, 'zh-CN')
    expect(pending).toContain('已向 智能体 发送消息')
    expect(pending).toContain('data-recipient-id="child-uuid"')
  })

  test('keeps the controlled disclosure closed and keyboard accessible', () => {
    const html = render(tool('send_input', { target: 'a', message: 'Private prompt' }), false)
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-controls=')
    expect(html).toContain('aria-label="Messaged an agent"')
    expect(html).toContain('aria-hidden="true" inert=""')
    expect(html).not.toContain('Private prompt')
  })

  test('message disclosure shows the complete safe body and body-only copy without protocol panels', () => {
    const html = render(tool('send_input', { target: 'review', message: '<script>Continue</script>' }, { output: '{"status":"completed","submission_id":"1"}' }))
    expect(html).toContain('data-recipient-id="review"')
    expect(html).toContain('&lt;script&gt;Continue&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('(completed)')
    expect(html).toContain('aria-label="Copy message"')
    expect(html).not.toContain('Copy input')
    expect(html).not.toContain('Copy tool result')
    expect(html).not.toContain('submission_id')
    expect(html).not.toContain('<details')
  })

  test('shows actual list state suffixes and suppresses resume or close suffixes', () => {
    const output = '{"agentsStates":{"a":{"status":"running","message":"Reading files"}}}'
    const listed = render(tool('list_agents', {}, { output }))
    expect(listed).toContain('(running: Reading files)')
    for (const name of ['resume_agent', 'close_agent']) expect(render(tool(name, { id: 'a' }, { output }))).not.toContain('(running:')
  })

  test('retains legacy input disclosure without creating native delivery notices', () => {
    const native = tool('followup_task', { target: 'a', message: 'Continue' }, { state: 'interrupted', output: 'Stopped before delivery.' })
    expect(render(native, true, 'zh-CN')).toBe('')
    expect(isHiddenAgentMessageTool(native)).toBe(true)
    expect(isAgentMessageNoticeToolName('send_input')).toBe(false)
    expect(isHiddenAgentMessageTool({ ...native, toolName: 'send_input' })).toBe(false)
    const html = render({ ...native, toolName: 'send_input' }, true, 'zh-CN')
    expect(html).toContain('aria-label="已中断 1 个智能体"')
    expect(html).toContain('Continue')
    expect(html).not.toContain('Stopped before delivery.')
    expect(html).not.toContain('已完成')
    expect(render(tool('interrupt_agent', { target: 'a' }, { state: 'awaiting-approval' }))).toContain('Awaiting approval an agent')
  })
})
