import * as React from "react";
import { Columns3, LayoutGrid, List, type LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Segmented view switcher — the small icon group that sits beside Filters and
 * decides how a worksheet renders (cards, table, board…).
 *
 * Deliberately generic: it knows nothing about the page it sits on. A screen
 * supplies its own option list and its own storage key, so Active Clients,
 * Pipeline and anything after them share one control and one behaviour.
 *
 * The chosen view is both remembered per user (localStorage) and reflected in
 * the URL, so a pasted link opens on the view the sender was looking at while
 * a returning user still lands on their own habit.
 */

export type ViewOption<K extends string = string> = {
  /** Stored in localStorage and in the URL — keep these stable. */
  key: K;
  /** Visible name, used as the tooltip title and the accessible label. */
  label: string;
  icon: LucideIcon;
  /** Optional second line in the tooltip: what the view is good for. */
  hint?: string;
};

/** Cards · List · Kanban — the trio most worksheets want. */
export type StandardViewKey = "cards" | "list" | "kanban";

export const STANDARD_VIEW_OPTIONS: readonly ViewOption<StandardViewKey>[] = [
  { key: "cards", label: "Cards", icon: LayoutGrid, hint: "Grid of account cards" },
  { key: "list", label: "List", icon: List, hint: "Dense table" },
  { key: "kanban", label: "Kanban", icon: Columns3, hint: "Board grouped by stage" },
];

export const STANDARD_VIEW_KEYS: readonly StandardViewKey[] = ["cards", "list", "kanban"];

export function ViewSwitcher<K extends string>({
  value,
  onChange,
  options,
  className,
  label = "Change view",
}: {
  value: K;
  onChange: (next: K) => void;
  options: readonly ViewOption<K>[];
  className?: string;
  /** Accessible name for the group. */
  label?: string;
}) {
  return (
    <TooltipProvider delayDuration={250}>
      <div
        role="group"
        aria-label={label}
        className={cn(
          "inline-flex h-10 items-center gap-0.5 rounded-lg border border-[var(--border)] bg-card p-0.5",
          className,
        )}
      >
        {options.map((opt) => {
          const Icon = opt.icon;
          const active = opt.key === value;
          return (
            <Tooltip key={opt.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${opt.label} view`}
                  aria-pressed={active}
                  onClick={() => onChange(opt.key)}
                  className={cn(
                    "inline-flex h-8 w-8 items-center justify-center rounded-md transition-colors",
                    active
                      ? "bg-[var(--accent)] text-[var(--primary)]"
                      : "text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span className="font-semibold">{opt.label}</span>
                {opt.hint ? <span className="opacity-80"> · {opt.hint}</span> : null}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------ persistence */

function readSaved(storageKey: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

function writeSaved(storageKey: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey, value);
  } catch {
    /* private mode / quota — the URL still carries the choice */
  }
}

/**
 * View state with the two-layer memory the switcher promises.
 *
 * Precedence: a valid view in the URL always wins (that is what makes a link
 * shareable), otherwise the user's saved preference is applied on mount and
 * pushed back into the URL, otherwise `fallback`.
 *
 * The route owns its own search params, so it passes the current value in and
 * gets a callback when the view changes — this hook never navigates itself.
 * First render deliberately renders `urlValue ?? fallback` so SSR and the
 * client agree; the saved preference is applied in an effect.
 */
export function useViewPreference<K extends string>({
  storageKey,
  options,
  fallback,
  urlValue,
  onUrlChange,
}: {
  storageKey: string;
  options: readonly K[];
  fallback: K;
  /** Current value of the route's view search param, if any. */
  urlValue?: string | null;
  /** Called with every new view so the route can write it to the URL. */
  onUrlChange?: (next: K) => void;
}): [K, (next: K) => void] {
  const isKey = React.useCallback(
    (v: unknown): v is K => typeof v === "string" && (options as readonly string[]).includes(v),
    [options],
  );

  const [view, setView] = React.useState<K>(() => (isKey(urlValue) ? urlValue : fallback));

  // Keep callbacks out of effect deps — routes pass fresh closures every render.
  const urlChangeRef = React.useRef(onUrlChange);
  urlChangeRef.current = onUrlChange;

  // Back/forward, or a link opened into an already-mounted route.
  React.useEffect(() => {
    if (isKey(urlValue)) setView((cur) => (cur === urlValue ? cur : urlValue));
  }, [urlValue, isKey]);

  // Once, on mount: with nothing in the URL, honour what this user last chose.
  const hydrated = React.useRef(false);
  React.useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    if (isKey(urlValue)) return;
    const saved = readSaved(storageKey);
    if (!isKey(saved) || saved === fallback) return;
    setView(saved);
    urlChangeRef.current?.(saved);
  }, [storageKey, fallback, urlValue, isKey]);

  const choose = React.useCallback(
    (next: K) => {
      setView(next);
      writeSaved(storageKey, next);
      urlChangeRef.current?.(next);
    },
    [storageKey],
  );

  return [view, choose];
}

/** Reduced-motion flag — drag/reflow animations must be switchable off. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
