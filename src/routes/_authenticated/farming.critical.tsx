import * as React from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { AlertOctagon, Gavel, Users } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { CriticalDecisionDialog } from "@/components/critical-decision-dialog";
import { useCriticalList } from "@/components/critical-clients-card";
import { MetricStat } from "@/components/metric-stat";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyLine, LoadError } from "@/components/ui-density";
import {
  CRITICAL_DECISION_META,
  CRITICAL_RESOLUTION_LABEL,
  SELF_CLEARED_WARN_SHARE,
  selfClearedShare,
  type CriticalListEntry,
} from "@/lib/critical-clients";
import { isSalesManager } from "@/lib/roles";
import { fmtDate } from "@/lib/table-prefs";
import { TONE, type Tone } from "@/lib/tone";
import { cn } from "@/lib/utils";

/**
 * The manager's Critical list.
 *
 * Melly: "The account lands on the manager's Critical list and cannot be
 * dismissed ... On day thirty the manager must pick one of four things, and
 * the system will not let them skip it or let it sit." And the cap: "If more
 * than twenty percent of a rep's clients are Critical at once, they stop
 * getting new accounts assigned until they clean it up."
 *
 * Nothing on this page is dismissable. An episode leaves the list when the
 * client answers (the nightly sweep closes it) or when a manager decides.
 */

export const Route = createFileRoute("/_authenticated/farming/critical")({
  component: CriticalPage,
});

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold",
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

function SelfCleared({ s }: { s: { cleared: number; selfCleared: number } | undefined }) {
  const share = selfClearedShare(s);
  if (share == null || !s) return <span className="text-muted-foreground">—</span>;
  const pct = Math.round(share * 100);
  return (
    <span
      className="inline-flex items-center justify-end gap-1 tabular-nums"
      title={`${s.selfCleared} of ${s.cleared} cleared clients were last cleared by the rep's own log`}
    >
      {share >= SELF_CLEARED_WARN_SHARE ? <Chip tone="warning">{pct}%</Chip> : <span>{pct}%</span>}
      <span className="text-[11px] text-muted-foreground">
        {s.selfCleared}/{s.cleared}
      </span>
    </span>
  );
}

function trackWord(track: string) {
  return track === "relationship" ? "Relationship" : "Compliance";
}

