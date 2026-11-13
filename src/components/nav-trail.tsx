import { useEffect, useState } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { BackLink } from "@/components/back-link";
import { useBackTarget } from "@/hooks/use-back-target";
import {
  OPAQUE_ID,
  RECORD_ID,
  clearNavTrail,
  crumbKey,
  recordOf,
  relabel,
  sectionOf,
  useTrail,
  visit,
  type Crumb,
} from "@/lib/nav-trail-store";
import { sectionLabel } from "@/lib/hidden-sections";
import { cn } from "@/lib/utils";

export { clearNavTrail };

/**
 * Where the user has actually been, as a single quiet line under the top bar.
 *
 * The visit store itself lives in `@/lib/nav-trail-store` so that the shared
 * back control can read it without importing this component (which imports the
 * back control). This file is the row, the labels, and nothing else.
 *
 * A route-derived breadcrumb ("Jobs › Job › Estimate") is a lie in this app:
 * people arrive at a record from a board, a search result, the dashboard or
 * another record, and the route tree knows none of that. So the store records
 * the real visit order instead — and, crucially, treats a return visit as a
 * *return*, not a new step. See `visit()` for the truncation rule.
 *
 * Everything here is free: no query, no fetch, no per-crumb lookup. Labels come
 * from things the page has already put on screen.
 */

/** Hide-namespace the sidebar registers its route names under; the trail reads
 *  them back so there is only ever one list of human page names. Lives here
 *  rather than in app-shell because app-shell imports this file, not the
 *  reverse. */
export const NAV_LABEL_PAGE = "sidebar";

/* ----------------------------------------------------------------- labels --*/

/** The sidebar's own name for a route, or null when it is not a nav route. */
function navLabel(path: string): string | null {
  const label = sectionLabel(NAV_LABEL_PAGE, path);
  return label === path ? null : label; // sectionLabel echoes the key when unknown
}

/**
 * The page's own heading. This is the only place a record's real name — job
 * number, address, plate — exists without asking the server for it a second
 * time, and it costs one DOM read.
 *
 * An `h2` counts on a record page only. A few record routes title themselves
 * with an h2 rather than an h1 (a fleet vehicle, for one), and on a record page
 * the first heading in `main` *is* the record; on a list page it would be the
 * first card.
 */
function headingLabel(path: string): string | null {
  const rec = recordOf(path);
  const el = document.querySelector(rec ? "main h1, main h2" : "main h1");
  const text = el?.textContent?.trim().replace(/\s+/g, " ");
  if (!text || text.length > 60) return null;
  if (OPAQUE_ID.test(text)) return null; // a key is not a name
  // Record routes render a static noun while their query is in flight, and ship
  // that same noun as their meta title. Same word means still loading, so keep
  // looking rather than freezing "Vehicle" into the trail.
  if (rec && text.toLowerCase() === metaLabel()?.toLowerCase()) return null;
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
}

/** The route's `head` meta title, minus the app suffix every one of them carries. */
function metaLabel(): string | null {
  const text = document.title.split("·")[0].trim();
  return text && !OPAQUE_ID.test(text) ? text : null;
}

