import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Eye, EyeOff, RotateCcw } from "lucide-react";

import { useRouterState } from "@tanstack/react-router";

import { supabase } from "@/integrations/supabase/client";
import { loadOrgDefault } from "./org-layouts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Universal per-user hide control.
 *
 * Any card, panel, section or sidebar item can be collapsed away by the person
 * looking at it. Stored per user in `user_view_prefs` (scope
 * `hidden_sections`) the same way the dashboard layout is, so it follows them
 * between devices and is never global.
 *
 * Role-gating always wins: this only hides things the user was already allowed
 * to see. Nothing here can reveal a section the role never rendered — a hidden
 * key for something they can no longer see simply does nothing.
 */

const SCOPE = "hidden_sections";

/** page key -> hidden section keys on that page */
type HiddenMap = Record<string, string[]>;

type Ctx = {
  ready: boolean;
  isHidden: (page: string, key: string) => boolean;
  hide: (page: string, key: string) => void;
  show: (page: string, key: string) => void;
  hiddenKeys: (page: string) => string[];
  showAll: (page: string) => void;
  /** Clears every page back to the default (nothing hidden). */
  resetAll: () => void;
};

const HiddenContext = createContext<Ctx>({
  ready: true,
  isHidden: () => false,
  hide: () => {},
  show: () => {},
  hiddenKeys: () => [],
  showAll: () => {},
  resetAll: () => {},
});

export function useHiddenSections() {
  return useContext(HiddenContext);
}

export function HiddenSectionsProvider({
  userId,
  roles = [],
  /** Role preview / impersonation shows defaults and never writes. */
  persistEnabled = true,
  children,
}: {
  userId: string | null | undefined;
  roles?: readonly string[];
  persistEnabled?: boolean;
  children: ReactNode;
}) {
  const [map, setMap] = useState<HiddenMap>({});
  const [ready, setReady] = useState(false);
  const roleKey = roles.join(",");

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setMap({});
      setReady(true);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from("user_view_prefs")
        .select("view_mode")
        .eq("user_id", userId)
        .eq("scope", SCOPE)
        .maybeSingle();
      if (cancelled) return;
      if (data?.view_mode) {
        setMap(parseMap(data.view_mode));
      } else {
        // Never customised → the admin's published default for their role.
        const published = await loadOrgDefault<HiddenMap>(
          "sections",
          roleKey ? roleKey.split(",") : [],
        );
        if (cancelled) return;
        setMap(
          published?.payload && typeof published.payload === "object" ? published.payload : {},
        );
      }
      setReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, roleKey]);

  const persist = useCallback(
    (next: HiddenMap) => {
      setMap(next);
      if (!userId || !persistEnabled) return;
      void supabase.from("user_view_prefs").upsert(
        {
          user_id: userId,
          scope: SCOPE,
          view_mode: JSON.stringify(next),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,scope" },
      );
    },
    [userId, persistEnabled],
  );

  const value = useMemo<Ctx>(
    () => ({
      ready,
      isHidden: (page, key) => (map[page] ?? []).includes(key),
      hiddenKeys: (page) => map[page] ?? [],
      hide: (page, key) => {
        const cur = map[page] ?? [];
        if (cur.includes(key)) return;
        persist({ ...map, [page]: [...cur, key] });
      },
      show: (page, key) => {
        const cur = map[page] ?? [];
        if (!cur.includes(key)) return;
        persist({ ...map, [page]: cur.filter((k) => k !== key) });
      },
      showAll: (page) => {
        if (!(map[page] ?? []).length) return;
        const next = { ...map };
        delete next[page];
        persist(next);
      },
      resetAll: () => {
        // Reset restores the organisation default, not the built-in empty map.
        if (userId && persistEnabled) {
          void supabase.from("user_view_prefs").delete().eq("user_id", userId).eq("scope", SCOPE);
        }
        void loadOrgDefault<HiddenMap>("sections", roleKey ? roleKey.split(",") : []).then((p) =>
          setMap(p?.payload && typeof p.payload === "object" ? p.payload : {}),
        );
      },
    }),
    [map, persist, ready, roleKey, userId, persistEnabled],
  );

  return <HiddenContext.Provider value={value}>{children}</HiddenContext.Provider>;
}

