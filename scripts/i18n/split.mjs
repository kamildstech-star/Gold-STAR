// Drops what is clearly not prose and splits the rest into parts for translation.
import fs from "node:fs";
const ES = JSON.parse(fs.readFileSync("scripts/i18n/existing.json", "utf8"));
const all = JSON.parse(fs.readFileSync("scripts/i18n/strings.json", "utf8"));
const keep = all.filter((s) => {
  if (/^[\w*]+(\s*,\s*[\w*.()!:>-]+)+$/.test(s)) return false; // column lists
  if (/^[\w.]+\([^)]*\)$/.test(s)) return false;
  if (/^[A-Z][a-zA-Z]+$/.test(s) && /[a-z][A-Z]/.test(s)) return false; // ComponentNames
  if (/^[a-z_]+(\.[a-z_]+)+$/.test(s)) return false;
  if (/^\w+:\w+/.test(s) && !/\s/.test(s)) return false;
  if (ES[s]) return false;
  return true;
});
const N = Number(process.argv[2] ?? 12);
const size = Math.ceil(keep.length / N);
fs.mkdirSync("scripts/i18n/parts", { recursive: true });
fs.mkdirSync("scripts/i18n/es", { recursive: true });
for (let i = 0; i < N; i++) {
  fs.writeFileSync(`scripts/i18n/parts/part-${String(i + 1).padStart(2, "0")}.json`, JSON.stringify(keep.slice(i * size, (i + 1) * size), null, 0).replace(/","/g, '",\n"'));
}
console.log(keep.length, "kept of", all.length, "→", N, "parts of", size);