function titleCase(seg: string) {
  return seg
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const singular = (s: string) => s.replace(/ies$/, "y").replace(/s$/, "");

/** Best guess with nothing but the URL. Used immediately on arrival, and left
 *  in place if the page never names itself. */
function fallbackLabel(path: string): string {
  const rec = recordOf(path);
  if (rec) {
    // A record we cannot name yet. Section plus a stub of the id still tells
    // them which one, and beats printing a 36-character UUID at them.
    const section = navLabel(rec.section) ?? pageTitleFromPath(rec.section);
    return `${singular(section)} ${rec.id.slice(0, 4)}`;
  }
  return navLabel(path) ?? pageTitleFromPath(path);
}

/**
 * Static name for a path, for the top bar and as the trail's last resort.
 * Lives here so the trail and the top bar cannot disagree about what a page
 * is called.
 */
export function pageTitleFromPath(path: string): string {
  if (path === "/") return "Dashboard";
  const seg = path.split("/").filter(Boolean);
  if (seg[0] === "admin") {
    const map: Record<string, string> = {
      users: "Users",
      locations: "Locations",
      regions: "Regions",
      tags: "Tags",
      integrations: "Integrations",
      automations: "Automations",
      payroll: "People and pay",
      offboarding: "Offboarding",
    };
    return `Admin · ${map[seg[1]] ?? "Overview"}`;
  }
  if (seg[0] === "chase") {
    if (seg[1] === "dispatch") return "Chase · Dispatch";
    if (seg[1] === "performance") return "Chase · Performance";
    return "Chase";
  }
  if (seg[0] === "timeclock") {
    return seg[1] === "timesheets" ? "Timesheets" : "Time clock";
  }
  // Only sections whose name is not simply their segment title-cased need to be
  // here; anything missing used to fall through as a raw lowercase URL segment
  // ("fleet", "documents"), which is what made the trail read "fleet › fleet".
  const map: Record<string, string> = {
    farming: "Active Clients",
    "rep-cost": "Rep's cost",
    "my-commissions": "My commissions",
    "my-goals": "My goals",
    "team-goals": "Team goals",
    "sales-director": "Director dashboard",
    "feature-requests": "Feature requests",
    "weekly-sales": "Weekly sales",
    reassign: "Reassign a book",
    assistant: "AI tools",
  };

  const section = map[seg[0]] ?? titleCase(seg[0]);
  const last = seg[seg.length - 1];
  if (last === "new") return `New ${singular(section)}`;
  // A record page is named after one of the things the section holds.
  if (RECORD_ID.test(last)) return singular(section);
  if (seg.length > 1) return map[last] ?? titleCase(last);
  return section;
}

/* ---------------------------------------------------------------- the row --*/

const GAP = "gap" as const;

/** How much of a long trail the row shows before eliding the middle with "…".
 *  The store keeps more steps than this; only the display abbreviates. */
const HEAD = 1;
const TAIL = 2;

/**
 * "Fleet › Fleet". Two adjacent steps in the same section that resolve to the
 * same words are one step to the reader — a list and a record we could not name
 * being the usual pair. Keep the later one: it is the deeper step, and when it
 * is the last crumb it is where they actually are.
 */
function dedupeAdjacent(crumbs: Crumb[]): Crumb[] {
  return crumbs.filter((c, i) => {
    const next = crumbs[i + 1];
    if (!next) return true;
    return (
      sectionOf(c.path) !== sectionOf(next.path) ||
      c.label.toLowerCase() !== next.label.toLowerCase()
    );
  });
}

/**
 * Where "back" goes and what to call it — shared by the trail row and the
 * phone's inline version, so the two can never disagree about the destination.
 */
function useTrailNav() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Read here to decide whether a one-crumb trail is worth a row at all. Safe
  // during render because this component re-renders on every navigation anyway.
  const canGoBack = router.history.canGoBack();
  const crumbs = dedupeAdjacent(useTrail());

  const previous = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  const section = `/${sectionOf(pathname)}`;
  // The row's own fallback is one level up; `useBackTarget` prefers the trail
  // over it, which is the same answer `previous` gives, and the same answer
  // every other back control in the app now gives.
  const up = section !== pathname ? section : "/";
  const back = useBackTarget({
    fallbackTo: up,
    fallbackLabel: navLabel(up) ?? pageTitleFromPath(up),
  });

  return {
    pathname,
    crumbs,
    previous,
    fallbackTo: up,
    backLabel: back.label,
    /** What the trail calls the page the user is on. */
    here: crumbs.length ? crumbs[crumbs.length - 1].label : null,
    /*
     * A record page has no back control of its own any more — jobs.$id.tsx
     * used to render a second one directly under this row — so the trail has
     * to offer one even when it is the only step in it, which is what a pasted
     * link or a new tab looks like.
     */
    empty:
      pathname.startsWith("/auth") || (crumbs.length <= 1 && !canGoBack && !recordOf(pathname)),
  };
}

/**
 * The trail as the phone's page title: one back control and the name of the
 * record, inside the top bar.
 *
 * Below `md` this stands in for the whole trail row *and* the generic route
 * title. Those two cost 44px between them and said "Job" over a page whose own
 * heading already says which job — while the row underneath them said "← Jobs"
 * a third time. One control, in the bar that was there anyway.
 */
export function NavTrailInline({ title, className }: { title: string; className?: string }) {
  const nav = useTrailNav();
  const heading = "display-heavy min-w-0 truncate text-[16px] tracking-[0.01em]";

  if (nav.empty) return <h1 className={cn(heading, className)}>{title}</h1>;

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <BackLink
        fallbackTo={nav.fallbackTo}
        label={nav.backLabel}
        // BackLink renders a plain <a>, which the global coarse-pointer
        // tap-target rule deliberately does not touch, so this one is sized
        // here — it is the most pressed control on any phone screen.
        className="-ml-2 flex shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground touch:min-h-11 touch:min-w-11"
      >
        <ChevronLeft className="size-5" aria-hidden />
      </BackLink>
      <h1 className={heading}>{nav.here ?? title}</h1>
    </div>
  );
}

