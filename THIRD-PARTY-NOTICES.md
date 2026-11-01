# Third-party notices

Klaus Desktop is MIT licensed (see LICENSE). That license applies only to
original project material; third-party components keep their own licenses and
notices. This file records third-party material that ships inside this source
tree and the license terms that apply to it. Nothing here limits the MIT license
covering this project's own code.
Dependencies installed by npm and Cargo carry their own license files in their
packages; the packaged application collects runtime notices under
`frontend/public/third-party-notices/` and the engine's `licenses/` directory.

## Trademarks

Product and vendor names and logos that appear in this repository — including
Apple, GitHub, Google, Telegram, WeChat, WeCom, QQ, DingTalk, Feishu, iMessage,
WhatsApp, Claude, Codex, Cursor, DeepSeek, Kimi, Qwen, Zhipu, Qoder, Trae, Kiro
and MiniMax — are trademarks of their respective owners. They appear only to
identify the corresponding product or service and to indicate integration
compatibility. Their use does not imply endorsement, and the MIT license granted
here conveys no right to use those marks.

## Vendored source

### Liquid orb shader

`scripts/subagent-avatar-orb/effect.wgsl` is the liquid glass shader from
https://github.com/LerSent001/orb at commit
`8d1736e1fc5b41a5037b524403f35b7952b038f0`.

- License: MIT, Copyright (c) 2026 LerSent001.
- The license is retained beside the shader and in
  `frontend/public/third-party-notices/liquid-orb.txt`.
- It is used only by the asset generator. The client ships pre-rendered WebP
  images and contains no runtime shader or GPU renderer.

### highlight.js theme

`frontend/vendor/highlight-dark.css` is the "GitHub Dark" theme for highlight.js
(`package.json` depends on highlight.js 11.11.1).

- Upstream: https://github.com/highlightjs/highlight.js
- License: BSD 3-Clause, Copyright (c) 2006, Ivan Sagalaev (full text below)
- The file header keeps its original attribution.

### Rust crates

`native/vendor/` contains patched copies of three crates used by the native
addon. Each keeps its upstream MIT license text:

| Directory | Crate | License | Copyright |
|---|---|---|---|
| `native/vendor/wacore` | wacore 0.5.0 | MIT | Copyright (c) 2025 João Lucas de Oliveira Lopes |
| `native/vendor/wacore-noise` | wacore-noise 0.5.0 | MIT | Copyright (c) 2025 João Lucas de Oliveira Lopes |
| `native/vendor/whatsapp-rust` | whatsapp-rust 0.5.0 | MIT | Copyright (c) 2025 João Lucas de Oliveira Lopes |

The local changes are security and robustness fixes, each described in the
crate's `KLAUS-PATCH.md`.

## Icons

Icon path data derived from `@phosphor-icons/core` (MIT, Copyright (c) 2023
Phosphor Icons, https://github.com/phosphor-icons/core) is used by the frontend
icon library and by `tests/fixtures/official-plugins/digram/icons/`, which keeps
a copy of the license text.

## Test fixtures

The six Office documents in `tests/fixtures/team-draft/` are byte-for-byte
copies of test fixtures published in Apache Tika 3.2.3 (Apache License 2.0).
The upstream mapping is recorded in `tests/fixtures/team-draft/NOTICE`, with the
license text in `tests/fixtures/team-draft/LICENSE`.

`tests/fixtures/system-trust/` holds a deliberately public, self-signed
`localhost` certificate and key used only by an in-process HTTPS test.

## BSD 3-Clause License (highlight.js)

Copyright (c) 2006, Ivan Sagalaev.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
