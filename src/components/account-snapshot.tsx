import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, format } from "date-fns";
import { Briefcase, Building2, Clock3, FileText, Users, type LucideIcon } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { listAccountProposals } from "@/lib/account-proposals";
import { fetchAccountProperties } from "@/lib/company-hierarchy";
import { cn } from "@/lib/utils";

/**
 * The account at a glance — one row of numbers under the header, the same on
 * both layouts: when it was last touched, and how much there is of it (jobs,
 * proposals, people, buildings).
 *
 * Read-only, and cheap. Proposals and buildings share the query keys of the
 * cards that already read them, so on a page that shows those cards this row
 * costs nothing extra; the touch and the job count are a single row and a
 * head-only count.
 */
export const accountSnapshotKey = (accountId: string) => ["account-snapshot", accountId] as const;

type Tone = "danger" | "warning" | "neutral";

export function AccountSnapshot({
  accountId,
  contactCount,
  className,
  showProposals = true,
}: {
  accountId: string;
  contactCount: number;
  className?: string;
  /**
   * Melly, 6 Nov: "you're not gonna need proposals here" — on a prospect.
   * GSR is not sending proposals constantly, so the count is only shown once
   * the account is a client.
   */
  showProposals?: boolean;
}) {
  const snap = useQuery({
    queryKey: accountSnapshotKey(accountId),
    queryFn: async () => {
      const [touch, jobs] = await Promise.all([
        supabase
          .from("touchpoints")
          .select("occurred_at")
          .eq("account_id", accountId)
          // Same rule as the record's health clock: an unanswered outbound
          // email is an attempt, not contact. Unset counts.
          .or("counts_toward_cadence.is.null,counts_toward_cadence.eq.true")
          .order("occurred_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("jobs")
          .select("job_number", { count: "exact" })
          .eq("account_id", accountId)
          .order("created_at", { ascending: false })
          .limit(1),
      ]);
      if (touch.error) throw touch.error;
      if (jobs.error) throw jobs.error;
      return {
        lastTouch: touch.data?.occurred_at ?? null,
        jobs: jobs.count ?? 0,
        latestJob: (jobs.data?.[0]?.job_number as string | null | undefined) ?? null,
      };
    },
  });
  const proposals = useQuery({
    queryKey: ["account-proposals", accountId],
    queryFn: () => listAccountProposals(accountId),
    enabled: showProposals,
  });
  const buildings = useQuery({
    queryKey: ["account-properties", accountId],
    queryFn: () => fetchAccountProperties(accountId),
  });

  const last = snap.data?.lastTouch ?? null;
  const days = last ? differenceInCalendarDays(new Date(), new Date(last)) : null;
  const touchTone: Tone = days === null ? "danger" : days > 30 ? "warning" : "neutral";
  const touchValue =
    days === null ? "Never" : days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;
  const proposalRows = proposals.data?.rows ?? [];

  return (
    /*
      Columns follow the width this row actually gets, not the monitor: the
      sidebar takes 200-340px, so a tablet can leave the page phone-narrow.
    */
    <div className={cn("@container", className)}>
      {/* One card, five cells: the hairlines between them are the card's
          border colour showing through a 1px grid gap. */}
      <section
        aria-label="Account at a glance"
        data-testid="account-snapshot"
        className={cn(
          "grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border shadow-[var(--card-shadow)] @min-[560px]:grid-cols-3",
          showProposals ? "@min-[900px]:grid-cols-5" : "@min-[900px]:grid-cols-4",
        )}
      >
        <Tile
          icon={Clock3}
          label="Last touch"
          value={snap.isLoading ? "…" : touchValue}
          sub={last ? format(new Date(last), "MMM d, yyyy") : "Nothing logged yet"}
          tone={snap.isLoading ? "neutral" : touchTone}
          className="col-span-2 @min-[560px]:col-span-1"
        />
        <Tile
          icon={Briefcase}
          label="Jobs"
          value={snap.isLoading ? "…" : String(snap.data?.jobs ?? 0)}
          sub={snap.data?.latestJob ? `Latest ${snap.data.latestJob}` : undefined}
          numeric
        />
        {showProposals ? (
          <Tile
            icon={FileText}
            label="Proposals"
            value={proposals.isLoading ? "…" : String(proposalRows.length)}
            sub={proposalRows.length === 0 ? "None sent yet" : undefined}
            numeric
          />
        ) : null}
        <Tile icon={Users} label="Contacts" value={String(contactCount)} numeric />
        <Tile
          icon={Building2}
          label="Buildings"
          value={buildings.isLoading ? "…" : String(buildings.data?.rows.length ?? 0)}
          sub={
            buildings.data?.rows.length === 1
              ? (buildings.data.rows[0].name ?? buildings.data.rows[0].address)
              : undefined
          }
          numeric
        />
      </section>
    </div>
  );
}

const TONE: Record<Tone, { value: string; squircle?: "danger" | "warning" }> = {
  danger: { value: "text-destructive", squircle: "danger" },
  warning: { value: "text-warning", squircle: "warning" },
  neutral: { value: "text-foreground" },
};

function Tile({
  icon: Icon,
  label,
  value,
  sub,
  tone = "neutral",
  numeric,
  className,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  numeric?: boolean;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <div className={cn("flex min-w-0 items-center gap-3 bg-card px-4 py-3.5", className)}>
      <span className="icon-squircle" data-tone={t.squircle}>
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {label}
        </p>
        <p
          className={cn(
            "truncate text-[18px] font-bold leading-tight",
            numeric && "font-mono tabular-nums",
            t.value,
          )}
        >
          {value}
        </p>
        {sub && <p className="truncate text-[12px] text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}
