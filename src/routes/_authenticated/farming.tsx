import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

const TABS = [
  { to: "/farming", label: "Accounts", exact: true },
  { to: "/farming/campaigns", label: "Campaigns", exact: false },
  { to: "/farming/critical", label: "Critical", exact: false },
] as const;

export const Route = createFileRoute("/_authenticated/farming")({
  component: FarmingLayout,
});

function FarmingLayout() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  // Accounts is the only tab with a board on it, and the only one whose page is
  // built to hold its heading at the left edge while the board scrolls sideways
  // (see farming.index.tsx). Growing the layout to its content on Campaigns
  // would stretch that page to its longest unbroken line of prose instead.
  const board = path === "/farming" || path === "/farming/";

  return (
    /*
     * Mark, of the pipeline once its board scrolled sideways: "whats going on
     * here" — the page slid away and left a bare band behind it. The same
     * chain is what keeps this page whole: a query container whose width is
     * the scrollport, so `100cqw` means something from inside a box wider than
     * the screen; the layout grows to the board, which is what carries this
     * tab band across the whole scroll range instead of stopping it halfway;
     * and the tabs themselves hold the left edge. Measured in a reproduction
     * of this container chain: the tabs sit at left 0 after the page has
     * scrolled 351px sideways, against -62 without the holding.
     */
    <div className="@container min-h-full">
      <div className={cn("flex min-h-full flex-col", board && "md:w-max md:min-w-full")}>
        <div className="pt-3 md:pt-4">
          {/* The band stretches with the layout; the tabs hold the left edge.
              5 Nov: the job page's tab tray, the live tab gold. */}
          <nav className="mx-3 flex w-max gap-1 overflow-x-auto rounded-xl border bg-muted p-1 md:sticky md:left-0 md:mx-6 md:w-max">
            {TABS.map((t) => {
              const active = t.exact ? path === t.to || path === t.to + "/" : path.startsWith(t.to);
              return (
                <Link
                  key={t.to}
                  to={t.to}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center rounded-lg px-3.5 text-[13px] transition-colors",
                    active
                      ? "bg-primary font-semibold text-primary-foreground shadow-sm"
                      : "font-medium text-muted-foreground hover:bg-card/60 hover:text-foreground",
                  )}
                >
                  {t.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