function CriticalPage() {
  const app = useAppContext();
  const manager = isSalesManager(app.roles);
  const q = useCriticalList();
  const [tab, setTab] = React.useState<"open" | "recent">("open");
  const [deciding, setDeciding] = React.useState<CriticalListEntry | null>(null);

  const open = React.useMemo(
    () =>
      [...(q.data?.open ?? [])].sort(
        (a, b) =>
          Number(b.window.decisionDue) - Number(a.window.decisionDue) ||
          a.window.daysLeft - b.window.daysLeft,
      ),
    [q.data?.open],
  );
  const due = open.filter((e) => e.window.decisionDue);
  const caps = q.data?.caps ?? [];
  const overCap = caps.filter((c) => c.over_cap);

  if (q.isError) {
    return (
      <div className="px-3 py-4 md:px-6">
        <LoadError what="Critical clients" error={q.error} onRetry={() => void q.refetch()} />
      </div>
    );
  }

  return (
    <div className="px-3 pb-20 pt-3 md:px-6 md:pb-6 md:pt-5">
      <div className="mb-4">
        <h1 className="display-heavy text-[22px] leading-tight sm:text-[26px]">Critical clients</h1>
        <p className="mt-0.5 max-w-2xl text-[13px] text-muted-foreground">
          Any Critical counts, relationship or paperwork. The rep has thirty days and only a real
          acknowledged response clears it. On day thirty a manager must extend, reassign, demote to
          Dormant or close as No Service Needed. Nothing here can be dismissed.
        </p>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <MetricStat
          value={open.length}
          label="Critical now"
          icon={<AlertOctagon className="h-4 w-4" />}
          tone={open.length ? "danger" : "default"}
          compactOnPhone
        />
        <MetricStat
          value={due.length}
          label="Day-30 decisions due"
          icon={<Gavel className="h-4 w-4" />}
          tone={due.length ? "danger" : "default"}
          hint={due.length ? "Waiting on a manager" : "None past the deadline"}
          compactOnPhone
        />
        <MetricStat
          value={overCap.length}
          label="Reps over the 20% cap"
          icon={<Users className="h-4 w-4" />}
          tone={overCap.length ? "warning" : "default"}
          hint={overCap.length ? "No new accounts until cleared" : "Everyone under the cap"}
          compactOnPhone
        />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "open" | "recent")} className="mb-3">
        <TabsList aria-label="Critical list" className="h-10 p-1">
          <TabsTrigger value="open">Open ({open.length})</TabsTrigger>
          <TabsTrigger value="recent">
            Resolved · 90 days ({q.data?.recent.length ?? 0})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {q.isLoading ? (
        <EmptyLine>Loading…</EmptyLine>
      ) : tab === "open" ? (
        open.length === 0 ? (
          <EmptyLine>No client is Critical right now.</EmptyLine>
        ) : (
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-semibold">Client</th>
                  <th className="px-3 py-2 text-left font-semibold">Rep</th>
                  <th className="px-3 py-2 text-left font-semibold">Why</th>
                  <th className="px-3 py-2 text-left font-semibold">Window</th>
                  <th className="px-3 py-2 text-left font-semibold">Last decision</th>
                  {manager ? <th className="px-3 py-2 text-right font-semibold">Decide</th> : null}
                </tr>
              </thead>
              <tbody>
                {open.map((e) => (
                  <tr key={e.episode.id} className="border-b last:border-b-0">
                    <td className="px-3 py-2.5">
                      <Link
                        to="/accounts/$id"
                        params={{ id: e.episode.account_id }}
                        className="font-medium hover:underline"
                      >
                        {e.accountName}
                      </Link>
                      <div className="text-[11px] text-muted-foreground">
                        Since {fmtDate(e.episode.opened_at)}
                        {e.episode.extended_count ? ` · extended ${e.episode.extended_count}×` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {e.repName ?? <span className="text-muted-foreground">Unassigned</span>}
                    </td>
                    <td className="max-w-[320px] px-3 py-2.5">
                      <span className="text-muted-foreground">{trackWord(e.episode.track)} · </span>
                      {e.episode.reason}
                    </td>
                    <td className="px-3 py-2.5">
                      {e.window.decisionDue ? (
                        <Chip tone="danger">
                          Decision due · {-e.window.daysLeft} day
                          {-e.window.daysLeft === 1 ? "" : "s"} past
                        </Chip>
                      ) : (
                        <Chip tone="warning">
                          Day {e.window.dayOf} of 30 · due {fmtDate(e.episode.deadline)}
                        </Chip>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-muted-foreground">
                      {e.lastDecision
                        ? `${CRITICAL_DECISION_META[e.lastDecision.decision].label} · ${fmtDate(e.lastDecision.at)}${e.lastDecision.note ? ` — ${e.lastDecision.note}` : ""}`
                        : "—"}
                    </td>
                    {manager ? (
                      <td className="px-3 py-2.5 text-right">
                        <Button
                          size="sm"
                          variant={e.window.decisionDue ? "default" : "outline"}
                          onClick={() => setDeciding(e)}
                        >
                          Decide
                        </Button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (q.data?.recent.length ?? 0) === 0 ? (
        <EmptyLine>Nothing resolved in the last ninety days.</EmptyLine>
      ) : (
        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[640px] text-[13px]">
            <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr className="border-b">
                <th className="px-3 py-2 text-left font-semibold">Client</th>
                <th className="px-3 py-2 text-left font-semibold">Rep</th>
                <th className="px-3 py-2 text-left font-semibold">Why</th>
                <th className="px-3 py-2 text-left font-semibold">Outcome</th>
                <th className="px-3 py-2 text-left font-semibold">Closed</th>
              </tr>
            </thead>
            <tbody>
              {(q.data?.recent ?? []).map((e) => (
                <tr key={e.episode.id} className="border-b last:border-b-0">
                  <td className="px-3 py-2.5">
                    <Link
                      to="/accounts/$id"
                      params={{ id: e.episode.account_id }}
                      className="font-medium hover:underline"
                    >
                      {e.accountName}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">{e.repName ?? "—"}</td>
                  <td className="max-w-[320px] px-3 py-2.5 text-muted-foreground">
                    {trackWord(e.episode.track)} · {e.episode.reason}
                  </td>
                  <td className="px-3 py-2.5">
                    <Chip tone={e.resolution === "recovered" ? "success" : "neutral"}>
                      {CRITICAL_RESOLUTION_LABEL[e.resolution]}
                    </Chip>
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground">
                    {fmtDate(e.episode.resolved_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {manager && caps.length ? (
        <section className="mt-8">
          <h2 className="text-[15px] font-semibold">Reps against the 20% cap</h2>
          <p className="mb-3 text-[12px] text-muted-foreground">
            More than a fifth of a rep's clients Critical at once stops new accounts being assigned
            to them, including by reassignment, until they clean it up. Self-cleared is the share of
            a rep's clients whose clock was last restarted by something the rep logged by hand,
            rather than a reply, call or meeting the system caught.
          </p>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <table className="w-full min-w-[480px] text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-left font-semibold">Rep</th>
                  <th className="px-3 py-2 text-right font-semibold">Clients</th>
                  <th className="px-3 py-2 text-right font-semibold">Critical</th>
                  <th className="px-3 py-2 text-right font-semibold">Share</th>
                  <th className="px-3 py-2 text-left font-semibold">Cap</th>
                  <th className="px-3 py-2 text-right font-semibold">Self-cleared</th>
                </tr>
              </thead>
              <tbody>
                {caps.map((c) => (
                  <tr key={c.user_id} className="border-b last:border-b-0">
                    <td className="px-3 py-2.5 font-medium">{c.full_name}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.clients}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{c.critical}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {c.clients ? Math.round((c.critical / c.clients) * 100) : 0}%
                    </td>
                    <td className="px-3 py-2.5">
                      {c.over_cap ? (
                        <Chip tone="danger">Over cap · no new accounts</Chip>
                      ) : c.critical ? (
                        <Chip tone="warning">Under cap</Chip>
                      ) : (
                        <Chip tone="success">Clear</Chip>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <SelfCleared s={q.data?.selfCleared[c.user_id]} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <CriticalDecisionDialog entry={deciding} onOpenChange={(o) => !o && setDeciding(null)} />
    </div>
  );
}
