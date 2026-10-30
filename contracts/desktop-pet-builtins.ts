import type { PetCatalogEntry } from "./desktop-pet";

export const BUILT_IN_PETS: PetCatalogEntry[] = (
  [
    ["klaus", "Klaus", "A curious little imp with a coat full of midnight mischief."],
    ["luma", "Luma", "A long-eared dreamling who listens for bright ideas."],
    ["wick", "Wick", "A lantern beast keeping a warm light beside your work."],
    ["quill", "Quill", "A moth courier carrying small messages through the dusk."],
    ["dapple", "Dapple", "A puddle sprite in oversized boots, ready for a splash."],
    ["morrow", "Morrow", "A gentle long-nosed wanderer following a thoughtful trail."],
    ["wisp", "Wisp", "A soft cloudruff with a drifting tuft and a curious heart."],
    ["amble", "Amble", "A quiet night grazer taking the long way under the stars."],
    ["twill", "Twill", "A spiral-tailed companion unwinding one idea at a time."],
  ] as const
).map(([id, name, description]) => ({
  id,
  name,
  description,
  spriteVersion: 2,
  spritesheetUrl: `/pets/${id}.webp`,
  builtIn: true,
}));
