import { Link } from "@tanstack/react-router";
import { Radio } from "lucide-react";

import {
  countBy,
  previousWindow,
  useCompetitorSightings,
  type CompetitorSighting,
  type CountRow,
} from "@/lib/competitor-activity";
import { OUTCOME_LABEL } from "@/lib/incidents";

/**
 * Competitor activity for a reporting period: who is beating us to the door,
 * where, and whether it is getting worse. Same data as the chase cockpit's
 * "Competitor activity" card (useCompetitorSightings), sized for one
 * Performance grid slot.
 */
export function CompetitorActivitySnapshot({
  from,
  to,
  officeIds,
  periodLabel,
}: {
  from: Date;
  to: Date;
  /** null = RLS scoping; an id list narrows to those offices. */
  officeIds: readonly string[] | null;
  /** e.g. "Last 7 days". */
  periodLabel: string;
}) {
  const prevWin = previousWindow(from, to);
  const cur = useCompetitorSightings({ kind: "range", from, to }, officeIds);
  const prev = useCompetitorSightings({ kind: "range", ...prevWin }, officeIds);

  const sightings = cur.data ?? [];
  const total = sightings.length;
  const prevTotal = prev.data?.length ?? null;
  const byCompetitor = countBy(sightings, "competitor").slice(0, 4);
  const byArea = countBy(sightings, "area").slice(0, 4);
  const recent = sightings.slice(0, 4);

  return (
    <div className="flex h-full flex-col" data-testid="competitor-snapshot">
      <div className="mb-2 flex items-center gap-2">
        <Radio className="h-4 w-4 text-[var(--muted-foreground)]" />
        <h2 className="text-[14px] font-bold text-[var(--foreground)]">Competitor activity</h2>
        <span className="ml-auto text-[11px] text-[var(--muted-foreground)]">{periodLabel}</span>
      </div>

      {cur.isError ? (
        <div className="py-6 text-center text-[12px] text-[var(--muted-foreground)]">
          Could not load competitor activity.
        </div>
      ) : cur.isLoading ? (
        <div className="py-6 text-center text-[12px] text-[var(--muted-foreground)]">Loading…</div>
      ) : total === 0 ? (
        <div className="py-4 text-[12px] text-[var(--muted-foreground)]">
          <p className="font-medium text-[var(--foreground)]">
            No competitor sightings logged in this period.
          </p>
          <p className="mt-1">
            Sightings are logged from the chase cockpit: a chaser taps <b>Log outcome</b> on a lead
            and picks “{OUTCOME_LABEL.competitor_present}”, naming the competitor.
          </p>
          <TrendLine total={0} prevTotal={prevTotal} />
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-[26px] font-bold leading-none tabular-nums text-[var(--foreground)]">
              {total}
            </span>
            <span className="text-[12px] text-[var(--muted-foreground)]">
              {total === 1 ? "lead" : "leads"} lost to a competitor
            </span>
          </div>
          <TrendLine total={total} prevTotal={prevTotal} />

          <div className="mt-3 grid grid-cols-2 gap-3">
            <Breakdown title="By competitor" rows={byCompetitor} />
            <Breakdown title="By area" rows={byArea} />
          </div>

          <div className="mt-3">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              Most recent
            </div>
            <ul className="divide-y divide-[var(--border)]">
              {recent.map((s) => (
                <RecentRow key={s.id} s={s} />
              ))}
            </ul>
          </div>
        </>
      )}

      <div className="mt-auto flex items-center justify-between border-t border-[var(--border)] pt-2 text-[11px] text-[var(--muted-foreground)]">
        <span>{periodLabel}</span>
        <ViewMapLink />
      </div>
    </div>
  );
}

/** The cockpit card's "View map" link, shared so both point at the same place. */
export function ViewMapLink() {
  return (
    <Link to="/chase/search" className="font-semibold text-[var(--primary)] hover:underline">
      View map
    </Link>
  );
}

function TrendLine({ total, prevTotal }: { total: number; prevTotal: number | null }) {
  if (prevTotal == null) return null;
  const diff = total - prevTotal;
  // More sightings is worse, so up is red.
  const color =
    diff > 0 ? "var(--destructive)" : diff < 0 ? "var(--success)" : "var(--muted-foreground)";
  const text =
    diff === 0
      ? "No change"
      : `${diff > 0 ? "+" : "−"}${Math.abs(diff)}${
          prevTotal > 0
            ? ` (${diff > 0 ? "+" : "−"}${Math.round((Math.abs(diff) / prevTotal) * 100)}%)`
            : ""
        }`;
  return (
    <div className="mt-1 text-[11px]" data-testid="competitor-trend">
      <span className="font-semibold" style={{ color }}>
        {text}
      </span>{" "}
      <span className="text-[var(--muted-foreground)]">vs previous period ({prevTotal})</span>
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: CountRow[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
        {title}
      </div>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.label} className="text-[12px]">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[var(--foreground)]">{r.label}</span>
              <span className="shrink-0 font-bold tabular-nums text-[var(--foreground)]">
                {r.count}
              </span>
            </div>
            <span className="mt-0.5 block h-1 rounded-full bg-[var(--border)]">
              <span
                className="block h-1 rounded-full bg-[var(--destructive)]"
                style={{ width: `${(r.count / max) * 100}%` }}
              />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecentRow({ s }: { s: CompetitorSighting }) {
  const when = new Date(s.at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <li className="py-1.5 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate font-medium text-[var(--foreground)]">{s.competitor}</span>
        <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">{when}</span>
      </div>
      <div className="truncate text-[11px] text-[var(--muted-foreground)]">
        {s.area} · logged by {s.loggedBy ?? "unknown"}
      </div>
    </li>
  );
}
