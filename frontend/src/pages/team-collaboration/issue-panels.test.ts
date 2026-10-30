import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
const source = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

describe('issue reactions', () => {
  test('toggles through the documented idempotent switch, never a blind flip', () => {
    const reactions = source('./issue-reactions.tsx')
    expect(reactions).toContain("type: 'issue-reactions.list'")
    expect(reactions).toContain("type: 'issue-reactions.toggle'")
    // The server takes `active` and converges to it; sending the observed inverse
    // would let a retry after a dropped reply undo the user's own click.
    expect(reactions).toContain('const active = !(userId && users.includes(userId))')
    expect(reactions).toContain("type: 'issue-reactions.toggle', projectId, issueId, reaction, active }")
    expect(reactions).not.toMatch(/active: !active|active: true,?\s*\}\)\s*$/m)
  })
  test('uses the same six reactions as the discussion composer', () => {
    const reactions = source('./issue-reactions.tsx'), messages = source('./discussion-messages.tsx')
    const set = "['👍', '❤️', '🎉', '👀', '✅', '🙏']"
    expect(reactions).toContain(set)
    expect(messages).toContain(set)
  })
})

describe('issue activity', () => {
  test('pages the documented projection and renders actor, changes and time', () => {
    const activity = source('./issue-reactions.tsx'), contract = source('../../../../contracts/team-collaboration.d.ts')
    expect(activity).toContain("type: 'issue-activity.list'")
    expect(activity).toContain('cursor, limit: ISSUE_ACTIVITY_PAGE_SIZE')
    expect(activity).toContain('setCursor(page.nextCursor)')
    expect(activity).toContain('row.actor.displayName')
    expect(activity).toContain('change?.before')
    expect(activity).toContain('change?.after')
    expect(activity).toContain('row.createdAt')
    expect(contract).toContain('cursor?: string; limit?: number }; response: CollaborationPage<CollaborationIssueActivity>')
  })
  test('labels every Issue event type the activity panel can receive', () => {
    const activity = source('./issue-reactions.tsx'), i18n = source('./board-i18n.ts')
    // The server-side list of Issue events is checked against these labels by
    // the server repository's cross-repository contract test.
    for (const type of ['issues.create', 'issues.update', 'issues.archive', 'issues.restore', 'issues.reorder', 'issue-reactions.toggle', 'projects.archive', 'projects.restore', 'files.upload', 'files.remove']) {
      expect(activity).toContain(`'${type}':`)
    }
    // A missing label must degrade to the raw type rather than crash the panel.
    expect(activity).toContain('label ? t(label) : row.type')
    expect(i18n).toContain('activity_issue_reactions_toggle:')
  })
})

describe('issue attachments', () => {
  test('declares the attachment allowlist the server accepts', () => {
    const contract = source('./attachment-contract.ts')
    for (const pairing of [
      'png: \'image/png\'', 'jpg: \'image/jpeg\'', 'jpeg: \'image/jpeg\'', 'gif: \'image/gif\'', 'webp: \'image/webp\'',
      'pdf: \'application/pdf\'', 'txt: \'text/plain\'', 'md: \'text/markdown\'', 'csv: \'text/csv\'',
    ]) expect(contract).toContain(pairing)
    expect(contract).toContain('docx: \'application/vnd.openxmlformats-officedocument.wordprocessingml.document\'')
    expect(contract).toContain('xlsx: \'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\'')
    expect(contract).toContain('8 * 1024 * 1024')
  })
  test('uploads under the project root scope and transfers through issues.create', () => {
    const attachments = source('./issue-attachments.tsx'), create = source('./issue-create.tsx')
    // The documented create path: project-scope upload, then attachmentIds on the
    // create call, which moves them inside the create transaction.
    expect(attachments).toContain("boardRequest({ type: 'files.upload', scope: { projectId }, name: item.file.name, mediaType, dataBase64: await encodeAttachment(item.file) })")
    expect(create).toContain('uploadDraftAttachments(projectId, files)')
    expect(create).toContain('...(attachmentIds ? { attachmentIds } : {})')
    expect(create).toContain("type: 'issues.create', projectId, ...form")
    // patch must never carry attachmentIds: the server rejects the field there.
    const detail = source('./issue-detail.tsx')
    expect(detail).toContain("type: 'issues.update', projectId: project.id, issueId, version: issue.version, patch: { ...form, title: form.title.trim() }")
    expect(detail).not.toContain('attachmentIds')
  })
  test('manages the created issue through the issue scope and both file channels', () => {
    const attachments = source('./issue-attachments.tsx')
    expect(attachments).toContain('scope: CollaborationFileScope = { projectId, issueId }')
    expect(attachments).toContain("boardRequest({ type: 'files.list', scope })")
    expect(attachments).toContain("type: 'files.remove', scope, fileId: file.id")
    expect(attachments).toContain('boardBridge().downloadFile(scope, file.id)')
    expect(attachments).toContain('boardBridge().previewFile(scope, file.id)')
    // A download-kind preview is saved instead of rendered as an empty panel.
    expect(attachments).toContain("if (value.kind === 'download') { await boardBridge().downloadFile(scope, file.id); return }")
    expect(attachments).toContain('ATTACHMENT_SCOPE_LIMIT')
    expect(attachments).toContain('files.length >= ATTACHMENT_SCOPE_LIMIT')
  })
})

