# Canvas Recipes

A recipe is a single-file reference for one recurring Canvas output shape. Read
this index when the deliverable might have a known shape; open at most ONE recipe
whose description matches what was actually asked for, and otherwise continue
with the SDK declarations alone.

A recipe is a layout reference, not a visual authority. Explicit user
instructions and any supplied visual source outrank it.

## Choosing

Match the requested OUTPUT SHAPE, not the subject matter and not the input file.
The nearest recipe is not the right recipe just because it is the only one
touching a similar topic — a cost analysis is not a code review because both
have tables, and a request to keep a page's styling is not a request for a design
system.

If nothing matches directly, write the canvas from `../sdk/index.d.ts` and the
supplied source. That is the normal case, not a fallback.

## Index

| Name | Use it when |
| --- | --- |
| [report](report.recipe.md) | The output is primarily READ: research summaries, audits, status reports, evidence reviews, metric overviews, mixed chart and table narratives. |
| [findings](findings.recipe.md) | The output is a prioritized list of PROBLEMS with evidence and a suggested fix for each, NOT tied to a diff: architecture review, dependency audit, incident review. |
| [code-review](code-review.recipe.md) | The output reviews actual code CHANGES — a pull request, a commit range, a patch — and comments need to sit on specific diff lines. |
| [dashboard](dashboard.recipe.md) | The output is primarily WATCHED: current-state numbers, health, quotas, usage, throughput — where the reader wants the state at a glance rather than a narrative. |
| [comparison](comparison.recipe.md) | The output weighs OPTIONS against shared criteria: tool or vendor selection, before/after, A vs B vs C, migration trade-offs. |
| [presentation](presentation.recipe.md) | Somebody will TALK over it: a deck for a pitch, a demo, a lesson, a review. Not for a document read alone. |

## Two things that are not in any recipe

**The window's frame.** By default the window supplies page padding and caps the
reading width, which is right for a report. A canvas that has to paint to the
edge — a deck, a full-bleed diagram, a reproduction of a supplied design — says
so once at module level:

```tsx
import { Stack, Text } from 'klaus/canvas';
import type { CanvasRuntimeConfig } from 'klaus/canvas';

export const canvasConfig: CanvasRuntimeConfig = { shell: { mode: 'full-bleed' } };

export default function EdgeToEdge() {
  return (
    <Stack gap="section" style={{ padding: 48 }}>
      <Text>The window adds no padding here; this canvas owns its own.</Text>
    </Stack>
  );
}
```

Do not fight the default padding with negative margins. Declare the shell.

**Asking the user about the canvas.** The window has an "Ask about…" mode that
lets the reader point at any element and send a question with the quoted content
back to chat. A canvas can open that mode from a button of its own with
`useCanvasAnnotation()`. It never learns what the reader picked or typed — it
opens the door, nothing more.


## After writing

Run `canvas_check` on the file. Fix everything it reports and re-run until it is
clean. A canvas that has not been checked clean is not finished.
