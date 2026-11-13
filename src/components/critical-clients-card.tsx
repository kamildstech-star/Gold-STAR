import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertOctagon, ChevronRight } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyLine, LoadError } from "@/components/ui-density";
import { useAppContext } from "@/components/app-context";
import {
  CRITICAL_LIST_PATH,
  CRITICAL_QUERY_KEY,
  criticalWindow,
  fetchCriticalEpisodeFor,
  fetchCriticalList,
  type CriticalListEntry,
} from "@/lib/critical-clients";
import { isSalesManager } from "@/lib/roles";
import { fmtDate } from "@/lib/table-prefs";
import { TONE } from "@/lib/tone";
import { cn } from "@/lib/utils";

/**
 * The manager's Critical list, on the dashboard. Melly: "The account lands on
 * the manager's Critical list and cannot be dismissed." So the card is
 * locked in the layout (dashboard-cards.ts) and the list page it opens is
 * where the day-30 decision is made.
 */

function windowLine(e: CriticalListEntry): string {
  if (e.window.decisionDue) {
    const over = -e.window.daysLeft;
    return `Day-30 decision due · ${over} day${over === 1 ? "" : "s"} past`;
  }
  return `Day ${e.window.dayOf} of 30 · due ${fmtDate(e.episode.deadline)}`;
}

export function useCriticalList() {
  return useQuery({ queryKey: CRITICAL_QUERY_KEY, queryFn: () => fetchCriticalList() });
}

export function CriticalClientsCard() {
  const q = useCriticalList();
  const open = q.data?.open ?? [];
  const due = open.filter((e) => e.window.decisionDue);
  const overCap = (q.data?.caps ?? []).filter((c) => c.over_cap);
  // Decisions first, then the nearest deadline.
  const top = [...open]
    .sort(
      (a, b) =>
        Number(b.window.decisionDue) - Number(a.window.decisionDue) ||
        a.window.daysLeft - b.window.daysLeft,
    )
    .slice(0, 5);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5">
          <AlertOctagon className="h-4 w-4 text-destructive" />
          Critical clients
          {open.length ? <Badge className={cn("ml-auto", TONE.danger)}>{open.length}</Badge> : null}
        </CardTitle>
        <CardDescription>
          {due.length
            ? `${due.length} past day thirty and waiting on a decision.`
            : "Each inside a thirty-day cure window. Only a real response clears one."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">
        {q.isError ? (
          <LoadError what="Critical clients" error={q.error} onRetry={() => void q.refetch()} />
        ) : q.isLoading ? (
          <EmptyLine>Loading…</EmptyLine>
        ) : !open.length ? (
          <EmptyLine>No client is Critical right now.</EmptyLine>
        ) : (
          <ul className="divide-y">
            {top.map((e) => (
              <li key={e.episode.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <Link
                    to="/accounts/$id"
                    params={{ id: e.episode.account_id }}
                    className="block truncate text-[13px] font-medium hover:underline"
                  >
                    {e.accountName}
                  </Link>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {e.repName ?? "Unassigned"} · {e.episode.reason}
                  </div>
                </div>
                <span
                  className={cn(
                    "shrink-0 rounded-md border px-2 py-0.5 text-[11px] font-semibold",
                    e.window.decisionDue ? TONE.danger : TONE.warning,
                  )}
                >
                  {windowLine(e)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {overCap.length ? (
          <div className="text-[11px] text-muted-foreground">
            Over the 20% cap:{" "}
            <span className="font-medium text-foreground">
              {overCap.map((c) => c.full_name).join(", ")}
            </span>{" "}
            — no new accounts until they clear Critical clients.
          </div>
        ) : null}
        <Link
          to={CRITICAL_LIST_PATH}
          className="mt-auto inline-flex items-center gap-1 self-start text-[12px] font-medium text-primary hover:underline"
        >
          Open the Critical list <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </CardContent>
    </Card>
  );
}

/**
 * One line under the Active Clients heading: how many are Critical and how
 * many decisions are waiting, with the way to the list. Managers only; a rep
 * sees the window on each card instead.
 */
export function CriticalListLink() {
  const app = useAppContext();
  const manager = isSalesManager(app.roles);
  const q = useQuery({
    queryKey: CRITICAL_QUERY_KEY,
    queryFn: () => fetchCriticalList(),
    enabled: manager,
  });
  if (!manager || !q.data?.open.length) return null;
  const due = q.data.open.filter((e) => e.window.decisionDue).length;
  return (
    <Link
      to={CRITICAL_LIST_PATH}
      className={cn(
        "mt-2 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium hover:underline",
        due ? TONE.danger : TONE.warning,
      )}
    >
      <AlertOctagon className="h-3.5 w-3.5" />
      {q.data.open.length} Critical
      {due ? ` · ${due} day-30 decision${due === 1 ? "" : "s"} due` : ""}
      <ChevronRight className="h-3.5 w-3.5" />
    </Link>
  );
}

/**
 * On the client's own record: the open episode, in one line. Says which day
 * of thirty it is, when recovery is due, and that a tick on the task does
 * not clear it.
 */
export function CriticalEpisodeNote({ accountId }: { accountId: string }) {
  const q = useQuery({
    queryKey: [...CRITICAL_QUERY_KEY, "account", accountId],
    queryFn: () => fetchCriticalEpisodeFor(accountId),
  });
  const ep = q.data;
  if (!ep) return null;
  const w = criticalWindow(ep);
  return (
    <Alert variant="destructive" className="mt-3">
      <AlertOctagon className="h-4 w-4" />
      <AlertTitle>
        {w.decisionDue
          ? `Critical · past the day-30 deadline (${fmtDate(ep.deadline)})`
          : `Critical · day ${w.dayOf} of 30 · recovery due ${fmtDate(ep.deadline)}`}
      </AlertTitle>
      <AlertDescription>
        {ep.track === "relationship" ? "Relationship" : "Compliance"}: {ep.reason}. Since{" "}
        {fmtDate(ep.opened_at)}
        {ep.extended_count ? ` · extended ${ep.extended_count}×` : ""}. Only a real acknowledged
        response — or the paperwork landing — clears it; completing the recovery task does not.
        {w.decisionDue ? (
          <>
            {" "}
            <Link to={CRITICAL_LIST_PATH} className="font-medium underline">
              The manager's decision is waiting.
            </Link>
          </>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
