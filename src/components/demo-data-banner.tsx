import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FlaskConical } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { fetchDemoTotal } from "@/lib/demo-data";
import { isPrivileged } from "@/lib/roles";

/**
 * Persistent reminder that the app is showing demonstration records.
 * Deliberately unmissable: shipping to a client with demo rows still in
 * place would corrupt their first month of real reporting.
 */
export function DemoDataBanner() {
  const app = useAppContext();
  const { data } = useQuery({
    queryKey: ["demo-total", app.userId],
    queryFn: fetchDemoTotal,
    // The count aggregates every table and can take seconds; it barely changes,
    // so hold it for the session rather than refetching on each page.
    staleTime: 15 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    enabled: !app.loading && !!app.userId,
  });

  if (!data || data <= 0) return null;

  return (
    /*
     * Gold marks this, it does not fill it. This was a full-width solid gold
     * band — the one place in the app that broke the accent rule outright.
     * A gold left rule plus gold type on the light ground is just as
     * unmissable and keeps gold meaning "pay attention here".
     */
    <div className="flex items-center gap-2 border-b border-l-[3px] border-l-[var(--brand-gold)] bg-[color-mix(in_oklab,var(--brand-gold)_10%,var(--card))] px-3 py-1.5 text-[length:var(--text-note)] font-semibold text-[var(--brand-gold-text)]">
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      {/* A phone truncated the long sentence mid-word and showed an ellipsis
          where the number should be. Same warning, sized to the screen — this
          row stays one line either way, so nothing is bought by shortening it
          further, and a dismiss control would be a 44px button under the
          coarse-pointer rule: taller than the banner it hides. */}
      <span className="min-w-0 truncate">
        <span className="md:hidden">Demo data — {data.toLocaleString("en-US")} sample rows</span>
        <span className="hidden md:inline">
          Demo data present — {data.toLocaleString("en-US")} sample rows are mixed into this
          workspace.
        </span>
      </span>
      {isPrivileged(app.realRoles) && (
        <Link
          to="/admin/demo"
          search={{} as never}
          className="ml-auto shrink-0 underline underline-offset-2"
        >
          Manage
        </Link>
      )}
    </div>
  );
}
