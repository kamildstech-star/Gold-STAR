/**
 * The React side of `src/lib/label-language.ts` and `src/lib/i18n`: the
 * person's language, and the three ways a string honors it.
 *
 *   const { bi, t } = useLabelLanguage();
 *   bi("Close", "Cerrar")   -> "Close" | "Cerrar"      a label carrying its own Spanish
 *   t("Save")               -> "Save"  | "Guardar"     a string from the dictionary
 *   <T>Save</T>                                          the same, as JSX text
 *
 * One language on screen at a time — never "Close · Cerrar". A missing Spanish
 * falls back to the English silently. The preference is a TanStack Query
 * entry, so every string on screen reads the same cached value and a flip of
 * the top-bar switch changes all of them at once.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import {
  disableGoogleTranslate,
  enableGoogleTranslate,
  googleTranslateOn,
  startGoogleTranslate,
} from "@/lib/google-translate";
import { ES, translate, type Vars } from "@/lib/i18n";
import {
  LABEL_LANGUAGE_LABEL,
  LABEL_LANGUAGE_SCOPE,
  LABEL_LANGUAGE_SHORT,
  bi as biFor,
  parseLabelLanguage,
  resolveLabelLanguage,
  type LabelLanguage,
} from "@/lib/label-language";
import { cn } from "@/lib/utils";

const queryKey = (userId: string | null) => ["label-language", userId] as const;

async function loadStored(userId: string): Promise<LabelLanguage | null> {
  const { data, error } = await supabase
    .from("user_view_prefs")
    .select("view_mode")
    .eq("user_id", userId)
    .eq("scope", LABEL_LANGUAGE_SCOPE)
    .maybeSingle();
  // A preference nobody can load is the role default, not an outage.
  if (error) return null;
  return parseLabelLanguage(data?.view_mode);
}

export function useLabelLanguage(): {
  language: LabelLanguage;
  /** True while no explicit choice is stored and the role default applies. */
  isDefault: boolean;
  /** True in Español. */
  spanish: boolean;
  bi: (en: string, es: string | null | undefined) => string;
  t: (en: string, vars?: Vars) => string;
  /** Resolves once the choice is stored (or at once, signed out). */
  setLanguage: (next: LabelLanguage) => Promise<void>;
} {
  const { userId, primary } = useAppContext();
  const qc = useQueryClient();
  const stored = useQuery({
    queryKey: queryKey(userId),
    queryFn: () => loadStored(userId!),
    enabled: !!userId,
    staleTime: Infinity,
  });

  const language = resolveLabelLanguage(stored.data, primary);

  const setLanguage = React.useCallback(
    async (next: LabelLanguage) => {
      qc.setQueryData(queryKey(userId), next);
      if (!userId) return;
      await supabase
        .from("user_view_prefs")
        .upsert(
          {
            user_id: userId,
            scope: LABEL_LANGUAGE_SCOPE,
            view_mode: next,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,scope" },
        )
        .then(() => undefined);
    },
    [qc, userId],
  );

  const bi = React.useCallback(
    (en: string, es: string | null | undefined) => biFor(language, en, es),
    [language],
  );
  const t = React.useCallback(
    (en: string, vars?: Vars) => translate(language, en, vars),
    [language],
  );

  return {
    language,
    isDefault: stored.data == null,
    spanish: language === "es",
    bi,
    t,
    setLanguage,
  };
}

/** A label that carries its own Spanish, as JSX: `<Bi en="Day" es="Día" />`. */
export function Bi({ en, es }: { en: string; es: string | null | undefined }) {
  const { bi } = useLabelLanguage();
  return <>{bi(en, es)}</>;
}

/** A dictionary string as JSX text: `<T>Save</T>`. */
export function T({ children, vars }: { children: string; vars?: Vars }) {
  const { t } = useLabelLanguage();
  // JSX folds a wrapped line into single spaces; the key is the one-line text.
  return <>{t(children.replace(/\s+/g, " ").trim(), vars)}</>;
}

/**
 * English or Español, as the top bar and the user menu offer them (12 Nov).
 *
 * Español is Google Translate over the whole page, data included — the app's
 * own dictionary only ever covered the app's words. Google reads the page in
 * English, so choosing Español stores English as the app language first and
 * then turns Google on; English turns it off. Both reload the page, the one
 * reliable way to start or stop Google's translator.
 *
 * Someone still on the dictionary's Español (a role default) shows as
 * Español; pressing it moves them to Google.
 */
function useLanguageSwitch() {
  const { language, setLanguage } = useLabelLanguage();
  // Read after mount: the server has no cookie, and the first paint must match it.
  const [google, setGoogle] = React.useState(false);
  React.useEffect(() => {
    const on = googleTranslateOn(document.cookie);
    setGoogle(on);
    if (on) startGoogleTranslate();
  }, []);
  const chooseEnglish = React.useCallback(async () => {
    await setLanguage("en");
    if (googleTranslateOn(document.cookie)) disableGoogleTranslate();
  }, [setLanguage]);
  const chooseSpanish = React.useCallback(async () => {
    if (googleTranslateOn(document.cookie)) return;
    await setLanguage("en");
    enableGoogleTranslate();
  }, [setLanguage]);
  return { spanish: google || language === "es", chooseEnglish, chooseSpanish };
}

/**
 * The compact switch in the top bar: EN | ES. Visible on every screen,
 * desktop and phone; never translated itself.
 */
export function LanguageToggle({ className }: { className?: string }) {
  const { spanish, chooseEnglish, chooseSpanish } = useLanguageSwitch();
  const pill = (active: boolean) =>
    cn(
      "min-h-8 min-w-9 rounded-full px-2 text-[11.5px] font-semibold tracking-wide transition-colors",
      active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div
      role="group"
      aria-label={spanish ? "Idioma" : "Language"}
      data-testid="language-toggle"
      // Google must never translate the switch itself.
      translate="no"
      className={cn(
        "notranslate inline-flex shrink-0 rounded-full border bg-card p-0.5",
        className,
      )}
    >
      <button
        type="button"
        lang="en"
        onClick={() => void chooseEnglish()}
        aria-pressed={!spanish}
        aria-label={LABEL_LANGUAGE_LABEL.en}
        title={LABEL_LANGUAGE_LABEL.en}
        className={pill(!spanish)}
      >
        {LABEL_LANGUAGE_SHORT.en}
      </button>
      <button
        type="button"
        lang="es"
        onClick={() => void chooseSpanish()}
        aria-pressed={spanish}
        aria-label={LABEL_LANGUAGE_LABEL.es}
        title="Español — toda la página, traducida por Google"
        data-google-translate-toggle
        className={pill(spanish)}
      >
        {LABEL_LANGUAGE_SHORT.es}
      </button>
    </div>
  );
}

/**
 * The same switch in the user menu, spelled out: "English | Español". The
 * note under it says when the choice is still the role's default.
 */
export function LabelLanguageChoice() {
  const { isDefault, t } = useLabelLanguage();
  const { spanish, chooseEnglish, chooseSpanish } = useLanguageSwitch();
  const option = (active: boolean) =>
    cn(
      "rounded-[4px] px-1.5 py-1 text-[11px] font-medium transition-colors",
      active
        ? "bg-background text-foreground shadow-[0_0_0_1px_var(--border)]"
        : "text-muted-foreground hover:text-foreground",
    );
  return (
    <div className="space-y-1">
      <div
        className="notranslate grid grid-cols-2 gap-1 rounded-[6px] border border-border bg-muted/40 p-0.5"
        translate="no"
        data-language-choice
      >
        <button
          type="button"
          lang="en"
          onClick={() => void chooseEnglish()}
          aria-pressed={!spanish}
          className={option(!spanish)}
        >
          {LABEL_LANGUAGE_LABEL.en}
        </button>
        <button
          type="button"
          lang="es"
          onClick={() => void chooseSpanish()}
          aria-pressed={spanish}
          className={option(spanish)}
        >
          {LABEL_LANGUAGE_LABEL.es}
        </button>
      </div>
      {isDefault && (
        <p className="text-[10px] text-muted-foreground">{t("The default for your role.")}</p>
      )}
    </div>
  );
}

/**
 * Español on every screen, not only the ones wrapped in `t()`: while the
 * person reads Spanish, the reviewed dictionary (`src/lib/i18n/es-ui.json`,
 * built from the app's own source) swaps the English on screen. Loaded only
 * for Spanish readers. See `src/lib/i18n/dom-translate.ts`.
 */
export function SpanishScreen() {
  const { spanish } = useLabelLanguage();
  React.useEffect(() => {
    if (!spanish || typeof document === "undefined") return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void Promise.all([import("@/lib/i18n/es-ui.json"), import("@/lib/i18n/dom-translate")]).then(
      ([ui, dom]) => {
        if (cancelled) return;
        const dict = new Map<string, string>(Object.entries(ui.default as Record<string, string>));
        for (const [en, es] of Object.entries(ES)) dict.set(en, es);
        document.documentElement.lang = "es";
        stop = dom.startDomTranslator(document.body, dict);
      },
    );
    return () => {
      cancelled = true;
      stop?.();
      document.documentElement.lang = "en";
    };
  }, [spanish]);
  return null;
}
