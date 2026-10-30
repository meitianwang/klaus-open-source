# Inkbound companions

Inkbound is an original hand-drawn fantasy collection for Klaus. Its charcoal ink,
ivory highlights, persimmon details and dusty blue accents connect nine distinct
silhouettes: Klaus, Luma, Wick, Quill, Dapple, Morrow, Wisp, Amble and Twill.

`concept.png` records the selected visual direction. The eighteen source PNGs
contain the original motion drawings and separately refined directional gaze
poses. `prompts.json` records the exact image generation instructions.

Every published atlas has a transparent 1536 × 2288 canvas with eight columns and
eleven rows of 192 × 208 cells. The nine motion rows contain 6, 8, 8, 4, 5, 8, 6,
6 and 6 frames: idle, run right, run left, wave, jump, setback, waiting, working
and review. The final two rows contain sixteen clockwise gaze directions,
starting upward. Unused cells are transparent.

`atlas-manifest.json` records source hashes, exact frame placements, scale and
jump offsets, and the hashes of the shipped lossless WebP atlases. Registration
uses the actual alpha silhouettes instead of assuming evenly spaced source
artwork, preserves proportions with one scale for each motion set, keeps jump
elevation and reserves transparent space around each frame.

To rebuild the published atlases, run `node apps/desktop/artwork/inkbound/pack.cjs`
from the repository root with `pngjs` available to Node and `cwebp` on PATH. These
art production tools are not runtime dependencies of the desktop client.
