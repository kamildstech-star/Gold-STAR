/**
 * Which language the app speaks to a person: English or Español — one at a
 * time, never both stacked.
 *
 * History. The field labels started bilingual on purpose: the paper field
 * form is bilingual and the crews are Spanish-speaking, so the ticket, the
 * scan dialogs and the drying card said everything twice ("Close · Cerrar").
 * David, 24 Sep, seeing those cards from the office: "I don't know if I like
 * all the Spanish." That made it a per-person setting with two values —
 * English only, or English + Español. BC-LANG-1 replaces the second with a
 * true switch: a Spanish speaker sees Spanish, an English speaker sees
 * English, and nobody reads every label twice.
 *
 * The default still follows the role: crew and field technicians — the people
 * reading the paper form — get Español; everyone else gets English until they
 * flip the switch in the top bar.
 *
 * Stored per person in `user_view_prefs` (scope below), the table every other
 * view preference uses — see `card-density.ts`. No row means "the default for
 * my role". The old stored value `en_es` ("English + Español") is read as
 * Español — those people asked to see the Spanish — and a migration rewrites
 * it; it is accepted here forever but never offered.
 *
 * This file is the ONE mechanism. Every translated string goes through `bi()`
 * (a label that carries its own Spanish), `t()` (a string looked up in the
 * dictionary, `src/lib/i18n`), or their React forms in
 * `src/components/bilingual.tsx` — never through its own check.
 */
import type { AppRole } from "@/lib/roles";

export const LABEL_LANGUAGES = ["en", "es"] as const;
export type LabelLanguage = (typeof LABEL_LANGUAGES)[number];

export const LABEL_LANGUAGE_SCOPE = "field_label_language";

/** The pre-BC-LANG-1 "English + Español" value. Read as Español; never offered. */
export const LEGACY_BILINGUAL = "en_es";

/** Each language named in itself — a Spanish speaker looks for "Español". */
export const LABEL_LANGUAGE_LABEL: Record<LabelLanguage, string> = {
  en: "English",
  es: "Español",
};

/** The short form the top-bar toggle shows. */
export const LABEL_LANGUAGE_SHORT: Record<LabelLanguage, string> = {
  en: "EN",
  es: "ES",
};

/** The roles whose day is the paper form and the scan dialog. */
export const SPANISH_DEFAULT_ROLES: readonly AppRole[] = ["crew", "field"];

/**
 * The default for a person's PRIMARY role. Someone who is both an admin and on
 * a crew is looked at as the admin — the primary role is the one the app is
 * already arranged around for them — and can switch in one tap.
 */
export function defaultLabelLanguage(primary: AppRole | null | undefined): LabelLanguage {
  return primary && SPANISH_DEFAULT_ROLES.includes(primary) ? "es" : "en";
}

/** A stored value, or null when there is none worth honoring. */
export function parseLabelLanguage(raw: string | null | undefined): LabelLanguage | null {
  if (raw === LEGACY_BILINGUAL) return "es";
  return (LABEL_LANGUAGES as readonly string[]).includes(raw ?? "") ? (raw as LabelLanguage) : null;
}

export function resolveLabelLanguage(
  stored: string | null | undefined,
  primary: AppRole | null | undefined,
): LabelLanguage {
  return parseLabelLanguage(stored) ?? defaultLabelLanguage(primary);
}

/**
 * One label in the chosen language. A missing or empty Spanish falls back to
 * the English silently — never a blank, never a key.
 */
export function bi(language: LabelLanguage, en: string, es: string | null | undefined): string {
  return language === "es" && es ? es : en;
}
