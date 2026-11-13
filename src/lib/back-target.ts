/**
 * Where "Back" goes — the whole decision, as one pure function.
 *
 * The complaint this exists to answer: "clicking the back button to the left of
 * the company should not take you back to customers, it should take you back to
 * the pipeline which is where you just were." Every back control in the app was
 * a hardcoded `<Link to="/accounts">`, so it always landed on the index no
 * matter how you arrived.
 *
 * ## Why the nav trail rather than `history.back()`
 *
 * Both know "one step ago", but they disagree about what a step is, and only
 * one of them can be shown to the user before they click:
 *
 * 1. **A browser entry is not a page.** This app puts view state in the URL —
 *    tab, filter, query, selected row — and `nav-trail-store` deliberately
 *    folds all of that into the page's one crumb (see `crumbKey`). So on a list
 *    where you changed the filter twice, `history.back()` undoes a filter;
 *    the trail returns you to the page you came from. The user is asking about
 *    pages.
 * 2. **The href has to be true.** `history.back()` cannot be expressed as a
 *    link, so the old control rendered `href` = the *fallback* and then went
 *    somewhere else on click: it read "Back to Accounts", middle-click opened
 *    Accounts, and a plain click landed on the pipeline. With the trail the
 *    destination is a real route we can name, so the href, the hover status
 *    bar, "open in new tab" and the aria-label all agree with the click.
 * 3. **It agrees with the breadcrumb.** The trail row is on screen directly
 *    above the control. Back going anywhere other than the crumb to the left of
 *    "you are here" is a contradiction the user can see.
 * 4. **It cannot leave the app or stand still.** `history.back()` from a
 *    pasted link walks out to whatever site was in the tab before; and after a
 *    URL-only change it lands on the page you are already on. The trail only
 *    ever holds in-app paths, and `resolveBackTarget` skips the current step.
 *
 * The one thing `history.back()` does better is *pop* — restoring the list's
 * scroll position and not growing the stack. So when the trail's answer happens
 * to be exactly one browser entry behind us, `pop` says so and the control pops
 * instead of pushing. That is an optimisation on top of the decision, never the
 * decision itself.
 */
import { crumbKey, sectionOf, type Crumb } from "@/lib/nav-trail-store";

export type BackTarget = {
  /** In-app path to navigate to. Always starts with a single "/". */
  to: string;
  /** Search for that path, when the trail remembered the view they left. */
  search?: Record<string, unknown>;
  /** Params, only ever from the caller's fallback route. */
  params?: Record<string, string>;
  /** Human name of the destination, for the label and the aria-label. */
  label: string;
  /** True when the destination came from the trail, false when it is the fallback. */
  fromTrail: boolean;
  /** True when the destination is exactly one browser entry behind us. */
  pop: boolean;
};

export type ResolveBackInput = {
  /** Oldest step first; the last entry is normally the page you are on. */
  trail: readonly Crumb[];
  /** Where the user is now. */
  pathname: string;
  /** TanStack's `__TSR_index` for the current entry, when it is known. */
  currentIndex?: number | null;
  /** The call site's own destination — the index route it used to hardcode. */
  fallbackTo: string;
  fallbackSearch?: Record<string, unknown>;
  fallbackParams?: Record<string, string>;
  /** Name of the fallback destination, e.g. "Fleet". */
  fallbackLabel: string;
};

/**
 * An in-app path and nothing else. Protocol-relative ("//evil.com") and
 * absolute URLs are the two ways a stored trail could point out of the app;
 * neither can get in through `visit()`, but the trail is read back out of
 * sessionStorage, so it is checked where it is used rather than assumed.
 */
function isInApp(path: unknown): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//");
}

export function resolveBackTarget({
  trail,
  pathname,
  currentIndex,
  fallbackTo,
  fallbackSearch,
  fallbackParams,
  fallbackLabel,
}: ResolveBackInput): BackTarget {
  const here = crumbKey(pathname);

  // Walk back from the newest step. Anything that is still *this* page — the
  // trail's own last crumb, or a second crumb under the same record — is not
  // somewhere to go back to, so skip it rather than stopping on it.
  for (let i = trail.length - 1; i >= 0; i--) {
    const c = trail[i];
    if (!isInApp(c?.path)) continue;
    if (c.key === here || c.path === pathname) continue;
    return {
      to: c.path,
      search: c.search,
      label: c.label,
      fromTrail: true,
      pop:
        typeof currentIndex === "number" && typeof c.index === "number"
          ? c.index === currentIndex - 1
          : false,
    };
  }

  // Cold load, pasted link, new tab, or a trail that only knows this page.
  // The call site's own index route is the right answer — it is what the
  // hardcoded link used to do, so nothing regresses.
  if (isInApp(fallbackTo) && fallbackTo !== pathname) {
    return {
      to: fallbackTo,
      search: fallbackSearch,
      params: fallbackParams,
      label: fallbackLabel,
      fromTrail: false,
      pop: false,
    };
  }

  // The fallback is the page we are on (or is not a route we can trust). Go up
  // a level instead — a back control must never be a no-op.
  const section = `/${sectionOf(pathname)}`;
  const to = section !== pathname && section !== "/" ? section : "/";
  return {
    to,
    label: to === "/" ? "Dashboard" : fallbackLabel,
    fromTrail: false,
    pop: false,
  };
}
