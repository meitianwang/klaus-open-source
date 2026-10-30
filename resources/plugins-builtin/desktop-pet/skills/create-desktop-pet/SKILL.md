---
name: create-desktop-pet
description: Create or upgrade custom Klaus desktop pets, including transparent sprite atlases, all nine animations, sixteen cursor directions and a validated local manifest. Use for a new pet or a request to upgrade an existing pet directory.
---

# Desktop pet creation

Use the character and style requested by the user. If the character is unspecified, ask for that creative choice before generating it. For an upgrade, inspect the existing manifest and image first, preserve the character, and keep the original files until the replacement passes validation.

Use the configured image generation tool to make the visual. If that tool or its selected provider is unavailable, report the actual configuration needed. Do not substitute an unrelated stock character or claim an image was generated when it was not. Use available image tools to inspect the result and correct visible seams, missing poses, unwanted backgrounds or inconsistent character scale.

Save each new pet in its own directory under the pets directory supplied by the application. Use a lowercase slug for the directory, preserve existing pets, and keep sprite frames on a transparent canvas. A version 2 atlas is exactly 1536 by 2288 pixels: 8 columns, 11 rows, with 192 by 208 pixel cells. Keep the same character, scale and ground baseline in every frame. Do not draw grid lines, labels or decoration outside the character.

Rows 0 through 8 contain these animations, from left to right:

| Row | Animation | Active frames |
| --- | --- | --- |
| 0 | Idle | 6 |
| 1 | Run right | 8 |
| 2 | Run left | 8 |
| 3 | Wave | 4 |
| 4 | Jump | 5 |
| 5 | Failure | 8 |
| 6 | Waiting | 6 |
| 7 | Running task | 6 |
| 8 | Review | 6 |

Rows 9 and 10 contain sixteen distinct gaze poses, clockwise in 22.5 degree steps, starting straight up. Fill unused animation cells transparently. Preserve outlines, colors and anatomy across all frames. For an upgrade from version 1, retain the existing nine animation rows and add the sixteen gaze poses.

Write `pet.json` beside the PNG or WebP image, with `displayName`, a concise `description`, `spriteVersionNumber: 2`, and `spritesheetPath` naming the relative image path. The image must remain inside that directory and be at most 20 MiB. The manifest image path must not escape through a symbolic link.

Run the validation helper bundled beside this skill. Use an available Node.js runtime for this dependency-free helper. The local PDF dependency tool returns Python and PDF helper paths, not a Node.js executable. Do not install packages to run the validator.

```sh
node /absolute/path/to/this/skill/scripts/validate-pet.cjs /absolute/path/to/pet-directory --version 2
```

The helper checks the actual image format, dimensions, manifest and file containment. Also inspect the complete atlas visually: the structural validator cannot confirm the animation poses or transparency. Do not finish until both structural and visual checks pass. Tell the user the saved directory and how to use Refresh in Settings → Desktop pet to select it. Never change the selected pet without the user's request.