describe('permanent issue deletion', () => {
  test('gates on the server preconditions and says what survives', () => {
    const remove = source('./issue-delete.tsx')
    expect(remove).toContain("type: 'issues.delete', projectId: project.id, issueId: issue.id, version: issue.version, confirmIdentifier: confirm")
    // The archive precondition is the ISSUE's own: the project being archived is
    // not part of the server's check, so the UI must not require it either.
    expect(remove).toContain('const archived = !!issue.archivedAt')
    expect(remove).toContain('confirm === issue.identifier')
    expect(remove).not.toContain('project.archivedAt')
    // The blocker is stated in the dialog rather than surfacing as a 409.
    expect(remove).toContain('deleteIssueArchiveFirst')
    // The retention wording is the server's actual behaviour for a deleted Issue.
    expect(remove).toContain('deleteIssueRetainsDiscussions')
    expect(remove).toContain('deleteIssueRetainsLinks')
    expect(remove).toContain('deleteIssueRemovesAttachments')
  })
  test('only offers deletion once the issue is archived, and clears the drawer after', () => {
    const detail = source('./issue-detail.tsx'), board = source('./ProjectBoard.tsx')
    // The entry rides on owner/admin (the server's `administrator()`), never on
    // `writable`: that flag is false exactly when the issue is archived, and an
    // archived issue is the only one the server will delete.
    expect(detail).toContain('const deletable = !accessDenied && !denied && canManageProject(project)')
    expect(detail).toContain('disabled={!deletable || busy || dirty || !issue.archivedAt}')
    expect(detail).not.toContain('project.archivedAt')
    expect(detail).toContain('onDeleted={() => onDeleted(issue.id)}')
    expect(board).toContain('onDeleted={() => { setIssueRoute(null); setRevision(current => current + 1); void reload(); void projectChanged.current() }}')
  })
})

describe('discussion sources', () => {
  test('stores references only and never resolves them client-side', () => {
    const sources = source('./discussion-sources.tsx'), contract = source('../../../../contracts/team-collaboration.d.ts')
    expect(sources).toContain("type: 'discussion-sources.list'")
    expect(sources).toContain("type: 'discussion-sources.add', projectId, discussionId, kind, title: title.trim(), content: content.trim()")
    expect(sources).toContain("type: 'discussion-sources.remove', projectId, discussionId, sourceId: source.id")
    expect(contract).toContain('kind: "url" | "markdown"')
    // A URL entry is a citation: the server does not fetch it, and neither do we.
    expect(sources).not.toMatch(/fetch\(|XMLHttpRequest/)
    expect(sources).toContain("rel=\"noreferrer noopener\"")
    expect(sources).toContain('sourceUrlHint')
    expect(sources).toContain("setKind(event.target.value as 'url' | 'markdown')")
  })
  test('mounts inside the discussion aside beside the member and link panels', () => {
    expect(source('./discussion-detail.tsx')).toContain('<DiscussionSources projectId={project.id} discussionId={discussionId} writable={writable && joined} revision={revision}')
  })
})

describe('collaboration surface policy', () => {
  test('the new controls carry aria-labels instead of hover tooltips', () => {
    for (const file of ['./issue-reactions.tsx', './issue-attachments.tsx', './issue-delete.tsx', './discussion-sources.tsx']) {
      const text = source(file)
      // A DOM `title` attribute is the tooltip this repository forbids on these
      // surfaces. A `title={...}` prop on our own BoardModal is the dialog
      // heading, not a tooltip, so only the attribute form is rejected.
      expect(text).not.toMatch(/\stitle="/)
      expect(text).not.toContain('data-klaus-tip')
      expect(text).not.toMatch(/<Tooltip/)
    }
    // And the icon-only controls really are labelled.
    expect(source('./issue-reactions.tsx')).toContain("aria-label={t('addReaction')}")
    expect(source('./issue-attachments.tsx')).toContain("aria-label={t('addAttachment')}")
  })
  test('keeps the collaboration styles inside the shared module', () => {
    const css = source('./board-styles.module.css')
    for (const rule of ['.reactions {', '.activity {', '.activityRow {', '.attachments {', '.attachmentRow {', '.sources {', '.sourceRow {', '.retainedList {']) expect(css).toContain(rule)
    // No inline tooltip affordance was introduced on these surfaces.
    expect(css).not.toContain('[title]')
  })
})
