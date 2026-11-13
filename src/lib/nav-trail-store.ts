/**
 * Where the user has actually been — the store behind the nav trail.
 *
 * This was the top half of `src/components/nav-trail.tsx`. It moved here
 * unchanged (bar one added field, see `Crumb.index`) so that the shared back
 * control can read the trail without importing the breadcrumb component, which
 * imports the back control. One list of visits, no import cycle.
 *
 * A route-derived breadcrumb ("Jobs › Job › Estimate") is a lie in this app:
 * people arrive at a record from a board, a search result, the dashboard or
 * another record, and the route tree knows none of that. So this records the
 * real visit order instead — and, crucially, treats a return visit as a
 * *return*, not a new step. See `visit()` for the truncation rule.
 */
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "rh.nav-trail";
/** Beyond this the oldest steps stop being "where I came from" and start being
 *  archaeology. The display elides further still — see HEAD/TAIL. */
const MAX_CRUMBS = 8;

export type Crumb = {
  /** Identity of the step — the record root, or the path. See `crumbKey`. */
  key: string;
  /** Newest pathname under that key, so the link returns where they left. */
  path: string;
  /** Parsed search, kept so the link returns to the view, not just the page. */
  search: Record<string, unknown>;
  label: string;
  /** Label came from the page itself, so stop trying to improve it. */
  named: boolean;
  /**
   * TanStack's `__TSR_index` for the browser entry this step was last seen at.
   *
   * Only ever used to answer one question: is this step *exactly* one browser
   * entry behind the current one? If it is, "back" can pop the stack instead of
   * pushing a new entry, which is what restores the list's scroll position and
   * keeps the browser's own Back button sane. Optional because trails written
   * before this field existed are still in live tabs, and because a pop is only
   * ever an optimisation — pushing to the same path is always correct.
   */
  index?: number;
};

/* ------------------------------------------------------------------ store --
 * Module-level rather than context: sign-out needs to clear it from outside
 * the tree, and there is exactly one trail per tab either way.
 */

let trail: Crumb[] = [];
let hydrated = false;
const listeners = new Set<() => void>();

function isCrumb(v: unknown): v is Crumb {
  const c = v as Crumb | null;
  return !!c && typeof c.path === "string" && typeof c.label === "string";
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed))
      trail = parsed
        .filter(isCrumb)
        // Trails written before steps had a record key still have a live tab.
        .map((c) => ({ ...c, key: c.key ?? crumbKey(c.path) }))
        .slice(-MAX_CRUMBS);
  } catch {
    trail = []; // A trail is a convenience; never let bad storage break a page.
  }
}

function setTrail(next: Crumb[]) {
  trail = next;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private mode or quota. The in-memory trail still works for this session.
  }
  for (const l of listeners) l();
}

/** Sign-out must not leave the next person looking at where the last one was. */
export function clearNavTrail() {
  hydrated = true;
  setTrail([]);
}

/**
 * Record a visit.
 *
 * The rule: **a step already in the trail truncates back to it, it never
 * appends.** Returning to a page means you are at that depth again, not one
 * deeper — so A → B → A reads "A", and A → B → C → B reads "A › B" with C
 * dropped, because C is no longer behind you, it is forward of you.
 *
 * Identity is `crumbKey`, deliberately excluding search. In this app search is
 * view state on a page (tab, filter, query), not a different page — so flipping
 * /jobs?tab=all to ?tab=mine updates the one Jobs crumb in place instead of
 * stuttering "Jobs › Jobs". The newest path and search always win, so the crumb
 * links back to the view they actually left.
 */
export function visit(
  path: string,
  search: Record<string, unknown>,
  label: string,
  named: boolean,
  index?: number,
) {
  hydrate();
  const key = crumbKey(path);
  const at = trail.findIndex((c) => c.key === key);
  const next =
    at >= 0
      ? trail.slice(0, at + 1)
      : [...trail, { key, path, search, label, named, index }].slice(-MAX_CRUMBS);
  if (at >= 0) {
    const kept = next[at];
    next[at] = {
      key,
      path,
      search,
      label: kept.named ? kept.label : label,
      named: kept.named || named,
      index,
    };
  }
  if (JSON.stringify(next) === JSON.stringify(trail)) return; // no-op re-render
  setTrail(next);
}

/** Upgrade a crumb once the page has rendered enough to name itself. */
export function relabel(key: string, label: string) {
  const at = trail.findIndex((c) => c.key === key);
  if (at < 0 || trail[at].label === label) return;
  const next = trail.slice();
  next[at] = { ...next[at], label, named: true };
  setTrail(next);
}

const EMPTY: Crumb[] = [];

export function useTrail(): Crumb[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => {
      hydrate();
      return trail;
    },
    () => EMPTY,
  );
}

/** Read the trail outside React. Tests and sign-out use it; nothing renders it. */
export function getNavTrail(): readonly Crumb[] {
  hydrate();
  return trail;
}

/* --------------------------------------------------------------- identity --*/

/** Record keys (uuid, ulid, numeric) — never a readable slug like "past-leads". */
export const RECORD_ID = /^(?=.*\d)[0-9a-z_-]{8,}$/i;

/** A key with no words in it. "GS-2026-09006" is a name; a uuid is not. */
export const OPAQUE_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^(?=.*\d)[0-9a-z]{16,}$/i;

/**
 * The record a path is inside, if any. `/admin/users/<uuid>` is a user under
 * `/admin/users`, the same way `/jobs/<uuid>` is a job under `/jobs`.
 */
export function recordOf(path: string): { section: string; id: string } | null {
  const seg = path.split("/").filter(Boolean);
  const at = seg.findIndex((s, i) => i > 0 && RECORD_ID.test(s));
  return at < 0 ? null : { section: `/${seg.slice(0, at).join("/")}`, id: seg[at] };
}

/**
 * Identity of a step. Everything under one record is ONE step.
 *
 * "this should be specific to the job not just the job page": while someone is
 * inside GS-2026-09006 the trail has to read as a path *through that job*, not
 * as a flat log of every view in the app. Job tabs are component state and
 * never touch the URL, so they already push nothing — but any location under
 * the same record root (a tab that later earns a URL, a print view, a room)
 * folds into the job's one crumb instead of stuttering it across the row. A
 * genuine departure — Fleet, an account — has a different key and appends.
 */
export function crumbKey(path: string): string {
  const rec = recordOf(path);
  return rec ? `${rec.section}/${rec.id}` : path;
}

/** First URL segment, i.e. which part of the app a path belongs to. */
export const sectionOf = (path: string) => path.split("/").filter(Boolean)[0] ?? "";
