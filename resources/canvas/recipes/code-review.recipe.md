# Code review

For a review of actual code changes: a pull request, a commit range, a patch, a
diff the agent just produced. The reader wants to see the change and the comment
on the same line.

For findings that are NOT tied to a diff — an architecture review, a dependency
audit — use `findings` instead. The difference is whether there are diff lines to
anchor to.

## Shape

1. **Verdict and counts.** An `H1` stating whether this is ready, then a
   `MetricsGrid` of files changed, findings by severity, and lines touched.
2. **Blocking comments first.** A `FindingsList` of anything that must change
   before merge, each naming its file and line. The reader decides from this
   section alone.
3. **The diffs.** One `FileReview` per file, with threads anchored to the lines
   being discussed. Set `collapseContext` so unchanged runs fold.
4. **Non-blocking notes.** A `Disclosure` of suggestions that are not merge
   blockers. Keeping them out of section 2 is what makes section 2 trustworthy.
5. **What was checked.** A `Methodology` naming the scope and, explicitly, what
   was NOT reviewed.

## Rules

- Every comment anchors to a real line. `FileReview` places threads by
  `{ line, side }`; a comment that cannot name a line belongs in the findings
  list, not floating in a diff.
- Anchor on `side: 'new'` unless you are talking about deleted code.
- Say the consequence, not the category. "This logs the token, so a log grant
  becomes an account grant" beats "security issue".
- Separate blocking from advisory. A review that mixes them makes the author
  guess which is which, and they will guess wrong.
- Give each thread a `SendToChatButton` that asks for the fix. That is the whole
  point of reviewing inside Klaus rather than in a browser.
- Approving is a real outcome. Say so with a `Callout tone="success"` rather than
  inventing a nit to look thorough.
- `FileReview` is controlled: it renders the threads it is handed. When the reader
  can add comments of their own, hold them in `useReviewThreadStore()` rather than
  hand-rolling the state — it owns thread ids, so a second comment on one line does
  not overwrite the first, which is the bug every hand-rolled version has.

## Skeleton

```tsx
import {
  Callout,
  Disclosure,
  DocsSection,
  FileReview,
  FindingsList,
  H1,
  MetricsGrid,
  Methodology,
  SendToChatButton,
  Stack,
  Text,
  useCanvasState,
} from 'klaus/canvas';

const REFRESH_DIFF = [
  { kind: 'context' as const, oldLine: 85, newLine: 85, content: '  try {' },
  { kind: 'removed' as const, oldLine: 86, content: '    logger.info(`refresh failed for ${token}`)' },
  { kind: 'added' as const, newLine: 86, content: '    logger.info(`refresh failed for ${tokenId(token)}`)' },
  { kind: 'context' as const, oldLine: 87, newLine: 87, content: '  } catch (error) {' },
];

export default function AuthReview() {
  const [draft, setDraft] = useCanvasState<{ line: number; side: 'old' | 'new' } | null>('draft', null);

  return (
    <Stack gap="section">
      <H1>Blocked on one finding: the retry loop is unbounded</H1>

      <MetricsGrid
        variant="plain"
        metrics={[
          { label: 'Files changed', value: '3' },
          { label: 'Blocking', value: '1', tone: 'danger' },
          { label: 'Advisory', value: '2' },
          { label: 'Lines', value: '+41 / −18' },
        ]}
      />

      <DocsSection title="Must change before merge">
        <FindingsList
          grouped={false}
          findings={[
            {
              id: 'B1',
              title: 'Retry loop has no attempt cap',
              severity: 'critical',
              location: 'src/net/retry.ts:42',
              impact: 'A failing upstream spins this loop forever and pins a core.',
              fix: 'Cap attempts and add jitter between them.',
              action: <SendToChatButton text="Add an attempt cap and jitter to src/net/retry.ts:42">Fix this</SendToChatButton>,
            },
          ]}
        />
      </DocsSection>

      <DocsSection title="src/auth/refresh.ts" summary="Token redaction — looks right." divided>
        <FileReview
          filename="src/auth/refresh.ts"
          lines={REFRESH_DIFF}
          collapseContext={8}
          draftAnchor={draft ?? undefined}
          onRequestComment={(anchor) => setDraft({ line: anchor.line, side: anchor.side })}
          onDiscardDraft={() => setDraft(null)}
          onSubmitDraft={() => setDraft(null)}
          threads={[
            {
              id: 't1',
              anchor: { line: 86, side: 'new' },
              status: 'resolved',
              comments: [
                {
                  id: 'c1',
                  author: 'Klaus',
                  body: 'tokenId() truncates to 8 characters, which still correlates across log lines without carrying the secret.',
                },
              ],
            },
          ]}
          renderThreadFooter={() => (
            <SendToChatButton text="Explain the tokenId change in src/auth/refresh.ts">Ask about this</SendToChatButton>
          )}
        />
      </DocsSection>

      <Disclosure summary="Advisory notes (2)">
        <Text tone="secondary" size="small">Naming and an unused import. Neither blocks merge.</Text>
      </Disclosure>

      <Callout tone="success" title="Everything else reads clean">
        The token redaction and the error envelope changes are correct as written.
      </Callout>

      <Methodology
        scope="3 changed files, full diff"
        method="line-by-line read plus a check of the retry call sites"
        notCovered="the OAuth provider, generated clients, test fixtures"
        asOf="this commit"
      />
    </Stack>
  );
}
```
