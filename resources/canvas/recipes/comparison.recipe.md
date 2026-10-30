# Comparison

For weighing OPTIONS against shared criteria: tool or vendor selection, before
and after, A vs B vs C, migration trade-offs, build vs buy.

The point of a comparison canvas is that the reader can reach their OWN
conclusion. That means the criteria are explicit, applied identically to every
option, and separated from the recommendation.

## Shape

1. **Title and the recommendation.** State the pick and the one reason for it up
   front. Hiding the recommendation does not make the comparison more objective;
   it just makes the reader hunt.
2. **Criteria, declared.** A `FieldList` or short `Table` naming what is being
   compared on and why those criteria. Weighting, if any, goes here.
3. **The matrix.** One `Table` with options as columns (or rows) and criteria as
   the other axis. Every cell filled — an empty cell reads as a zero when it
   usually means "not investigated".
4. **Where they actually differ.** The criteria where the options tie are noise.
   Give the deciding two or three their own `H2` with the detail.
5. **Cost of being wrong.** A `Callout`: what switching later costs, what is
   irreversible, what assumption the recommendation rests on.

## Rules

- Same criteria for every option. A comparison that praises A on criteria A is
  good at and B on different criteria is not a comparison.
- Mark unknowns as unknown. `—` with a legend beats a guessed value, and beats
  silently dropping the row.
- Separate fact from judgement. Measured numbers and "we prefer this" must be
  visually distinguishable — `Tag` the judgements or keep them in their own
  column.
- No scoring out of 10 unless the reader supplied the scale. An invented
  composite score launders judgement as arithmetic.
- Say what would change the recommendation. A recommendation with no failure
  condition has not been thought through.
- Use `Tag` tones for verdicts, not row tints. Tinting whole rows in a comparison
  makes the winning option look like an error state.

## Skeleton

```tsx
import {
  Callout,
  Divider,
  FieldList,
  H1,
  H2,
  Row,
  Stack,
  Table,
  Tag,
  Text,
} from 'klaus/canvas';

export default function QueueComparison() {
  return (
    <Stack gap="section">
      <Stack gap="component">
        <H1>Use Postgres queues, not Kafka</H1>
        <Text tone="secondary">
          At 40 messages/second with one consumer group, Kafka's throughput
          advantage is unreachable and its operational cost is not.
        </Text>
      </Stack>

      <Stack gap="container">
        <H2>Criteria</H2>
        <FieldList
          items={[
            { label: 'Throughput headroom', value: 'Must handle 10× current 40 msg/s' },
            { label: 'Operational cost', value: 'Hours per month of maintenance' },
            { label: 'Delivery guarantee', value: 'At-least-once is sufficient' },
            { label: 'Team familiarity', value: 'Existing on-call knowledge' },
          ]}
        />
      </Stack>

      <Table
        columns={[
          { key: 'criterion', title: 'Criterion' },
          { key: 'postgres', title: 'Postgres' },
          { key: 'kafka', title: 'Kafka' },
          { key: 'sqs', title: 'SQS' },
        ]}
        rows={[
          { criterion: 'Throughput ceiling', postgres: '~2k msg/s', kafka: '100k+ msg/s', sqs: '~3k msg/s' },
          { criterion: 'Ops hours / month', postgres: '0 (already run)', kafka: '8–12', sqs: '1' },
          { criterion: 'Delivery', postgres: 'at-least-once', kafka: 'at-least-once', sqs: 'at-least-once' },
          { criterion: 'On-call knows it', postgres: 'yes', kafka: 'no', sqs: 'partly' },
          { criterion: 'Cost at 40 msg/s', postgres: '$0', kafka: '$340/mo', sqs: '$14/mo' },
          { criterion: 'Replay window', postgres: '—', kafka: '7 days', sqs: '—' },
        ]}
      />
      <Text tone="quaternary" size="small">
        — means not applicable or not investigated, never zero.
      </Text>

      <Divider />

      <Stack gap="container">
        <H2>The two criteria that decide it</H2>
        <Text tone="secondary">
          Throughput: 10× headroom is 400 msg/s, which Postgres clears by 5×. The
          Kafka ceiling is real but buys nothing at this volume.
        </Text>
        <Text tone="secondary">
          Ops cost: Kafka adds a system on-call does not know, and the 8–12 hours
          a month is the same order as the entire queue project.
        </Text>
        <Row gap="inline">
          <Tag tone="success">Postgres: recommended</Tag>
          <Tag tone="neutral">SQS: acceptable fallback</Tag>
          <Tag tone="warning">Kafka: not at this scale</Tag>
        </Row>
      </Stack>

      <Callout tone="warning" title="What would change this">
        Sustained throughput above roughly 500 msg/s, or a need to replay days of
        history, inverts the recommendation toward Kafka. Migrating off Postgres
        queues later means rewriting the consumer, which is about a week.
      </Callout>
    </Stack>
  );
}
```
