import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { allPages, canChangeMember, canCreateProjectInvitation, canManageProject, updateProjectInvitationAccess, COVER_COLORS, COVER_PALETTE, coverName, projectMemberRemovalAction, projectInputError, readRoute, routeHash, request, type CollaborationMember, type CollaborationProject } from './data'
import { applyProjectDraftPatch, projectDraftPatchToFields, boundedDraftHistory, emptyProjectPreferences, filterAndSortProjects, normalizeProjectRepositoryUrl, parseProjectPreferences, projectPreferencesKey, suggestProjectIdentifier, type ProjectFormValue } from './project-model'
import './i18n'

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
beforeAll(() => { Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { currentLang: 'en', klaus: {} } }) })
afterAll(() => { if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window') })
const project: CollaborationProject = { id: 'p', name: 'Platform', identifier: 'PLT', description: '', coverIcon: 'folder', coverColor: '#8877d9', repositoryUrl: null, createdBy: 'owner', createdAt: '2026-01-01', updatedAt: '2026-01-01', archivedAt: null, version: 1, role: 'owner', memberCount: 2 }
const member = (id: string, role: CollaborationMember['role']): CollaborationMember => ({ id, projectId: 'p', kind: 'human', userId: id, agentId: null, role, joinedAt: '', user: { id, displayName: id, avatarUrl: null }, agent: null })
const form: ProjectFormValue = { name: 'Original', identifier: 'ORG', description: 'Original description', repositoryUrl: '', coverIcon: 'gyro', coverColor: '#8877d9' }

describe('project fields', () => {
  test('bounds names to 80, descriptions to 150, and identifiers to three uppercase letters', () => {
    expect(projectInputError({ name: 'A', identifier: 'ABC', description: 'x'.repeat(150) })).toBeNull()
    expect(projectInputError({ name: ' ', identifier: 'ABC' })).toBe('tc_invalid_name')
    expect(projectInputError({ name: 'x'.repeat(81), identifier: 'ABC' })).toBe('tc_invalid_name')
    expect(projectInputError({ name: 'A', identifier: 'ABC', description: 'x'.repeat(151) })).toBe('tc_invalid_description')
    for (const identifier of ['AB', 'ABCD', 'AbC', '123', '中文文']) expect(projectInputError({ name: 'A', identifier })).toBe('tc_invalid_identifier')
  })
  test('accepts HTTPS, SSH and scp-style repositories but rejects passwords, tokens and executable URLs', () => {
    for (const url of ['https://example.test/team/repo', 'ssh://git@example.test/repo.git', 'ssh://git@example.test:2222/team/repo', 'git@example.test:team/repo.git']) {
      expect(normalizeProjectRepositoryUrl(url)).toBe(url)
      expect(projectInputError({ name: 'A', identifier: 'ABC', repositoryUrl: url })).toBeNull()
    }
    for (const url of ['http://example.test/repo', 'javascript:alert(1)', 'file:///etc/passwd', 'https://token@example.test/repo', 'https://user:secret@example.test/repo', 'ssh://git:secret@example.test/repo', 'https://example.test/repo?token=secret', 'not a url', 'https://example.test/repo\nbad']) expect(normalizeProjectRepositoryUrl(url)).toBeNull()
  })
  test('supports SSH aliases, IPv6, explicit ports, and remote absolute paths', () => {
    for (const url of ['https://example.test', 'HTTPS://example.test/repo.git', 'ssh://example.test/team/repo.git', 'ssh://git@[2001:db8::1]:2222/team/repo.git', 'git@work-alias:repo.git', 'git@[2001:db8::1]:team/repo.git', 'git@example.test:/srv/repo.git']) {
      expect(normalizeProjectRepositoryUrl(url)).toBe(url)
      expect(projectInputError({ name: 'A', identifier: 'ABC', repositoryUrl: url })).toBeNull()
    }
  })
  test('rejects original whitespace and backslashes instead of normalizing them into accepted URLs', () => {
    for (const url of [' https://example.test/repo.git', 'https://example.test/repo.git ', 'git@example.test:repo.git\n', '\tssh://git@example.test/repo.git', 'https://example.test/repo\u00a0', 'https://example.test/\\\\repo.git', 'ssh://git@example.test/team\\\\repo.git', 'git@example.test:team\\\\repo.git', 'https:example.test/repo.git', '/Users/private/repo', './repo.git', 'C:\\\\private\\\\repo', 'git://example.test/repo.git']) {
      expect(normalizeProjectRepositoryUrl(url)).toBeNull()
      expect(projectInputError({ name: 'A', identifier: 'ABC', repositoryUrl: url })).toBe('tc_invalid_repository')
    }
  })
  test('rejects credentials and query or fragment data in both SSH reference forms', () => {
    for (const url of ['ssh://git%3Asecret@example.test/repo.git', 'git:secret@example.test:repo.git', 'ssh://git@example.test', 'git@example.test:', 'ssh://git@example.test/repo.git?password=secret', 'ssh://git@example.test/repo.git#branch', 'git@example.test:repo.git?token=secret', 'git@example.test:repo.git#branch']) {
      expect(normalizeProjectRepositoryUrl(url)).toBeNull()
      expect(projectDraftPatchToFields({ repositoryUrl: url }, {}, ['gyro'])).toBeNull()
    }
  })
  test('rejects raw query and fragment delimiters even when their values are empty', () => {
    for (const prefix of ['https://example.test/repo.git', 'ssh://git@example.test/repo.git', 'git@example.test:repo.git']) {
      for (const suffix of ['?', '#', '?#', '?token=secret', '#fragment']) {
        const url = `${prefix}${suffix}`
        expect(normalizeProjectRepositoryUrl(url)).toBeNull()
        expect(projectInputError({ name: 'A', identifier: 'ABC', repositoryUrl: url })).toBe('tc_invalid_repository')
        expect(projectDraftPatchToFields({ repositoryUrl: url }, {}, ['gyro'])).toBeNull()
      }
    }
    expect(normalizeProjectRepositoryUrl('https://example.test/repo%3Fname%23part.git')).toBe('https://example.test/repo%3Fname%23part.git')
  })
  test('suggests word initials with stable padding, including common Chinese and accented names', () => {
    expect(suggestProjectIdentifier('My Project', 'XYZ')).toBe('MPX')
    expect(suggestProjectIdentifier('1 a-b-c', 'XYZ')).toBe('ABC')
    expect(suggestProjectIdentifier('École Product', 'XYZ')).toBe('EPX')
    expect(suggestProjectIdentifier('团队协作', 'XYZ')).toBe('TDX')
    expect(suggestProjectIdentifier('', 'XYZ')).toBe('XYZ')
  })
  test('six named cover choices retain server-compatible appearance values', () => {
    expect(COVER_COLORS).toEqual(['Aurora', 'Reef', 'Ember', 'Violet', 'Cobalt', 'Moss'])
    for (const name of COVER_COLORS) {
      expect(COVER_PALETTE[name]).toMatch(/^#[0-9a-f]{6}$/)
      expect(coverName(COVER_PALETTE[name])).toBe(name)
      expect(coverName(name)).toBe(name)
    }
  })
})

describe('project draft snapshot protection', () => {
  test('adapts host cover IDs and nullable repository fields without accepting unknown presets', () => {
    expect(projectDraftPatchToFields({ name: 'Draft', repositoryUrl: null, coverId: 'reef', coverIconId: 'rocket' }, { reef: '#54b8af' }, ['gyro', 'rocket'])).toEqual({ name: 'Draft', repositoryUrl: '', coverColor: '#54b8af', coverIcon: 'rocket' })
    expect(projectDraftPatchToFields({ coverId: '__proto__' }, { reef: '#54b8af' }, ['gyro'])).toBeNull()
    expect(projectDraftPatchToFields({ coverIconId: 'unknown' }, {}, ['gyro'])).toBeNull()
    expect(projectDraftPatchToFields({ description: 'x'.repeat(151) }, {}, ['gyro'])).toBeNull()
    expect(projectDraftPatchToFields({ repositoryUrl: 'https://token@example.test/repo' }, {}, ['gyro'])).toBeNull()
  })
  test('applies only returned form fields that still match the request snapshot', () => {
    const current = { ...form, name: 'Typed while waiting', coverIcon: 'rocket' }
    expect(applyProjectDraftPatch(current, form, { name: 'Agent name', description: 'Agent description', coverIcon: 'book', repositoryUrl: 'https://example.test/repo' })).toEqual({ ...current, description: 'Agent description', repositoryUrl: 'https://example.test/repo' })
  })
  test('does not overwrite the manual identifier or apply unrecognized fields', () => {
    const patch = { name: 'Draft', identifier: 'NEW', issues: [{ title: 'Do not create' }] }
    expect(applyProjectDraftPatch(form, form, patch)).toEqual({ ...form, name: 'Draft' })
    expect(applyProjectDraftPatch(form, form, { description: '' }).description).toBe('')
  })
  test('does not mutate the request snapshot or current form', () => {
    const next = applyProjectDraftPatch(form, form, { name: 'Changed' })
    expect(next.name).toBe('Changed')
    expect(form.name).toBe('Original')
  })
  test('keeps up to twelve history messages and removes whole exchanges over sixteen thousand characters', () => {
    const messages = Array.from({ length: 16 }, (_, index) => ({ id: String(index), role: index % 2 ? 'assistant' as const : 'user' as const, text: String(index) }))
    expect(boundedDraftHistory(messages).map(message => message.text)).toEqual(messages.slice(4).map(message => message.text))
    const large = messages.map(message => ({ ...message, text: 'x'.repeat(3000) }))
    expect(boundedDraftHistory(large).length).toBe(4)
    expect(messages.length).toBe(16)
  })
})

describe('account-scoped project preferences', () => {
  const projects = [
    { ...project, id: '2', name: 'Project 2', description: 'Native clients', createdAt: '2026-01-02', updatedAt: '2026-01-03' },
    { ...project, id: '10', name: 'Project 10', description: 'Cloud API', createdAt: '2026-01-03', updatedAt: '2026-01-01' },
    { ...project, id: '1', name: 'Project 1', description: 'Native API', createdAt: '2026-01-01', updatedAt: '2026-01-02' },
  ]
  test('uses distinct encoded keys for distinct accounts', () => {
    expect(projectPreferencesKey('account/one')).not.toBe(projectPreferencesKey('account/two'))
    expect(projectPreferencesKey('account/one')).toContain('account%2Fone')
  })
  test('restores only display preferences and validates enum values', () => {
    const prefs = parseProjectPreferences(JSON.stringify({ focusedIds: ['p', 'p', 5, ''], search: 'release', filter: 'focused', sort: 'name-asc', projects: [project] }))
    expect(prefs).toEqual({ focusedIds: ['p'], search: 'release', filter: 'focused', sort: 'name-asc' })
    expect(parseProjectPreferences('{"filter":"invalid","sort":"invalid"}')).toEqual(emptyProjectPreferences())
    expect(() => parseProjectPreferences('{')).toThrow()
  })
  test('filters all, focused and unfocused without mutating project entities', () => {
    const prefs = { ...emptyProjectPreferences(), focusedIds: ['2'] }
    expect(filterAndSortProjects(projects, { ...prefs, filter: 'focused' }, 'en').map(value => value.id)).toEqual(['2'])
    expect(filterAndSortProjects(projects, { ...prefs, filter: 'unfocused' }, 'en').map(value => value.id)).toEqual(['1', '10'])
    expect(projects.map(value => value.id)).toEqual(['2', '10', '1'])
  })
  test('searches name and description case-insensitively with trimmed whitespace', () => {
    expect(filterAndSortProjects(projects, { ...emptyProjectPreferences(), search: ' NATIVE ' }, 'en').map(value => value.id)).toEqual(['2', '1'])
    expect(filterAndSortProjects(projects, { ...emptyProjectPreferences(), search: 'no match' }, 'en')).toEqual([])
  })
  test('implements each sort with alphabetical collation and deterministic ties', () => {
    const prefs = emptyProjectPreferences()
    expect(filterAndSortProjects(projects, prefs, 'en').map(value => value.id)).toEqual(['2', '1', '10'])
    expect(filterAndSortProjects(projects, { ...prefs, sort: 'created-desc' }, 'en').map(value => value.id)).toEqual(['10', '2', '1'])
    expect(filterAndSortProjects(projects, { ...prefs, sort: 'name-asc' }, 'en').map(value => value.id)).toEqual(['1', '10', '2'])
    expect(filterAndSortProjects(projects, { ...prefs, sort: 'name-desc' }, 'en').map(value => value.id)).toEqual(['2', '10', '1'])
  })
})

describe('role management', () => {
  test('only owners and admins manage projects', () => {
    expect(canManageProject(project)).toBe(true)
    expect(canManageProject({ ...project, role: 'admin' })).toBe(true)
    expect(canManageProject({ ...project, role: 'member' })).toBe(false)
  })
  test('allows non-owner self-exit and limits removal of other non-owners to the owner', () => {
    const owner = member('o', 'owner'), admin = member('a', 'admin'), regular = member('m', 'member')
    expect(projectMemberRemovalAction(project, owner, 'o')).toBeNull()
    expect(projectMemberRemovalAction(project, owner, 'another-owner')).toBeNull()
    expect(projectMemberRemovalAction({ ...project, role: 'admin' }, admin, 'a')).toBe('leave')
    expect(projectMemberRemovalAction({ ...project, role: 'member' }, regular, 'm')).toBe('leave')
    expect(projectMemberRemovalAction({ ...project, role: 'admin' }, regular, 'a')).toBeNull()
    expect(projectMemberRemovalAction(project, admin, 'o')).toBe('remove')
    expect(projectMemberRemovalAction(project, regular, null)).toBeNull()
  })
  test('protects the last owner and reserves all role edits for the owner', () => {
    const owner = member('o', 'owner'), admin = member('a', 'admin'), regular = member('m', 'member')
    const members = [owner, admin, regular]
    expect(canChangeMember(project, owner, members)).toBe(false)
    expect(canChangeMember(project, owner, [...members, member('o2', 'owner')])).toBe(true)
    expect(canChangeMember({ ...project, role: 'admin' }, admin, members)).toBe(false)
    expect(canChangeMember({ ...project, role: 'admin' }, regular, members)).toBe(false)
    expect(canChangeMember(project, regular, members)).toBe(true)
    expect(canChangeMember({ ...project, role: 'member' }, regular, members)).toBe(false)
  })
})

describe('invitation access settings', () => {
  test('blocks invite creation until enabled management access has been loaded', () => {
    const settings = { enabled: true, version: 3, canManage: true }
    expect(canCreateProjectInvitation(project, null)).toBe(false)
    expect(canCreateProjectInvitation(project, settings)).toBe(true)
    expect(canCreateProjectInvitation(project, { ...settings, enabled: false })).toBe(false)
    expect(canCreateProjectInvitation(project, { ...settings, canManage: false })).toBe(false)
    expect(canCreateProjectInvitation({ ...project, archivedAt: '2026-01-02' }, settings)).toBe(false)
  })
  test('sends the observed settings version and uses the real update response', async () => {
    const calls: unknown[] = []
    const saved = { enabled: false, version: 4, canManage: true }
    ;(window as any).klaus = { teamCollaboration: { request: async (input: unknown) => { calls.push(input); return saved } } }
    expect(await updateProjectInvitationAccess('p', { enabled: true, version: 3, canManage: true }, false)).toEqual(saved)
    expect(calls).toEqual([{ type: 'project-invitation-settings.update', projectId: 'p', version: 3, enabled: false }])
  })
  test('does not send writes when the server reports read-only settings', async () => {
    let calls = 0
    ;(window as any).klaus = { teamCollaboration: { request: async () => { calls++; throw new Error('Unexpected request') } } }
    await rejects(updateProjectInvitationAccess('p', { enabled: false, version: 1, canManage: false }, true))
    expect(calls).toBe(0)
  })
  test('surfaces conflicts and offline failures without returning invented settings', async () => {
    ;(window as any).klaus = { teamCollaboration: { request: async () => ({ error: { message: 'Version conflict' } }) } }
    await rejects(updateProjectInvitationAccess('p', { enabled: true, version: 1, canManage: true }, false), /Version conflict/)
    ;(window as any).klaus = { teamCollaboration: { request: async () => { throw new Error('Network unavailable') } } }
    await rejects(updateProjectInvitationAccess('p', { enabled: true, version: 1, canManage: true }, false), /Network unavailable/)
  })
})

describe('route isolation and cloud data', () => {
  test('preserves opaque chat and Board hash state while restoring selected projects and archive', () => {
    const hash = '#/chat/abc&boardFilter=todo%20items&session=a%2Fb'
    const next = routeHash(hash, { projectId: 'project/1', archived: true, inviteToken: null })
    expect(next).toBe(`${hash}&tcProject=project%2F1&tcArchived=1`)
    expect(readRoute(next)).toEqual({ projectId: 'project/1', archived: true, inviteToken: null })
  })
  test('clears obsolete account-unscoped list filters from the route', () => {
    expect(routeHash('#session=x&tcSearch=old&tcView=grid', { projectId: null, archived: false, inviteToken: 'token' })).toBe('#session=x&tcInvite=token')
    expect(readRoute('#tcSearch=private&tcView=grid')).toEqual({ projectId: null, archived: false, inviteToken: null })
  })
  test('loads all cloud pages and detects repeated cursors', async () => {
    expect(await allPages(async cursor => cursor ? { items: [3], nextCursor: null } : { items: [1, 2], nextCursor: '2' })).toEqual([1, 2, 3])
    await rejects(allPages(async () => ({ items: [1], nextCursor: '0' })))
  })
  test('rejects a missing bridge instead of returning empty fake projects', async () => {
    ;(window as any).klaus = {}
    await rejects(request({ type: 'projects.list' }), /host is unavailable/)
  })
  test('forwards requests and does not suppress version conflicts', async () => {
    const calls: unknown[] = []
    ;(window as any).klaus = { teamCollaboration: { request: async (input: unknown) => { calls.push(input); return { items: [project], nextCursor: null } } } }
    expect((await request({ type: 'projects.list', archived: true })).items).toEqual([project])
    expect(calls).toEqual([{ type: 'projects.list', archived: true }])
    ;(window as any).klaus = { teamCollaboration: { request: async () => { throw new Error('version conflict') } } }
    await rejects(request({ type: 'projects.archive', projectId: 'p', version: 1 }), /version conflict/)
  })
})
