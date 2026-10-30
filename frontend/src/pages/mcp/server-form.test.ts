import { describe, expect, test } from 'bun:test'
import { buildMcpServerConfig, formatMcpCommandLine, parseMcpCommandLine } from './server-form'

describe('MCP connector form config', () => {
  test('parses quoted and escaped command arguments without a shell', () => {
    expect(parseMcpCommandLine(`npx -y "package with spaces" 'literal value' escaped\\ value`)).toEqual([
      'npx', '-y', 'package with spaces', 'literal value', 'escaped value',
    ])
    expect(parseMcpCommandLine(String.raw`"C:\Program Files\server.exe" --config C:\data\file.json`)).toEqual([
      String.raw`C:\Program Files\server.exe`, '--config', String.raw`C:\data\file.json`,
    ])
    expect(parseMcpCommandLine(`npx "unfinished`)).toBeNull()
  })

  test('formats configured argv without changing spaces quotes or backslashes', () => {
    const argv = ['/Applications/My Server/bin/run', '', `single'quote`, 'double"quote', String.raw`C:\Program Files\server.exe`]
    expect(parseMcpCommandLine(formatMcpCommandLine(argv[0]!, argv.slice(1)))).toEqual(argv)
  })

  test('preserves fields the form does not expose while replacing owned fields', () => {
    const oauth = { clientId: 'public-id' }
    const result = buildMcpServerConfig({
      type: 'http',
      url: 'https://old.example.test',
      headers: { Authorization: 'Bearer saved' },
      oauth,
      disabledTools: ['delete'],
      extensionField: { future: true },
      env: { OLD: '1' },
      timeout: 10,
      alwaysLoad: true,
    }, {
      type: 'http',
      commandLine: '',
      url: 'https://new.example.test',
      env: [{ key: 'NEW', value: '2' }],
      timeout: '30',
      alwaysLoad: false,
    })

    expect(result).toEqual({
      ok: true,
      config: {
        type: 'http',
        url: 'https://new.example.test',
        headers: { Authorization: 'Bearer saved' },
        oauth,
        disabledTools: ['delete'],
        extensionField: { future: true },
        env: { NEW: '2' },
        timeout: 30,
      },
    })
  })

  test('removes stale transport and cleared optional fields', () => {
    const result = buildMcpServerConfig({
      type: 'http', url: 'https://old.example.test', env: { OLD: '1' }, timeout: 60, alwaysLoad: true,
    }, {
      type: 'stdio',
      commandLine: `"/Applications/My Server/bin/run" --mode safe`,
      url: '',
      env: [],
      timeout: '',
      alwaysLoad: false,
    })
    expect(result).toEqual({
      ok: true,
      config: { type: 'stdio', command: '/Applications/My Server/bin/run', args: ['--mode', 'safe'] },
    })
  })

  test('rejects missing transport targets', () => {
    expect(buildMcpServerConfig({}, { type: 'stdio', commandLine: '', url: '', env: [], timeout: '', alwaysLoad: false }))
      .toEqual({ ok: false, field: 'command' })
    expect(buildMcpServerConfig({}, { type: 'http', commandLine: '', url: ' ', env: [], timeout: '', alwaysLoad: false }))
      .toEqual({ ok: false, field: 'url' })
  })
})
