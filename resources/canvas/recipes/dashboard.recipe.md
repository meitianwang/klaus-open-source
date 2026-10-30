# Dashboard

For a canvas that is WATCHED rather than read: current-state numbers, health,
quota and usage, throughput, cost. The reader wants the state at a glance and
drills in only when something looks wrong.

Not for an argument or a narrative — that is `report`. Not for a list of problems
to fix — that is `findings`.

## Shape

1. **Headline row.** A `Grid` of 3–5 `Stat`s, each with a `Delta` when a
   comparison period exists. These are the numbers someone opened this for.
2. **Trend.** One or two charts covering the same window, so the headline numbers
   have a shape behind them.
3. **Breakdown.** A `Table` or a horizontal `BarChart` splitting the headline by
   its most useful dimension — service, endpoint, region, model.
4. **Attention.** Only when something is actually off: a `Callout` naming what and
   the threshold it crossed.
5. **As-of line.** One `Text` stating the window and when it was captured. A
   dashboard without this is unreadable a day later.

## Rules

- Set `direction="inverse"` on every `Delta` where DOWN is good — latency, error
  rate, cost, queue depth. This is the most common defect in a generated
  dashboard: a green +40% on an error rate.
- Every `Stat` carries its unit. A bare `290` is not a measurement.
- Same window across every panel. Mixing a 7-day chart with a 24-hour stat makes
  the whole page lie.
- No gauge dials, no rainbow palettes, no decorative sparklines. Use
  `tokens.chart.sequence` in order.
- Only tint a number when its STATE is notable. A page where every stat is
  coloured has no signal left.
- Do not invent a target to compare against. Show the number without a threshold
  rather than with a made-up one.
- A panel the SDK has no chart for — a hand-drawn SVG, a supplied image, a table
  standing in for a plot — goes inside `ChartContainer`. It carries the same title,
  unit, legend and source line as the built-in charts, so one custom panel does not
  read as a foreign object on the page.

## Skeleton

```tsx
import {
  BarChart,
  Callout,
  Delta,
  Grid,
  H1,
  H2,
  LineChart,
  Progress,
  Stack,
  Stat,
  Table,
  Text,
} from 'klaus/canvas';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function GatewayHealth() {
  return (
    <Stack gap="section">
      <H1>Gateway health</H1>

      <Grid columns={4}>
        <Stat label="Requests" value="1.24" unit="M" trailing={<Delta value={8.2} />} />
        <Stat
          label="p95 latency"
          value="290"
          unit="ms"
          tone="warning"
          trailing={<Delta value={38.1} direction="inverse" />}
        />
        <Stat
          label="Error rate"
          value="0.42"
          unit="%"
          trailing={<Delta value={-12.0} direction="inverse" />}
        />
        <Stat label="Uptime" value="99.94" unit="%" />
      </Grid>

      <Stack gap="container">
        <H2>Traffic and latency</H2>
        <LineChart
          title="Requests per day"
          unit="thousands"
          labels={DAYS}
          series={[{ name: 'requests', values: [168, 172, 181, 179, 190, 121, 109] }]}
        />
        <BarChart
          title="p95 latency by endpoint"
          unit="ms"
          horizontal
          labels={['/search', '/documents', '/auth/refresh', '/health']}
          series={[{ name: 'p95', values: [290, 84, 41, 6] }]}
        />
      </Stack>

      <Stack gap="container">
        <H2>Quota</H2>
        <Progress label="Monthly request quota" value={1_240_000} max={2_000_000} format="percent" />
        <Table
          columns={[
            { key: 'service', title: 'Service' },
            { key: 'calls', title: 'Calls', align: 'right' },
            { key: 'errors', title: 'Errors', align: 'right' },
          ]}
          rows={[
            { service: 'search', calls: '612k', errors: '3.1k' },
            { service: 'documents', calls: '431k', errors: '0.9k' },
            { service: 'auth', calls: '197k', errors: '0.2k' },
          ]}
        />
      </Stack>

      <Callout tone="warning" title="p95 above the 250ms target">
        /search has been over target every day this week. Every other endpoint is
        within budget.
      </Callout>

      <Text tone="quaternary" size="small">
        Rolling 7 days, captured Mar 26 09:00 UTC.
      </Text>
    </Stack>
  );
}
```
