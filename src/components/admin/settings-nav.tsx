import { Link, useNavigate } from "@tanstack/react-router";
import {
  BookOpen,
  Building2,
  Cable,
  FileText,
  Handshake,
  HardHat,
  Search,
  Settings2,
  Tags as TagsIcon,
  Users,
  Wallet,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  groupSettingsPages,
  searchSettingsPages,
  type SettingsAreaId,
  type SettingsPage,
  type SettingsSectionId,
  type SettingsSearchHit,
} from "@/lib/admin-settings";
import { cn } from "@/lib/utils";

/**
 * One icon per area, kept here so the registry stays free of React. Areas no
 * longer head the navigation (sections do); this is the search result's icon.
 */
export const SETTINGS_AREA_ICON: Record<SettingsAreaId, LucideIcon> = {
  people: Users,
  organisation: Building2,
  sales: TagsIcon,
  documents: FileText,
  rates: Wallet,
  automation: Cable,
  reference: BookOpen,
  developer: Wrench,
};

/** One icon per section — the rail's and the hub cards' headings. */
export const SETTINGS_SECTION_ICON: Record<SettingsSectionId, LucideIcon> = {
  operations: HardHat,
  sales: Handshake,
  system: Settings2,
};

export function isSettingsPathActive(pagePath: string, currentPath: string): boolean {
  return currentPath === pagePath || currentPath.startsWith(pagePath + "/");
}

/**
 * The search box. Typing filters to matching pages; Enter opens the best one;
 * Escape clears. `searchable` is already narrowed to what this person may
 * open, so a result is never a link to a refusal.
 */
export function SettingsSearch({
  searchable,
  onNavigate,
  autoFocus,
  size = "sm",
  query,
  onQueryChange,
}: {
  searchable: readonly SettingsPage[];
  onNavigate?: () => void;
  autoFocus?: boolean;
  size?: "sm" | "lg";
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const hits = useMemo(() => searchSettingsPages(query, searchable), [query, searchable]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => setCursor(0), [query]);

  const open = (hit: SettingsSearchHit | undefined) => {
    if (!hit) return;
    void navigate({ to: hit.page.path as string });
    onQueryChange("");
    onNavigate?.();
  };

  const trimmed = query.trim();

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search
          className={cn(
            "pointer-events-none absolute left-2.5 text-muted-foreground",
            size === "lg" ? "top-3 size-4.5" : "top-2.5 size-4",
          )}
        />
        <Input
          ref={inputRef}
          type="search"
          autoFocus={autoFocus}
          role="combobox"
          aria-expanded={trimmed.length > 0}
          aria-controls={listId}
          aria-label="Search settings"
          placeholder="Search settings…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              open(hits[cursor]);
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, Math.max(hits.length - 1, 0)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Escape" && query) {
              e.preventDefault();
              onQueryChange("");
            }
          }}
          className={cn("pl-8 pr-8", size === "lg" ? "h-11 text-[15px]" : "h-9 text-[13px]")}
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onQueryChange("");
              inputRef.current?.focus();
            }}
            className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      {trimmed ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Matching settings pages"
          className="space-y-0.5"
        >
          {hits.length === 0 ? (
            <p className="px-2 py-3 text-[13px] text-muted-foreground">
              Nothing matches “{trimmed}”. Try the name of the screen or a value it holds — a
              dropdown choice, a rate, an integration.
            </p>
          ) : (
            hits.map((h, i) => (
              <SearchHitRow
                key={h.page.path}
                hit={h}
                selected={i === cursor}
                onPick={() => open(h)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function SearchHitRow({
  hit,
  selected,
  onPick,
}: {
  hit: SettingsSearchHit;
  selected: boolean;
  onPick: () => void;
}) {
  const Icon = SETTINGS_AREA_ICON[hit.page.area];
  return (
    <Link
      to={hit.page.path as string}
      role="option"
      aria-selected={selected}
      onClick={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn(
        "flex min-h-11 items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
        selected ? "bg-primary/10 text-foreground" : "hover:bg-foreground/[0.04]",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-semibold leading-tight">{hit.page.label}</span>
        <span className="block truncate text-[12px] text-muted-foreground">
          {hit.page.description}
        </span>
      </span>
    </Link>
  );
}

/**
 * The grouped list of sections and pages: the left rail on a laptop, the drawer
 * on a tablet. The search box sits on top and, while a query is typed,
 * replaces the list with results so there is one thing to look at.
 */
export function SettingsNav({
  pages,
  searchable,
  currentPath,
  onNavigate,
  className,
}: {
  /** Pages to list, already narrowed to what this person can open. */
  pages: readonly SettingsPage[];
  /** Pages search may return — the listed pages plus openable sub-pages. */
  searchable: readonly SettingsPage[];
  currentPath: string;
  onNavigate?: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupSettingsPages(pages), [pages]);
  const searching = query.trim().length > 0;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <SettingsSearch
        searchable={searchable}
        query={query}
        onQueryChange={setQuery}
        onNavigate={onNavigate}
      />

      {searching ? null : (
        <nav aria-label="Settings sections" className="flex flex-col gap-3">
          {groups.map((g) => {
            const Icon = SETTINGS_SECTION_ICON[g.section.id];
            const areaActive = g.pages.some((p) => isSettingsPathActive(p.path, currentPath));
            return (
              <section key={g.section.id} aria-labelledby={`settings-section-${g.section.id}`}>
                <h3
                  id={`settings-section-${g.section.id}`}
                  className={cn(
                    "flex items-center gap-2 px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em]",
                    areaActive ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {g.section.label}
                </h3>
                <ul className="flex flex-col gap-px">
                  {g.pages.map((p) => {
                    const active = isSettingsPathActive(p.path, currentPath);
                    return (
                      <li key={p.path}>
                        <Link
                          to={p.path as string}
                          onClick={onNavigate}
                          aria-current={active ? "page" : undefined}
                          title={p.description}
                          className={cn(
                            // min-h-11 on touch: this list is the way between
                            // settings screens on an iPad, so each row is a real target.
                            "flex min-h-11 items-center rounded-md border-l-2 px-2.5 py-1.5 text-[13px] transition-colors lg:min-h-9",
                            active
                              ? "border-primary bg-primary/[0.07] font-semibold text-primary"
                              : "border-transparent text-foreground/85 hover:bg-foreground/[0.04] hover:text-foreground",
                          )}
                        >
                          {p.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </nav>
      )}
    </div>
  );
}
