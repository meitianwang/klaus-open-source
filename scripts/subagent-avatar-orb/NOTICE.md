# Orb shader attribution

`effect.wgsl` is from https://github.com/LerSent001/orb at commit
`8d1736e1fc5b41a5037b524403f35b7952b038f0`, licensed under the MIT License.
The license is retained in `LICENSE`. `renderer.ts` supplies the palette and a
single-device offscreen renderer used only while generating the static assets.

Run `node scripts/generate-subagent-avatars.mjs` from `apps/desktop` to regenerate
`frontend/public/subagent-avatars/orb-*.webp`. The generated images are the only
orb code or artwork loaded by the client; the shader is not part of its runtime.
