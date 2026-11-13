/**
 * The app's UI dictionary — English to Español, keyed by the English string.
 *
 * Keyed by the English rather than by invented ids, so a screen is translated
 * by wrapping the text it already shows — `t("Save")` — and a string nobody
 * has translated yet still reads correctly: `translate()` falls back to the
 * English, silently, never a blank and never a key.
 *
 * Split by area so each part of the app can be reviewed by the people who use
 * it: the crew's screens, the office's, and the shell around both. Professional
 * US-Latino Spanish with the restoration trade's own words (mitigación,
 * deshumidificador, hoja de registro).
 *
 * LABELS AND UI TEXT ONLY. Never data — names, addresses, notes, catalog item
 * names, report content — and never the documents sent to clients: bills,
 * reports and PDFs stay English (the work-order translation feature in
 * `src/lib/translations.ts` is a separate, stored-translation system and is
 * untouched). No machine translation at runtime, anywhere.
 *
 * Placeholders: a key may carry `{name}` slots, filled from `vars` in both
 * languages — `t("{n} people", { n: 3 })`.
 */
import { CREW_ES } from "./es-crew";
import { OFFICE_ES } from "./es-office";
import { SHELL_ES } from "./es-shell";
import type { LabelLanguage } from "@/lib/label-language";

export const ES: Readonly<Record<string, string>> = {
  ...SHELL_ES,
  ...OFFICE_ES,
  ...CREW_ES,
};

export type Vars = Record<string, string | number>;

function fill(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** `en` in the person's language, with any `{slots}` filled. */
export function translate(language: LabelLanguage, en: string, vars?: Vars): string {
  const text = language === "es" ? (ES[en] ?? en) : en;
  return fill(text, vars);
}

/** Every key with a Spanish entry — for the dictionary's own tests. */
export function dictionarySize(): number {
  return Object.keys(ES).length;
}