export function NavTrail() {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const nav = useTrailNav();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (pathname.startsWith("/auth")) return;
    // Read the live location rather than a selected object: search is parsed
    // per route and its identity churns, which would re-run this on every render.
    const search = (router.state.location.search ?? {}) as Record<string, unknown>;
    const nav = navLabel(pathname);
    // The browser entry this step sits on, so a later "Back" onto it can pop
    // the stack rather than push a duplicate. See `Crumb.index`.
    const hist = router.history.location.state as { __TSR_index?: unknown } | undefined;
    const index = typeof hist?.__TSR_index === "number" ? hist.__TSR_index : undefined;
    visit(pathname, search, nav ?? fallbackLabel(pathname), Boolean(nav), index);
    if (nav) return;

    // The name of a record only exists on screen once the page's data lands,
    // and the sidebar only registers its route names once permissions load —
    // so look a few times as things settle, then stop. `stale` guards against
    // reading the *previous* page's title before the head swaps over.
    //
    // What matters more than the schedule is the ranking. The old pass took
    // whatever came back first and then switched itself off — and on a record
    // route the *meta* title always came back first, because it is a static
    // noun the route ships in its `head` ("Job", "Vehicle") rather than
    // anything it had to fetch. The 150ms tick beat every query, wrote the
    // section name into the crumb, and cancelled the later ticks before the
    // real heading had rendered. That, not slow data, is why a job read "Jobs"
    // and a vehicle read "Fleet". So: only a *strong* label (the sidebar's own
    // name, or the page's heading) ends the watch, and on a record page the
    // meta noun is not used at all — the id stub is at least specific.
    const key = crumbKey(pathname);
    const record = recordOf(pathname);
    const stale = document.title;
    let alive = true;
    const timers = [150, 500, 1200, 2500, 4000].map((ms) =>
      setTimeout(() => {
        if (!alive) return;
        const strong = navLabel(pathname) ?? headingLabel(pathname);
        if (strong) {
          relabel(key, strong);
          alive = false;
          return;
        }
        if (record) return;
        const weak = document.title === stale ? null : metaLabel();
        if (weak) relabel(key, weak);
      }, ms),
    );
    return () => {
      alive = false;
      for (const t of timers) clearTimeout(t);
    };
  }, [pathname, searchStr, router]);

  // A "…" left open across a navigation would keep the row two lines tall.
  useEffect(() => setExpanded(false), [pathname]);

  if (nav.empty) return null;

  const { crumbs, previous, fallbackTo, backLabel } = nav;

  const elide = !expanded && crumbs.length > HEAD + TAIL + 1;
  const shown: (Crumb | typeof GAP)[] = elide
    ? [...crumbs.slice(0, HEAD), GAP, ...crumbs.slice(-TAIL)]
    : crumbs;

  return (
    // h-8 + nowrap + hidden overflow is the one-line guarantee: a long record
    // name, or an expanded "…", clips rather than pushing the page down.
    //
    // Hidden below md: on a phone this row held one back chevron and one label,
    // both of which NavTrailInline now renders inside the top bar that was
    // already there. The component stays mounted — it is what records visits.
    <nav
      aria-label="Trail"
      className="hidden h-8 shrink-0 flex-nowrap items-center gap-1 overflow-hidden whitespace-nowrap border-b bg-background px-3 text-[12px] text-muted-foreground touch:h-11 md:flex md:px-4"
    >
      <BackLink
        fallbackTo={fallbackTo}
        label={backLabel}
        // BackLink renders a plain <a>, which the global coarse-pointer
        // tap-target rule deliberately does not touch (it would inflate every
        // inline link in the app). So this one is sized here — it is the most
        // pressed control on any phone screen.
        className="-ml-1 flex shrink-0 items-center gap-0.5 rounded-sm px-1 py-0.5 hover:text-foreground touch:min-h-11 touch:min-w-11 touch:justify-center touch:px-2"
      >
        <ChevronLeft className="size-3.5 touch:size-5" aria-hidden />
        <span className="hidden sm:inline">Back</span>
      </BackLink>
      <span className="mx-1 h-3 w-px shrink-0 bg-border" aria-hidden />

      {shown.map((item, i) => {
        const last = i === shown.length - 1;
        // Phones get the back button and where they are, nothing else.
        const cls = cn("flex min-w-0 items-center gap-1", !last && "hidden md:flex");
        const sep = i > 0 && <ChevronRight className="size-3 shrink-0 opacity-60" aria-hidden />;

        if (item === GAP) {
          return (
            <span key={GAP} className={cls}>
              {sep}
              <button
                type="button"
                onClick={() => setExpanded(true)}
                aria-label="Show every step"
                // The trail row is 32px on a mouse, so the global 44px minimum
                // would be clipped by its overflow-hidden. This control is
                // desktop-only anyway (the gap never renders below md).
                data-touch-compact
                className="px-0.5 hover:text-foreground"
              >
                …
              </button>
            </span>
          );
        }

        return (
          <span key={item.key} className={cls}>
            {sep}
            {last ? (
              <span aria-current="page" className="min-w-0 truncate text-foreground/85">
                {item.label}
              </span>
            ) : (
              <Link
                to={item.path as never}
                search={item.search as never}
                className="min-w-0 truncate underline-offset-2 hover:text-foreground hover:underline"
              >
                {item.label}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
