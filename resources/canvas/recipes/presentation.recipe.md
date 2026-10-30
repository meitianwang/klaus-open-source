# Presentation

For a deck: a talk, a pitch, a demo walkthrough, a lesson, a design review paced
by whoever is presenting.

Not for a document someone reads alone — that is `report`. The test is whether
somebody is talking over it. If not, slides just hide content behind navigation.

## Shape

1. **Open on the conclusion.** Slide one states what you want the room to
   remember, `centered`. Not an agenda; nobody remembers an agenda.
2. **One idea per slide.** If a slide needs two headings, it is two slides.
3. **Evidence slides.** One chart or one short table each. A slide is read from
   across a room, so a 12-row table is a slide nobody reads.
4. **Close on the ask.** What should happen next, and who decides.
5. **Notes** carry what you would SAY, not what is already on the slide.

## Rules

- Slides hold claims, not paragraphs. Move the prose into `notes`.
- One chart per slide, `height` around 170 so it fits without scrolling.
- No slide numbers in titles — the deck shows the counter itself.
- Set `stateKey` so a reload returns to the slide the presenter was on.
- Keep it under about 12 slides. A generated 40-slide deck is a document that
  learned to paginate.

## Holding something back

`PresentationFragment` reveals part of a slide on a later forward press. The
forward key reveals the next fragment first and only moves to the next slide once
there is nothing left, so the presenter drives one key the whole way through.

Use it for exactly one thing: a point that lands better if the room has not
already read it. A list where the last item is the surprise, a chart whose
conclusion you want to state before showing. Three fragments on a slide is
usually two too many, and a fragment on every bullet turns a talk into a
click-through.

Do not use it for decoration. `effect="none"` exists for when the movement itself
is a distraction.

`PresentationStack` overlaps its children in one box, so a diagram can gain a
layer instead of walking down the screen as each fragment arrives.

```tsx
import { PresentationFragment, PresentationSlide, Presentation, Stack, Text } from 'klaus/canvas';
import type { CanvasRuntimeConfig } from 'klaus/canvas';

// A deck is the case for full-bleed: slides are read from across a room, and the
// report shell's reading-width cap wastes the projector.
export const canvasConfig: CanvasRuntimeConfig = { shell: { mode: 'full-bleed' } };

export default function CostDeck() {
  return (
    <Presentation title="Where the money goes" stateKey="cost-deck" height={360}>
      <PresentationSlide
        title="Three services, one bill"
        notes="Name the first two, pause, then reveal that the third is most of it."
      >
        <Stack gap="component">
          <Text>Search: 18% of spend.</Text>
          <PresentationFragment at={1}>
            <Text>Indexing: 22%.</Text>
          </PresentationFragment>
          <PresentationFragment at={2}>
            <Text weight="medium">Export: 60% — and it serves 40 people.</Text>
          </PresentationFragment>
        </Stack>
      </PresentationSlide>
    </Presentation>
  );
}
```

## Skeleton

```tsx
import {
  BarChart,
  Presentation,
  PresentationSlide,
  Row,
  Stack,
  Tag,
  Text,
} from 'klaus/canvas';

export default function QueueDeck() {
  return (
    <Presentation title="Queue choice" stateKey="queue-deck" showNotes height={360}>
      <PresentationSlide
        title="Use Postgres queues, not Kafka"
        subtitle="40 msg/s today, 400 at 10×"
        centered
        notes="Lead with the recommendation. Expect pushback on the ceiling; the next slide answers it."
      >
        <Text tone="secondary">Kafka's throughput advantage is unreachable at our volume. Its operational cost is not.</Text>
      </PresentationSlide>

      <PresentationSlide
        title="The ceiling is not the constraint"
        notes="Postgres clears 10× headroom by 5×. Only revisit above ~500 msg/s."
      >
        <BarChart
          title="Throughput ceiling"
          unit="msg/s"
          horizontal
          labels={['Postgres', 'SQS', 'Kafka']}
          series={[{ name: 'ceiling', values: [2000, 3000, 100000] }]}
        />
      </PresentationSlide>

      <PresentationSlide
        title="The cost is on-call"
        notes="8–12 hours a month is the same order as the whole queue project."
      >
        <Stack gap="component">
          <Row gap="inline">
            <Tag tone="success">Postgres</Tag>
            <Text size="small">Already run. On-call knows it. 0 new hours.</Text>
          </Row>
          <Row gap="inline">
            <Tag tone="warning">Kafka</Tag>
            <Text size="small">New system, unfamiliar to on-call, 8–12 hours a month.</Text>
          </Row>
        </Stack>
      </PresentationSlide>

      <PresentationSlide
        title="Decision needed"
        centered
        notes="Ask for a call today; the consumer work is blocked on it."
      >
        <Text>Ship on Postgres queues. Revisit above 500 msg/s or if replay becomes a requirement.</Text>
      </PresentationSlide>
    </Presentation>
  );
}
```
