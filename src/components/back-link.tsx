import type { ReactNode, MouseEvent, AnchorHTMLAttributes } from "react";
import { Link, useRouter } from "@tanstack/react-router";

import { useBackTarget } from "@/hooks/use-back-target";

/**
 * One back control for every page that has one.
 *
 * Hardcoded `<Link to="/accounts">` back buttons lie: arrive at a record from a
 * board, a search result, the dashboard or another record and "Back" dumps you
 * on the top-level list instead of where you were. So this asks the nav trail
 * where the user actually came from, and only falls back to the list route when
 * the trail has nothing behind this page — a pasted link or a new tab must
 * never leave the user on a dead button or bounce them out of the app.
 *
 * Why the trail rather than `router.history.back()` is argued in full in
 * `src/lib/back-target.ts`. The short version: a browser entry is not a page in
 * this app (search is view state), and a real destination can be rendered as a
 * real href — so middle click, "open in new tab", the hover status bar and the
 * label all describe the same place the click goes.
 *
 * `label` stays a prop and stays required: it names the *fallback*, which is
 * the only destination the call site knows. When the trail has an answer it
 * names itself and that name wins.
 */
export function BackLink({
  fallbackTo,
  fallbackSearch,
  fallbackParams,
  label,
  className,
  children,
  ...rest
}: {
  fallbackTo: string;
  /** Object or updater, whatever the destination route's search expects. */
  fallbackSearch?: unknown;
  fallbackParams?: Record<string, string>;
  /** Name of the fallback destination, e.g. "Fleet". Used for the a11y label. */
  label: string;
  className?: string;
  /** Call-site markup (icon + text). Falls back to `label` alone. */
  children?: ReactNode;
  // The rest is whatever a `<Button asChild>` wrapper injects on the way down.
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "className">) {
  const router = useRouter();
  const target = useBackTarget({
    fallbackTo,
    fallbackSearch: fallbackSearch as Record<string, unknown> | undefined,
    fallbackParams,
    fallbackLabel: label,
  });

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented) return;
    // Modified clicks and non-primary buttons belong to the browser, and the
    // href they act on is this same destination — leave them alone.
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // Same place either way; popping just restores the list's scroll position
    // and spares the stack a duplicate entry. `canGoBack` is TanStack's own
    // check (`__TSR_index !== 0`), read at click time because it is not
    // reactive, and it is what stops a pop walking out of the app.
    if (!target.pop || !router.history.canGoBack()) return;
    e.preventDefault(); // stops Link's own handler; see composeHandlers
    router.history.back();
  };

  return (
    <Link
      {...rest}
      to={target.to as never}
      search={target.search as never}
      params={target.params as never}
      className={className}
      // Both name the destination the click actually goes to. `title` yields to
      // a call site that set its own, which is the only way an icon-only
      // control can say something other than where it goes.
      title={rest.title ?? `Back to ${target.label}`}
      aria-label={`Back to ${target.label}`}
      onClick={onClick}
    >
      {children ?? label}
    </Link>
  );
}
