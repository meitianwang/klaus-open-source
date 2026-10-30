# Report

For a canvas that is READ: a research summary, an audit write-up, a status
report, an evidence review, a metric overview, a narrative mixing prose with
charts and tables.

Not for a list of problems to act on (use `findings`), and not for numbers the
reader watches rather than reads (use `dashboard`).

## Shape

1. **Title, then the conclusion.** An `H1`, then one `Text` paragraph that states
   the answer. A reader who stops after the first screen should already have it.
2. **The numbers that support it.** A `Grid` of 3–4 `Stat`s. Only figures the
   conclusion actually rests on.
3. **Sections.** One `H2` per theme, each with the evidence for that theme:
   prose, a table, a chart, or a `FieldList`. Order by importance, not by the
   order you discovered things.
4. **Caveats.** A `Callout tone="warning"` for what would change the conclusion —
   thin data, an untested assumption, a source that disagreed.
5. **Provenance.** A closing `FieldList` or `Text`: where the data came from, the
   window it covers, when it was gathered.

## Rules

- Lead with the conclusion. A report that builds to its answer buries it.
- Every chart and table gets a specific title and its units. `unit="ms"` on the
  chart, not "latency" in prose three paragraphs up.
- Cite where a number came from. An uncited figure in a generated report is
  indistinguishable from an invented one.
- Say what you do not know. A gap stated plainly is information; a gap papered
  over is a defect.
- No empty sections and no placeholder rows. Drop the section instead.
- Put long evidence in a `CollapsibleSection`, closed by default. The argument
  stays readable and the proof stays available. Use `CollapsibleCard` instead when
  the reader needs to know what is inside without opening it: it keeps a `summary`
  line visible while shut, so a page of collapsed items is still scannable.
- `ReportShell` / `ReportSection` are worth using once a report has more than
  about three sections. The shell caps the reading width — body text running the
  full width of a maximised window is text the eye loses its place in — and
  `ReportSection` gives each heading a one-line brief saying what it answers.
- `Callout` annotates the block it sits next to. `Banner` qualifies the WHOLE
  page and belongs at the top: "three files could not be read", "figures are from
  a cached run". A page-level caveat placed halfway down gets read too late.

## Skeleton

```tsx
import {
  Callout,
  CollapsibleSection,
  Divider,
  FieldList,
  Grid,
  H1,
  H2,
  LineChart,
  Stack,
  Stat,
  Table,
  Text,
} from 'klaus/canvas';

export default function LatencyReport() {
  return (
    <Stack gap="section">
      <Stack gap="component">
        <H1>API latency regressed 38% after the March 12 deploy</H1>
        <Text tone="secondary">
          p95 moved from 210ms to 290ms and has not recovered. The change is
          isolated to the search endpoint; every other route is flat.
        </Text>
      </Stack>

      <Grid columns={3}>
        <Stat label="p95 before" value="210" unit="ms" />
        <Stat label="p95 after" value="290" unit="ms" tone="danger" />
        <Stat label="Routes affected" value="1" description="of 24" />
      </Grid>

      <Divider />

      <Stack gap="container">
        <H2>Where the time went</H2>
        <LineChart
          title="p95 latency by day"
          unit="ms"
          caption="Source: gateway access logs, Mar 1 – Mar 26"
          labels={['Mar 1', 'Mar 8', 'Mar 12', 'Mar 19', 'Mar 26']}
          series={[{ name: 'search', values: [208, 212, 287, 291, 290] }]}
        />
        <Table
          columns={[
            { key: 'stage', title: 'Stage' },
            { key: 'before', title: 'Before', align: 'right' },
            { key: 'after', title: 'After', align: 'right' },
          ]}
          rows={[
            { stage: 'query parse', before: '4ms', after: '4ms' },
            { stage: 'index lookup', before: '31ms', after: '108ms' },
            { stage: 'serialize', before: '12ms', after: '12ms' },
          ]}
          rowTone={(row) => (row.stage === 'index lookup' ? 'danger' : 'default')}
        />
      </Stack>

      <Callout tone="warning" title="What would change this">
        The comparison uses one week either side of the deploy. Traffic mix also
        shifted that week, so some of the gap may be load rather than the change
        itself.
      </Callout>

      <CollapsibleSection title="Raw percentiles by day">
        <Text tone="secondary" size="small">…</Text>
      </CollapsibleSection>

      <FieldList
        items={[
          { label: 'Source', value: 'gateway access logs' },
          { label: 'Window', value: 'Mar 1 – Mar 26' },
          { label: 'Gathered', value: 'Mar 26' },
        ]}
      />
    </Stack>
  );
}
```
