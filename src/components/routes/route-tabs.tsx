import { Link, useRouterState } from "@tanstack/react-router";

import { cn } from "@/lib/utils";

/**
 * Routes is one page in two views. Planning a day and looking back at where a
 * rep has been are the same job seen from either end, so they share a tab bar
 * rather than two sidebar entries. Both URLs stay real — `/routes` opens Plan,
 * `/routes/history` opens History — so every existing link keeps working.
 */
const TABS = [
  { to: "/routes", label: "Plan", exact: true },
  { to: "/routes/history", label: "History", exact: false },
] as const;

export function RouteTabs() {
  const path = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="border-b bg-card">
      <nav className="mx-auto flex max-w-[1500px] overflow-x-auto px-2 sm:px-3">
        {TABS.map((t) => {
          const active = t.exact ? path === t.to || path === t.to + "/" : path.startsWith(t.to);
          return (
            <Link
              key={t.to}
              to={t.to}
              className={cn(
                "shrink-0 border-b-2 px-3 py-2 text-[13px] font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
