import { Link, useRouterState } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { BackLink } from "@/components/back-link";
import { Card, CardContent } from "@/components/ui/card";
import { pageForPath } from "@/lib/page-access";
import { useMyPageAccess } from "@/lib/use-page-access";

/**
 * The single place page access is enforced.
 *
 * It wraps the `_authenticated` outlet, so every route under it is covered by
 * one check rather than 100-odd copies of a guard that someone will forget on
 * the next page they add. Because the refused page's component never mounts,
 * none of its queries run — the data is not fetched and then hidden, it is
 * never asked for.
 *
 * This is a routing control, not a data boundary. Row-level security in the
 * database is what actually stops someone reading a record they should not.
 */
export function PageAccessGate({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const access = useMyPageAccess();
  const page = pageForPath(pathname);

  // No answer yet. Rendering the page would leak it; rendering a refusal would
  // flash "no access" at people who have it. Wait instead.
  if (access.loading) {
    return (
      <div className="p-4 text-sm text-muted-foreground" role="status">
        Loading…
      </div>
    );
  }

  // Missing catalogue entries or decisions never authorize a page.
  const decision = page ? access.byPage.get(page.id) : undefined;
  if (decision?.allowed === true) return <>{children}</>;

  // The access answer never arrived. Still closed — but say what actually
  // happened and offer a retry, rather than telling someone their role lost a
  // page it never lost.
  if (access.unavailable) {
    return (
      <div className="mx-auto max-w-lg p-4">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
            <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
              <Lock className="size-6" />
            </div>
            <div className="text-lg font-semibold">We couldn&apos;t check your access</div>
            <p className="text-sm text-muted-foreground">
              Your access settings didn&apos;t load just now. This is usually temporary — try again
              in a moment.
            </p>
            <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg p-4">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
            <Lock className="size-6" />
          </div>
          <div className="text-lg font-semibold">
            {page?.label ?? "This page"} is not part of your access
          </div>
          <p className="text-sm text-muted-foreground">
            Your role does not include this page. If you need it, ask an administrator to add it
            under Settings → Access.
          </p>
          <Button asChild size="sm" variant="outline">
            {/* They clicked into a page they cannot see; the useful escape is
                the page they came from, not the dashboard. */}
            <BackLink fallbackTo="/" label="dashboard">
              Back to dashboard
            </BackLink>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
