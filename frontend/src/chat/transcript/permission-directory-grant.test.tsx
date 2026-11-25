import { afterAll, beforeAll, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18N } from '../../i18n/messages'

let previousWindow: unknown
let previousDocument: unknown
let PermissionCard: typeof import('./approval-cards')['PermissionCard']

beforeAll(async () => {
  previousWindow = (globalThis as any).window
  previousDocument = (globalThis as any).document
  ;(globalThis as any).window = {
    currentLang: 'en',
    tt: (key: string) => {
      const lang: 'en' | 'zh' = (globalThis as any).window?.currentLang === 'zh' ? 'zh' : 'en'
      return (I18N[lang] as Record<string, string>)[key] ?? key
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    klaus: { permission: { respond: async () => true } },
  }
  ;(globalThis as any).document = {
    createElement: () => {
      let raw = ''
      return {
        set innerHTML(value: string) {
          raw = value
        },
        get value() {
          return raw
        },
      }
    },
  }
  ;({ PermissionCard } = await import('./approval-cards'))
})

afterAll(() => {
  ;(globalThis as any).window = previousWindow
  ;(globalThis as any).document = previousDocument
})

test('PermissionCard renders directory scope and localized button copy for addDirectories suggestions', () => {
  const singleDirReq = {
    requestId: 'req-dir-1',
    toolName: 'write',
    message: 'This write exceeds the current filesystem policy. Allow this operation?',
    toolInput: { path: '/outside/repo/src/index.ts', content: 'export {}' },
    suggestions: [
      {
        type: 'addDirectories',
        destination: 'session',
        directories: ['/outside/repo/src'],
        label: 'Allow directory (/outside/repo/src)',
      },
    ],
  }

  ;(window as any).currentLang = 'en'
  const enHtml = renderToStaticMarkup(
    <PermissionCard req={singleDirReq} startedAt={1_000} resolved={null} sessionId="s-1" />,
  )
  expect(enHtml).toContain('Directory scope: /outside/repo/src')
  expect(enHtml).toContain('Allow directory this session')

  ;(window as any).currentLang = 'zh'
  const zhHtml = renderToStaticMarkup(
    <PermissionCard req={singleDirReq} startedAt={1_000} resolved={null} sessionId="s-1" />,
  )
  expect(zhHtml).toContain('目录授权范围：/outside/repo/src')
  expect(zhHtml).toContain('本会话允许该目录')

  const zhResolvedHtml = renderToStaticMarkup(
    <PermissionCard
      req={singleDirReq}
      startedAt={1_000}
      resolved={{ decision: 'allow', allowSession: true, savedRules: true }}
      sessionId="s-1"
    />,
  )
  expect(zhResolvedHtml).toContain('已允许写入该目录（本会话内不再询问）')
  expect(zhResolvedHtml).not.toContain('目录授权范围：')
})

test('PermissionCard pluralizes multi-directory grants and keeps standard label for rule suggestions', () => {
  ;(window as any).currentLang = 'zh'
  const multiDirHtml = renderToStaticMarkup(
    <PermissionCard
      req={{
        requestId: 'req-dir-multi',
        toolName: 'apply_patch',
        message: 'This write exceeds the current filesystem policy. Allow this operation?',
        toolInput: { patch: '*** Begin Patch\n*** End Patch' },
        suggestions: [
          {
            type: 'addDirectories',
            destination: 'session',
            directories: ['/outside/a', '/outside/b'],
          },
        ],
      }}
      startedAt={1_000}
      resolved={null}
      sessionId="s-1"
    />,
  )
  expect(multiDirHtml).toContain('目录授权范围：/outside/a, /outside/b')
  expect(multiDirHtml).toContain('本会话允许这些目录')

  const ruleHtml = renderToStaticMarkup(
    <PermissionCard
      req={{
        requestId: 'req-rule',
        toolName: 'bash',
        message: 'Allow bash: git status?',
        toolInput: { command: 'git status' },
        suggestions: [
          {
            type: 'addRules',
            destination: 'session',
            rules: [{ toolName: 'bash', ruleContent: 'git status' }],
          },
        ],
      }}
      startedAt={1_000}
      resolved={null}
      sessionId="s-1"
    />,
  )
  expect(ruleHtml).toContain('本会话内允许')
  expect(ruleHtml).not.toContain('目录授权范围：')
})
