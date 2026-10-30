# Official plugin fixtures

Minimal, self-authored stand-ins for official plugin packages. Host tests use them to exercise installation, skill provenance and host-managed services without the published packages. `digram/icons/index.json` is generated with `node apps/desktop/scripts/generate-digram-icons.mjs --out tests/fixtures/official-plugins/digram/icons/index.json --only cpu,database,cloud,globe,user,lock,gear,file` from `@phosphor-icons/core` (MIT, notice in `digram/icons/PHOSPHOR-LICENSE`).
