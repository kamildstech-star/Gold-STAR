import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { supabase } from "@/integrations/supabase/client";

/**
 * Theme follows the operating system by default. A person can override it from
 * the user menu, and that choice is remembered for them on every device —
 * localStorage keeps the next paint honest, the row in `user_view_prefs`
 * carries it across machines.
 */
export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "rh-theme";
const THEME_SCOPE = "theme";

/** Colour palettes. Only chrome changes — loss and status colours are fixed. */
export type Palette = "goldstar" | "slate" | "warm" | "contrast" | "cool";

export const PALETTE_STORAGE_KEY = "rh-palette";
const PALETTE_SCOPE = "palette";

export const PALETTES: { value: Palette; label: string; description: string; swatch: string[] }[] =
  [
    {
      value: "slate",
      label: "Slate",
      description: "Neutral grays, one blue accent. Restrained.",
      swatch: ["var(--card)", "#f6f6f7", "#e6e7e9", "#3358d4"],
    },
    {
      value: "goldstar",
      label: "Gold Star",
      description: "The current navy and gold brand palette.",
      swatch: ["var(--card)", "#f7f8f9", "#10243d", "#b8a030"],
    },
    {
      value: "warm",
      label: "Warm",
      description: "Off-white grounds, charcoal text, muted terracotta.",
      swatch: ["#fbf8f4", "#f3ede5", "#e6ded3", "#a8543a"],
    },
    {
      value: "contrast",
      label: "Contrast",
      description: "Near-white and near-black, heavy borders.",
      swatch: ["var(--card)", "#f2f2f2", "#b8bcc2", "#0b57d0"],
    },
    {
      value: "cool",
      label: "Cool",
      description: "Soft blue-grey surfaces, deeper blue accent.",
      swatch: ["var(--surface)", "#eef2f6", "#dde5ec", "#24557f"],
    },
  ];

function isPalette(v: unknown): v is Palette {
  return PALETTES.some((p) => p.value === v);
}

function applyPalette(p: Palette) {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-palette", p);
}

export const THEME_LABEL: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

function isTheme(v: unknown): v is Theme {
  return v === "light" || v === "dark" || v === "system";
}

function prefersDark(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(theme: Theme) {
  if (typeof document === "undefined") return;
  const dark = theme === "dark" || (theme === "system" && prefersDark());
  // Only the class is toggled — `color-scheme` lives in CSS so the server
  // and client markup stay identical and React does not warn on hydration.
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Runs before hydration so the first paint is already in the right theme.
 * Kept as a string because it has to be inlined into the document head.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})||"system";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);var p=localStorage.getItem(${JSON.stringify(
  PALETTE_STORAGE_KEY,
)})||"goldstar";document.documentElement.setAttribute("data-palette",p);}catch(e){}})();`;

type Ctx = {
  theme: Theme;
  /** What is actually on screen right now. */
  resolved: "light" | "dark";
  setTheme: (t: Theme) => void;
  palette: Palette;
  setPalette: (p: Palette) => void;
};

const ThemeContext = createContext<Ctx>({
  theme: "system",
  resolved: "light",
  setTheme: () => {},
  palette: "goldstar",
  setPalette: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolved, setResolved] = useState<"light" | "dark">("light");
  const [palette, setPaletteState] = useState<Palette>("goldstar");

  // Adopt whatever the pre-hydration script already decided.
  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const initial: Theme = isTheme(stored) ? stored : "system";
    setThemeState(initial);
    apply(initial);
    setResolved(document.documentElement.classList.contains("dark") ? "dark" : "light");
    const storedPalette = localStorage.getItem(PALETTE_STORAGE_KEY);
    const initialPalette: Palette = isPalette(storedPalette) ? storedPalette : "goldstar";
    setPaletteState(initialPalette);
    applyPalette(initialPalette);
  }, []);

  // Follow the OS while on "system".
  useEffect(() => {
    apply(theme);
    setResolved(theme === "dark" || (theme === "system" && prefersDark()) ? "dark" : "light");
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      apply("system");
      setResolved(mq.matches ? "dark" : "light");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // Their saved choice wins once we know who they are.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: sessionRes } = await supabase.auth.getSession();
      const uid = sessionRes.session?.user.id;
      if (!uid) return;
      const { data } = await supabase
        .from("user_view_prefs")
        .select("scope, view_mode")
        .eq("user_id", uid)
        .in("scope", [THEME_SCOPE, PALETTE_SCOPE]);
      if (cancelled) return;
      const saved = data?.find((r) => r.scope === THEME_SCOPE)?.view_mode;
      if (isTheme(saved)) {
        localStorage.setItem(THEME_STORAGE_KEY, saved);
        setThemeState(saved);
      }
      const savedPalette = data?.find((r) => r.scope === PALETTE_SCOPE)?.view_mode;
      if (isPalette(savedPalette)) {
        localStorage.setItem(PALETTE_STORAGE_KEY, savedPalette);
        setPaletteState(savedPalette);
        applyPalette(savedPalette);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode — the DB row still carries it */
    }
    apply(next);
    void (async () => {
      const { data: sessionRes } = await supabase.auth.getSession();
      const uid = sessionRes.session?.user.id;
      if (!uid) return;
      await supabase.from("user_view_prefs").upsert(
        {
          user_id: uid,
          scope: THEME_SCOPE,
          view_mode: next,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,scope" },
      );
    })();
  }, []);

  const setPalette = useCallback((next: Palette) => {
    setPaletteState(next);
    try {
      localStorage.setItem(PALETTE_STORAGE_KEY, next);
    } catch {
      /* private mode — the DB row still carries it */
    }
    applyPalette(next);
    void (async () => {
      const { data: sessionRes } = await supabase.auth.getSession();
      const uid = sessionRes.session?.user.id;
      if (!uid) return;
      await supabase.from("user_view_prefs").upsert(
        {
          user_id: uid,
          scope: PALETTE_SCOPE,
          view_mode: next,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,scope" },
      );
    })();
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme, palette, setPalette }}>
      {children}
    </ThemeContext.Provider>
  );
}
