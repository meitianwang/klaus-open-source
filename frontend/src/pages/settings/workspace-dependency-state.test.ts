import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKSPACE_DEPENDENCIES_CHANNELS, WORKSPACE_DEPENDENCIES_ENABLED_KEY } from '../../../../contracts/workspace-dependency-settings'
import { I18N } from '../../i18n/messages'
import { dependenciesDiagnoseFeedback } from './workspace-dependency-state'

const COPY_KEYS = [
  'runtime_dependencies_section', 'runtime_dependencies_toggle', 'runtime_dependencies_toggle_desc',
  'runtime_dependencies_diagnose', 'runtime_dependencies_diagnose_desc', 'runtime_dependencies_diagnose_btn',
  'runtime_dependencies_diagnosing', 'runtime_dependencies_reinstall_row', 'runtime_dependencies_reinstall_desc',
  'runtime_dependencies_reinstall_btn', 'runtime_dependencies_installing', 'runtime_dependencies_diagnose_ready',
  'runtime_dependencies_diagnose_problem', 'runtime_dependencies_diagnose_failed',
] as const

test('completed diagnostics distinguish a healthy bundle from a bundle needing repair', () => {
  expect(dependenciesDiagnoseFeedback('ready')).toEqual({ key: 'runtime_dependencies_diagnose_ready', tone: 'success' })
  for (const state of ['missing', 'disabled', 'installing', 'failed', 'unsupported'] as const) {
    expect(dependenciesDiagnoseFeedback(state)).toEqual({ key: 'runtime_dependencies_diagnose_problem', tone: 'warning' })
  }
})

test('workspace dependency copy ships in both languages', () => {
  for (const key of COPY_KEYS) {
    expect(I18N.en[key].length).toBeGreaterThan(0)
    expect(I18N.zh[key].length).toBeGreaterThan(0)
  }
})

test('the contract vector pins the settings channels and the preference key', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../../../contracts/vectors/workspace-dependencies.json'), 'utf8')) as {
    settingsChannels: string[]; enabledKey: string; enabledDefault: string; unavailableStates: string[];
    diagnoseRecordsLog: boolean; reinstallRemoves: string[];
  }
  expect(vector.settingsChannels).toEqual([...WORKSPACE_DEPENDENCIES_CHANNELS])
  expect(vector.enabledKey).toBe(WORKSPACE_DEPENDENCIES_ENABLED_KEY)
  expect(vector.enabledDefault).toBe('on')
  expect(vector.unavailableStates).toContain('disabled')
  expect(vector.diagnoseRecordsLog).toBe(true)
  expect(vector.reinstallRemoves).toEqual(['versions', 'cache'])
})
