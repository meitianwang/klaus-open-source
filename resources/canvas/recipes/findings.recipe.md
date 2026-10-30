# Findings

For a prioritized list of PROBLEMS the reader is expected to act on: code review,
security audit, architecture review, incident review, dependency audit.

The unit is one finding. A finding without evidence and a fix is an opinion, so
every row carries both.

## Shape

1. **Title and the count that matters.** An `H1`, then a `Grid` of `Stat`s broken
   down by severity. The reader's first question is "how bad is this".
2. **One section per severity**, highest first. Skip a severity with no findings
   entirely — an empty "Critical" heading reads as a bug.
3. **Each finding** is a `Card` or `CollapsibleSection` carrying four things:
   - what is wrong, in one line
   - where: the file and line, in `Code`
   - why it matters: the concrete consequence, not a restatement
   - the fix: what to change
4. **What was checked.** A closing `FieldList`: the scope, the ruleset or method,
   and what was deliberately NOT covered.

## Rules

- Order by severity, then by blast radius. Never by file path — that is the
  order you found them in, not the order to fix them in.
- Every finding names a file. A finding that cannot be located cannot be fixed;
  drop it or say plainly that it is a general observation.
- Say the consequence, not the category. "Unbounded loop over user input, so a
  1MB payload pins a core" beats "performance issue".
- One severity vocabulary, defined in the canvas. Do not mix critical/high/medium
  with P0/P1/P2.
- No filler findings. Three real problems is a better review than three real
  problems padded with eight style notes.
- A clean result is a real result. Say so with a `Callout tone="success"` rather
  than inventing something to report.
- When the review ends in "here is what to do next", that list is
  `ImprovementList`, not another findings list. A finding says what is wrong; an
  improvement says what to do and roughly what it costs. Keep them apart — merged,
  the reader cannot tell which entries are evidence and which are proposals.
- If the ranking rests on two measured axes plus a magnitude — how often, how
  slow, how expensive — `MultiplierBubbleChart` shows why one item is the outlier.
  A bar chart per axis makes the reader do that join in their head.

## Skeleton

```tsx
import {
  Callout,
  Card,
  Code,
  CollapsibleSection,
  FieldList,
  Grid,
  H1,
  H2,
  Row,
  SendToChatButton,
  Stack,
  Stat,
  Tag,
  Text,
} from 'klaus/canvas';

interface Finding {
  id: string;
  title: string;
  location: string;
  impact: string;
  fix: string;
}

const HIGH: Finding[] = [
  {
    id: 'F1',
    title: 'Session token is logged in full on refresh failure',
    location: 'src/auth/refresh.ts:88',
    impact:
      'The token reaches the rotating log file and any shipper reading it, so a log grant becomes an account grant.',
    fix: 'Log the token id and expiry only; never the token body.',
  },
];

function FindingCard({ finding, tone }: { finding: Finding; tone: 'danger' | 'warning' }) {
  return (
    <Card>
      <Stack gap="component">
        <Row gap="inline" justify="space-between">
          <Row gap="inline">
            <Tag tone={tone}>{finding.id}</Tag>
            <Text weight="medium">{finding.title}</Text>
          </Row>
          <SendToChatButton text={`Fix ${finding.id} at ${finding.location}: ${finding.fix}`}>
            Fix this
          </SendToChatButton>
        </Row>
        <Code>{finding.location}</Code>
        <Text tone="secondary" size="small">
          {finding.impact}
        </Text>
        <Text size="small">
          <strong>Fix: </strong>
          {finding.fix}
        </Text>
      </Stack>
    </Card>
  );
}

export default function AuthReview() {
  return (
    <Stack gap="section">
      <H1>Auth module review</H1>

      <Grid columns={3}>
        <Stat label="High" value={HIGH.length} tone="danger" />
        <Stat label="Medium" value="2" tone="warning" />
        <Stat label="Files reviewed" value="11" />
      </Grid>

      <Stack gap="container">
        <H2>High</H2>
        {HIGH.map((finding) => (
          <FindingCard key={finding.id} finding={finding} tone="danger" />
        ))}
      </Stack>

      <CollapsibleSection title="Medium (2)">
        <Text tone="secondary" size="small">…</Text>
      </CollapsibleSection>

      <Callout title="Severity means">
        High: exploitable or data-losing as written. Medium: needs an unlikely
        precondition. Anything smaller was left out.
      </Callout>

      <FieldList
        items={[
          { label: 'Scope', value: 'src/auth/**, 11 files' },
          { label: 'Method', value: 'manual read plus dependency advisory check' },
          { label: 'Not covered', value: 'the OAuth provider itself, test fixtures' },
        ]}
      />
    </Stack>
  );
}
```
