// Merges the translated parts into src/lib/i18n/es-ui.json, keeping only
// entries whose {n} placeholders survived and that actually change the text.
import fs from "node:fs";
const out = {};
let bad = 0;
for (const f of fs.readdirSync("scripts/i18n/es").filter((f) => /^part-\d+\.json$/.test(f)).sort()) {
  const part = JSON.parse(fs.readFileSync(`scripts/i18n/es/${f}`, "utf8"));
  for (const [en, es] of Object.entries(part)) {
    if (typeof es !== "string" || !es.trim() || es === en) continue;
    const c = (s) => (s.match(/\{n\}/g) ?? []).length;
    if (c(en) !== c(es)) { bad++; continue; }
    out[en] = es;
    // "{n} job{n}" is `${n} job${n === 1 ? "" : "s"}`: on screen it reads
    // "1 job" or "41 jobs". Add both, the Spanish plural as -s / -es.
    const hole = /([A-Za-zÀ-ÿ])\{n\}/;
    if (hole.test(en) && hole.test(es)) {
      const one = (t) => t.replace(/([A-Za-zÀ-ÿ])\{n\}/g, "$1");
      const many = (t, spanish) =>
        t.replace(/([A-Za-zÀ-ÿ])\{n\}/g, (_, c) => c + (spanish && !/[aeiouáéíóú]/i.test(c) ? "es" : "s"));
      out[one(en)] ??= one(es);
      out[many(en, false)] ??= many(es, true);
    }
  }
}
const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
fs.writeFileSync("src/lib/i18n/es-ui.json", JSON.stringify(sorted, null, 1) + "\n");
console.log(Object.keys(sorted).length, "entries;", bad, "dropped for placeholder mismatch");
