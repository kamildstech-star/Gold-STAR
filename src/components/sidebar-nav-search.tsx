import { Link, useNavigate } from "@tanstack/react-router";
import { Search, Settings2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

import type { SettingsPage } from "@/lib/admin-settings";
import {
  filterNavGroups,
  filterSettingsPages,
  highlightParts,
  type SearchableNavGroup,
  type SearchableNavItem,
} from "@/lib/sidebar-search";
import { cn } from "@/lib/utils";

export type SidebarSearchItem = SearchableNavItem & { icon: ElementType };

type Result = { to: string; label: string; icon: ElementType; title?: string };
type ResultGroup = { key: string; label: string; results: Result[] };

function optionIdFor(uid: string, i: number): string {
  return `${uid}-opt-${i}`;
}

/** Is the key press aimed at something the person is typing into? */
function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {highlightParts(text, query).map((p, i) =>
        p.match ? (
          <mark
            key={i}
            data-match=""
            className="rounded-[2px] bg-transparent font-semibold text-[var(--sidebar-gold)]"
          >
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * "Search menu…" at the top of the sidebar (Mark: "needs to be a search").
 *
 * While the box is empty it renders `children` — the ordinary, draggable,
 * collapsible menu — untouched. Once something is typed it swaps them for a
 * flat result list: every group with a match, opened, matched letters drawn
 * in gold, and settings pages underneath when the person can reach settings.
 * Folded groups stay folded in the real menu; the result list never writes to
 * that state, so clearing the box puts everything back exactly as it was.
 *
 * `groups` must be the list the sidebar is already drawing, so search can
 * only ever narrow what the person can see. Nothing is persisted.
 *
 * Keys: "/" (when not already typing somewhere) focuses the box; ArrowUp and
 * ArrowDown move through results; Enter opens one; Esc clears. Cmd/Ctrl+K is
 * left to the header's company search.
 */
export function SidebarNavSearch({
  groups,
  settingsPages = [],
  isActive,
  collapsed = false,
  onExpand,
  onNavigate,
  children,
}: {
  groups: readonly SearchableNavGroup<SidebarSearchItem>[];
  /** Openable settings pages, or empty when the person has no way into settings. */
  settingsPages?: readonly SettingsPage[];
  isActive?: (to: string) => boolean;
  /** The sidebar is the icon rail: show a search button instead of the box. */
  collapsed?: boolean;
  /** Open the rail out to full width (desktop) or the sheet (phone). */
  onExpand?: () => void;
  /** Called after a result is opened, e.g. to dismiss the phone sheet. */
  onNavigate?: () => void;
  children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusAfterExpand = useRef(false);
  const navigate = useNavigate();
  const uid = useId();
  const listId = `${uid}-results`;
  const optionId = (i: number) => optionIdFor(uid, i);

  // A new query starts the highlight on the first result again.
  const changeQuery = (next: string) => {
    setQuery(next);
    setActive(0);
  };

  const searching = !collapsed && query.trim().length > 0;

  const resultGroups = useMemo<ResultGroup[]>(() => {
    if (!searching) return [];
    const nav = filterNavGroups(groups, query).map((g) => ({
      key: g.key,
      label: g.label,
      results: g.items.map((i) => ({ to: i.to, label: i.label, icon: i.icon })),
    }));
    const listed = new Set(groups.flatMap((g) => g.items.map((i) => i.to)));
    const settings = filterSettingsPages(query, settingsPages, listed).map((p) => ({
      to: p.path,
      label: p.label,
      icon: Settings2,
      title: p.description,
    }));
    return settings.length
      ? [...nav, { key: "__settings", label: "Settings", results: settings }]
      : nav;
  }, [searching, groups, settingsPages, query]);

  const flat = useMemo(() => resultGroups.flatMap((g) => g.results), [resultGroups]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!searching) return;
    const el = document.getElementById(optionIdFor(uid, active));
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active, searching, uid]);

  // "/" asked for the box while the rail was folded: focus once it is drawn.
  useEffect(() => {
    if (!collapsed && focusAfterExpand.current) {
      focusAfterExpand.current = false;
      inputRef.current?.focus();
    }
  }, [collapsed]);

  const openSearch = useCallback(() => {
    if (collapsed) {
      focusAfterExpand.current = true;
      onExpand?.();
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [collapsed, onExpand]);

  // "/" from anywhere that is not a text field, and not while a dialog owns focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (document.querySelector('[role="dialog"][data-state="open"], [aria-modal="true"]')) return;
      e.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSearch]);

  const finish = () => {
    changeQuery("");
    onNavigate?.();
  };

  const go = (r: Result) => {
    finish();
    void navigate({ to: r.to as never, search: {} as never });
  };

  const onInputKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query) changeQuery("");
      else inputRef.current?.blur();
      return;
    }
    if (!searching || flat.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % flat.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = flat[Math.min(active, flat.length - 1)];
      if (r) go(r);
    }
  };

  let index = -1;

  return (
    <>
      {/* Icon rail: one button that opens the sidebar and puts the cursor in the box. */}
      <button
        type="button"
        onClick={openSearch}
        aria-label="Search menu"
        title="Search menu (/)"
        className="hidden size-8 shrink-0 items-center justify-center self-center rounded-md text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:flex"
      >
        <Search className="size-4" aria-hidden />
      </button>

      <div className="relative shrink-0 group-data-[collapsible=icon]:hidden">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-sidebar-foreground/50"
          aria-hidden
        />
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={onInputKey}
          placeholder="Search menu…"
          aria-label="Search menu"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={searching}
          aria-controls={searching ? listId : undefined}
          aria-activedescendant={searching && flat.length > 0 ? optionId(active) : undefined}
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "h-7 w-full rounded-md border border-sidebar-border/70 bg-sidebar-accent/25 pl-7 pr-7 text-[12px] text-sidebar-foreground outline-none transition-colors",
            "placeholder:text-sidebar-foreground/50 hover:border-sidebar-border focus-visible:border-[var(--brand-gold)]/70 focus-visible:ring-1 focus-visible:ring-sidebar-ring",
            // No native clear button: ours is below, styled for the dark rail.
            "[&::-webkit-search-cancel-button]:hidden touch:h-11",
          )}
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              changeQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-sidebar-foreground/60 hover:text-sidebar-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : (
          <kbd
            aria-hidden
            className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 rounded border border-sidebar-border/70 px-1 font-mono text-[10px] leading-4 text-sidebar-foreground/50 max-md:hidden"
          >
            /
          </kbd>
        )}
      </div>

      {!searching ? (
        children
      ) : (
        <div id={listId} role="listbox" aria-label="Menu results" className="flex flex-col gap-1.5">
          {flat.length === 0 ? (
            <p
              role="status"
              className="rounded-md border border-dashed border-sidebar-border/70 px-2 py-3 text-center text-[12px] text-sidebar-foreground/70"
            >
              No matches
            </p>
          ) : (
            resultGroups.map((g) => (
              <div
                key={g.key}
                role="group"
                aria-label={g.label}
                className="rounded-md border border-sidebar-border/70 bg-sidebar-accent/25 px-1 py-1"
              >
                <div
                  aria-hidden
                  className="px-2 pb-0.5 pt-0.5 text-xs font-medium text-sidebar-foreground/70"
                >
                  <Highlighted text={g.label} query={query} />
                </div>
                <div className="flex flex-col gap-0.5">
                  {g.results.map((r) => {
                    index += 1;
                    const i = index;
                    const Icon = r.icon;
                    const current = isActive?.(r.to) ?? false;
                    const highlighted = i === active;
                    return (
                      <Link
                        key={r.to}
                        id={optionId(i)}
                        role="option"
                        aria-selected={highlighted}
                        to={r.to as string}
                        search={{} as never}
                        title={r.title}
                        onClick={finish}
                        onMouseMove={() => {
                          if (!highlighted) setActive(i);
                        }}
                        data-active={current ? "true" : undefined}
                        className={cn(
                          "flex h-8 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground outline-none [&>svg]:size-4 [&>svg]:shrink-0",
                          highlighted && "bg-sidebar-accent text-sidebar-accent-foreground",
                          current && "font-medium",
                        )}
                      >
                        <Icon aria-hidden />
                        <span className="min-w-0 flex-1 truncate">
                          <Highlighted text={r.label} query={query} />
                        </span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
