# The Spanish screen

`src/lib/i18n/es-ui.json` is the app's on-screen Spanish, built from the source.

1. `node scripts/i18n/extract.mjs` — every piece of on-screen English in `src/` → `scripts/i18n/strings.json`.
2. `npx tsx -e 'import {ES} from "./src/lib/i18n/index.ts"; require("fs").writeFileSync("scripts/i18n/existing.json", JSON.stringify(ES))'`, then `node scripts/i18n/split.mjs 12` — the strings not yet translated, in parts.
3. Translate each part into `scripts/i18n/es/part-NN.json` (`{"English": "Spanish"}`, `{n}` kept). `part-00.json` is hand-written.
4. `node scripts/i18n/merge.mjs` — all parts → `src/lib/i18n/es-ui.json`.

New screens: run 1, translate only the new strings into a new part, run 4.