function parseMap(raw: unknown): HiddenMap {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as HiddenMap;
    if (!parsed || typeof parsed !== "object") return {};
    const out: HiddenMap = {};
    for (const [page, keys] of Object.entries(parsed)) {
      if (Array.isArray(keys)) out[page] = keys.filter((k) => typeof k === "string");
    }
    return out;
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* Page scope                                                          */
/* ------------------------------------------------------------------ */

const PageContext = createContext<string | null>(null);

/** Wrap a page so its sections share one hide namespace. */
export function HideablePage({ pageKey, children }: { pageKey: string; children: ReactNode }) {
  return <PageContext.Provider value={pageKey}>{children}</PageContext.Provider>;
}

/**
 * Sections are namespaced per page. Explicit `pageKey` wins, then an enclosing
 * <HideablePage>, then the current route path — so every page gets its own
 * hide list without any wiring.
 */
function usePageKey(explicit?: string): string {
  const ctx = useContext(PageContext);
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  return explicit ?? ctx ?? pathname;
}

/**
 * Titles for hidden keys, registered by the sections themselves so the
 * "Hidden (n)" control can name what it is offering to bring back.
 */
const labels = new Map<string, string>();
const labelKey = (page: string, key: string) => `${page}::${key}`;

export function registerSectionLabel(page: string, key: string, label: string) {
  labels.set(labelKey(page, key), label);
}

export function sectionLabel(page: string, key: string): string {
  return labels.get(labelKey(page, key)) ?? key;
}

/* ------------------------------------------------------------------ */
/* Section wrapper                                                     */
/* ------------------------------------------------------------------ */

/**
 * Wraps any card/panel/section. The eye appears on hover in the top-right
 * corner; clicking it collapses the whole thing away for this user only.
 */
export function HideableSection({
  sectionKey,
  label,
  pageKey,
  className,
  children,
}: {
  sectionKey: string;
  /** Human name used by the "Hidden (n)" list. */
  label: string;
  pageKey?: string;
  className?: string;
  children: ReactNode;
}) {
  const page = usePageKey(pageKey);
  const { isHidden, hide } = useHiddenSections();

  useEffect(() => {
    registerSectionLabel(page, sectionKey, label);
  }, [page, sectionKey, label]);

  if (isHidden(page, sectionKey)) return null;

  return (
    <div className={cn("group/hideable relative min-w-0", className)}>
      <button
        type="button"
        aria-label={`Hide ${label}`}
        title={`Hide ${label}`}
        onClick={() => hide(page, sectionKey)}
        className="absolute right-1.5 top-1.5 z-20 hidden rounded-md border border-border/60 bg-background/90 p-1 text-muted-foreground shadow-sm backdrop-blur transition hover:text-foreground focus-visible:block group-hover/hideable:block"
      >
        <EyeOff className="size-3.5" aria-hidden />
      </button>
      {children}
    </div>
  );
}

/** Menu-item form of the same control, for a section's overflow menu. */
export function useHideAction(sectionKey: string, label: string, pageKey?: string) {
  const page = usePageKey(pageKey);
  const { hide, isHidden } = useHiddenSections();
  useEffect(() => {
    registerSectionLabel(page, sectionKey, label);
  }, [page, sectionKey, label]);
  return {
    hidden: isHidden(page, sectionKey),
    hide: () => hide(page, sectionKey),
  };
}

/* ------------------------------------------------------------------ */
/* "Hidden (n) — show all"                                             */
/* ------------------------------------------------------------------ */

export function HiddenSectionsBar({
  pageKey,
  className,
}: {
  pageKey?: string;
  className?: string;
}) {
  const page = usePageKey(pageKey);
  const { hiddenKeys, show, showAll } = useHiddenSections();
  const keys = hiddenKeys(page);
  if (keys.length === 0) return null;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <Eye className="size-3.5" aria-hidden />
      <span>Hidden ({keys.length})</span>
      {keys.map((k) => (
        <Button
          key={k}
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => show(page, k)}
        >
          {sectionLabel(page, k)}
        </Button>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="ml-auto h-6 gap-1 px-2 text-xs"
        onClick={() => showAll(page)}
      >
        <RotateCcw className="size-3" aria-hidden />
        Show all
      </Button>
    </div>
  );
}
