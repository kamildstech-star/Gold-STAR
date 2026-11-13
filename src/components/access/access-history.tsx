import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAppContext } from "@/components/app-context";
import { describeAuditRow, type AuditNames } from "@/lib/access-history";
import { relTime } from "@/lib/admin";
import {
  accessHistoryKey,
  fetchAccessHistory,
  type AccessHistoryFilter,
} from "@/lib/page-access-admin";

/**
 * "Change history" beneath a role or a person: who changed which page or
 * capability, when, and from what to what. The same section the user page has
 * had all along, now reading the same audit table for roles too.
 */
export function AccessHistory({
  filter,
  labels,
  title = "Change history",
}: {
  filter: AccessHistoryFilter;
  /** Capability key -> label, so a line says "Fleet: manage" and not "fleet.manage". */
  labels?: ReadonlyMap<string, string>;
  title?: string;
}) {
  const q = useQuery({
    queryKey: accessHistoryKey(filter),
    queryFn: () => fetchAccessHistory(filter),
  });

  // Office and region names for the ids a membership row stores. The app
  // context already holds every office and region once for the session, so
  // this is one map for the whole list — never a read per row.
  const app = useAppContext();
  const names = useMemo<AuditNames>(
    () => ({
      locations: new Map(app.allLocations.map((l) => [l.id, l.name])),
      regions: new Map(app.regions.map((r) => [r.id, r.name])),
    }),
    [app.allLocations, app.regions],
  );

  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {q.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : q.isError ? (
        <p className="text-xs text-muted-foreground">History could not be read.</p>
      ) : q.data?.unavailable ? (
        <p className="text-xs text-muted-foreground">
          History unavailable until the access-audit migration is applied.
        </p>
      ) : (q.data?.rows ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">No changes recorded yet.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {(q.data?.rows ?? []).map((row) => {
            const line = describeAuditRow(row, labels, names);
            const who = row.actor_id ? (q.data?.actors[row.actor_id] ?? "an admin") : "the system";
            return (
              <li key={row.id} className="rounded-sm border bg-muted/30 px-2 py-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="font-medium">{line.title}</span>
                  {line.subject ? (
                    <span className="min-w-0 truncate text-foreground/90">{line.subject}</span>
                  ) : null}
                  {line.detail ? (
                    <span className="text-muted-foreground">{line.detail}</span>
                  ) : null}
                  {line.role && filter.kind !== "role" ? (
                    <span className="text-muted-foreground">on {line.role}</span>
                  ) : null}
                  {line.change ? (
                    <span className="font-mono text-muted-foreground">{line.change}</span>
                  ) : null}
                  <span
                    className="ml-auto shrink-0 font-mono text-muted-foreground"
                    title={new Date(row.occurred_at).toLocaleString("en-US")}
                  >
                    {relTime(row.occurred_at)}
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">by {who}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
