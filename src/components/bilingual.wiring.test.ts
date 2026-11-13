import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The field-facing screens that carry Spanish. Each must route it through the
 * one mechanism (`bi()` / `<Bi>` from bilingual.tsx) — a hard-coded
 * "English · Español" string would ignore the person's setting.
 */
const FILES = [
  "src/components/field-work-ticket-panel.tsx",
  "src/components/equipment-panel.tsx",
  "src/components/drying-clock-card.tsx",
  "src/components/asset-tag-scanner.tsx",
  // Heshy's checklist drawers and the hour-meter box, 2026-09-28.
  "src/components/job-drying-log.tsx",
  "src/components/drying-dehu-readings.tsx",
  "src/components/drying-material-points.tsx",
  "src/components/hour-meter-field.tsx",
  // The T&M daily sheets, 2026-10-07.
  "src/components/tm-field-forms-panel.tsx",
  "src/components/tm-form-editors.tsx",
];

// Words that only ever appear in the Spanish half of these labels.
const SPANISH =
  /\b(Deshumidificadores|Horómetro|Humedad|Tablaroca|Escanear|Instalar|Retirar|Cerrar|Guardar|Guardado|Papel|Habitación|Secado|Reiniciar|Estado|Presione|anotado|señal|partes?|Placas|Ninguno|Según|Igual|Toda|Fecha|Por qué)\b/;

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("bilingual labels follow the per-user setting", () => {
  for (const file of FILES) {
    it(`${file} has no hard-coded "English · Español" label`, () => {
      const src = read(file);
      // Every string literal, template literal and run of JSX text that joins
      // two halves with the middle dot.
      const joined = [
        ...src.matchAll(/"[^"\n]* · [^"\n]*"/g),
        ...src.matchAll(/`[^`\n]* · [^`\n]*`/g),
        ...src.matchAll(/>\s*[^<>{}\n]* · [^<>{}\n]*\s*</g),
      ].map((m) => m[0]);
      const offenders = joined.filter((t) => SPANISH.test(t) && !/^>\s*·/.test(t));
      expect(offenders).toEqual([]);
    });

    it(`${file} reads the setting through the shared hook`, () => {
      expect(read(file).match(/from "@\/components\/bilingual"/)).not.toBeNull();
    });
  }

  it("no screen stacks a Spanish line under an English one any more", () => {
    // BC-LANG-1: one language at a time. The old <Es> line rendered the
    // Spanish beneath the English; every such label is now a single <Bi>.
    for (const file of FILES) expect(read(file)).not.toMatch(/<Es[\s>]/);
    const lib = read("src/components/bilingual.tsx");
    expect(lib).not.toMatch(/export function Es\b/);
    expect(lib).toMatch(/export function Bi\b/);
  });

  it("the ticket's labels render through <Bi>, one language at a time", () => {
    const label2 = read(FILES[0]).match(/function Label2[\s\S]*?\n}\n/);
    expect(label2![0]).toContain("<Bi en={en} es={es} />");
  });

  it("the switch sits in the top bar, beside the notifications", () => {
    const shell = read("src/components/app-shell.tsx");
    const topBar = shell.match(/function TopBar[\s\S]*?\n}\n/);
    expect(topBar![0]).toContain("<LanguageToggle />");
  });

  it("the switch also lives in the user menu, as Language: English | Español", () => {
    const shell = read("src/components/app-shell.tsx");
    expect(shell.match(/<LabelLanguageChoice \/>/)).not.toBeNull();
  });
});
