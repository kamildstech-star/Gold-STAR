import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "@/components/app-context";
import { useOwnLocationId } from "@/lib/use-own-location";
import { MetricStrip } from "@/components/metric-strip";
import { BackLink } from "@/components/back-link";
import { ScoreBar, ScoreBreakdown } from "@/components/score-breakdown";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { ReportControls } from "@/components/report-controls";
import {
  carryIntelSearch,
  parsePeriodSearch,
  periodSearchOf,
  resolveSelection,
  type PeriodSearch,
} from "@/lib/report-search";
import { toastDbError } from "@/lib/db-errors";
import { ROLE_LABELS, primaryRole } from "@/lib/roles";
import {
  BAND_LABEL,
  COMPONENTS,
  computeScore,
  displayName,
  fetchMetrics,
  fetchMinActivity,
  fetchPersonAccounts,
  fetchPersonChase,
  fetchPersonJobs,
  fetchPersonStalled,
  fetchTeamMedians,
  fetchTimeline,
  fetchWeights,
  initialsFor,
  roleGroupFor,
  trailingRanges,
  trendBetween,
  weightsFor,
  type PeriodKey,
  type Range,
  type PersonAccount,
  type PersonChase,
  type PersonJob,
  type PersonMetrics,
  type PersonStalled,
  type Score,
  type TeamMedians,
  type TimelineEntry,
  type Weight,
} from "@/lib/scorecard";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/ui-density";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/intelligence/$userId")({
  head: () => ({
    meta: [
      { title: "Rep scorecard · Recovery Hub" },
      {
        name: "description",
        content:
          "Individual scorecard: activity timeline, accounts and cadence status, pipeline, jobs, chase performance and stalled items, measured against the team median.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): PeriodSearch => parsePeriodSearch(raw),
  component: PersonScorecardPage,
});

/** The trailing-score sparkline needs a fixed step, so map the preset onto one. */
function stepFor(days: number): PeriodKey {
  if (days <= 10) return "7d";
  if (days <= 45) return "30d";
  if (days <= 100) return "90d";
  return "quarter";
}

const money = (n: number | null | undefined) =>
  n == null ? "—" : `$${Math.round(Number(n)).toLocaleString("en-US")}`;

const day = (s: string | null) => (s ? new Date(s).toLocaleDateString(DATE_LOCALE, US_DATE) : "—");
const stamp = (s: string | null) => (s ? new Date(s).toLocaleString("en-US") : "—");

function Section({ children, empty }: { children: React.ReactNode; empty: boolean }) {
  if (empty)
    return (
      <div className="rounded-md border px-3 py-6 text-sm text-muted-foreground">
        Nothing recorded here for this person and period. This is an empty log, not a zero result.
      </div>
    );
  return <div className="overflow-x-auto rounded-md border">{children}</div>;
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      className={`whitespace-nowrap px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground ${
        right ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right,
  mono,
}: {
  children: React.ReactNode;
  right?: boolean;
  mono?: boolean;
}) {
  return (
    <td
      className={`whitespace-nowrap px-2 py-1.5 text-[12px] ${right ? "text-right" : ""} ${
        mono ? "font-mono tabular-nums" : ""
      }`}
    >
      {children}
    </td>
  );
}

function PersonScorecardPage() {
  const { userId } = Route.useParams();
  const app = useAppContext();
  const ownLocationId = useOwnLocationId();
  const search = Route.useSearch();
  const resolved = useMemo(
    () =>
      resolveSelection(search, {
        locations: app.visibleLocations,
        regions: app.regions,
        defaultLocationId: ownLocationId,
      }),
    [search, app.visibleLocations, app.regions, ownLocationId],
  );

  const range: Range = useMemo(
    () => ({ ...resolved.range, label: "Selected period" }),
    [resolved.range],
  );
  const prev: Range = useMemo(
    () =>
      resolved.compare
        ? { ...resolved.compare, label: "Comparison period" }
        : { ...resolved.range, label: "Comparison period" },
    [resolved.compare, resolved.range],
  );
  const period = useMemo(
    () =>
      stepFor(Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / 86_400_000))),
    [range],
  );
  const history = useMemo(() => trailingRanges(period, 6), [period]);
  const locationId =
    resolved.locationIds && resolved.locationIds.length === 1
      ? resolved.locationIds[0]
      : app.currentLocationId;

  const [metrics, setMetrics] = useState<PersonMetrics | null>(null);
  const [prevMetrics, setPrevMetrics] = useState<PersonMetrics | null>(null);
  const [weights, setWeights] = useState<Weight[]>([]);
  const [minActivity, setMinActivity] = useState(8);
  const [medians, setMedians] = useState<TeamMedians | null>(null);
  const [series, setSeries] = useState<{ label: string; score: Score }[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [accounts, setAccounts] = useState<PersonAccount[]>([]);
  const [jobs, setJobs] = useState<PersonJob[]>([]);
  const [chase, setChase] = useState<PersonChase[]>([]);
  const [stalled, setStalled] = useState<PersonStalled[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDenied(false);
    (async () => {
      const [cur, before, w, min, med] = await Promise.all([
        fetchMetrics(range, userId),
        fetchMetrics(prev, userId),
        fetchWeights(),
        fetchMinActivity(locationId),
        fetchTeamMedians(range, locationId).catch(() => null),
      ]);
      if (cancelled) return;
      const m = cur[0] ?? null;
      setMetrics(m);
      setPrevMetrics(before[0] ?? null);
      setWeights(w);
      setMinActivity(min);
      setMedians(med);
      if (!m) {
        setDenied(true);
        return;
      }
      const group = roleGroupFor(m.roles);
      const scoped = weightsFor(w, group, locationId);
      const hist = await Promise.all(
        history.map((r) =>
          fetchMetrics(r, userId).then((rows) => ({
            label: r.label,
            score: computeScore(rows[0] ?? { ...m, activity_events: 0 }, scoped, min),
          })),
        ),
      );
      if (cancelled) return;
      setSeries(hist);

      const [tl, acc, jb, ch, st] = await Promise.all([
        fetchTimeline(userId, range, 200).catch(() => []),
        fetchPersonAccounts(userId).catch(() => []),
        fetchPersonJobs(userId, range).catch(() => []),
        fetchPersonChase(userId, range).catch(() => []),
        fetchPersonStalled(userId).catch(() => []),
      ]);
      if (cancelled) return;
      setTimeline(tl);
      setAccounts(acc);
      setJobs(jb);
      setChase(ch);
      setStalled(st);
    })()
      .catch((e) => {
        if (cancelled) return;
        toastDbError(e, { action: "load this scorecard" });
        setDenied(true);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [userId, range.from.getTime(), locationId]);

  const group = metrics ? roleGroupFor(metrics.roles) : "sales";
  const scopedWeights = useMemo(
    () => weightsFor(weights, group, locationId),
    [weights, group, locationId],
  );
  const score = useMemo(
    () => (metrics ? computeScore(metrics, scopedWeights, minActivity) : null),
    [metrics, scopedWeights, minActivity],
  );
  const prevScore = useMemo(
    () => (prevMetrics ? computeScore(prevMetrics, scopedWeights, minActivity) : null),
    [prevMetrics, scopedWeights, minActivity],
  );
  const trend = trendBetween(score?.value ?? null, prevScore?.value ?? null);

  if (loading)
    return <div className="px-4 py-6 text-sm text-muted-foreground">Loading scorecard…</div>;

  if (denied || !metrics || !score)
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <BackLink
          fallbackTo="/intelligence"
          fallbackSearch={carryIntelSearch}
          label="Sales Intelligence"
          className="text-[12px] text-muted-foreground hover:underline"
        >
          ← Back to Sales Intelligence
        </BackLink>
        {/* Someone outside this viewer's scope: nothing about them is drawn,
            and no note explains what is withheld. */}
      </div>
    );

  const name = displayName(metrics);
  const role = primaryRole(metrics.roles);

  const medianFor = (key: keyof TeamMedians) =>
    medians && medians.cohort_size >= 3 ? (medians[key] as number | null) : null;

  return (
    <div className="mx-auto max-w-6xl space-y-3 px-4 py-4">
      <BackLink
        fallbackTo="/intelligence"
        fallbackSearch={periodSearchOf(search)}
        label="Sales Intelligence"
        className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:underline"
      >
        <ArrowLeft className="h-3 w-3" /> Sales Intelligence
      </BackLink>

      <PageHeader
        title={name}
        subtitle={`${role ? ROLE_LABELS[role] : "No role assigned"} · ${metrics.email ?? "no email"} · ${group === "chase" ? "chase weighting" : "sales weighting"}`}
      >
        <Button asChild variant="outline" size="sm">
          <Link
            to="/reports"
            search={{ ...periodSearchOf(search), r: "sales-by-rep", rep: userId }}
          >
            Reports for this person
          </Link>
        </Button>
      </PageHeader>

      <div className="-mx-4 border-y">
        <ReportControls
          search={search}
          resolved={resolved}
          locations={app.visibleLocations}
          regions={app.regions}
        />
      </div>

      <MetricStrip
        metrics={[
          {
            label: "Score",
            value: score.value == null ? "—" : score.value,
            note:
              score.value == null
                ? "insufficient activity"
                : `${BAND_LABEL[score.band]}${
                    trend.delta == null
                      ? ""
                      : ` · ${trend.delta > 0 ? "+" : ""}${Math.round(trend.delta)} vs prior`
                  }`,
            tone:
              score.band === "at_risk"
                ? "danger"
                : score.band === "watch"
                  ? "warning"
                  : score.band === "strong"
                    ? "success"
                    : "default",
          },
          { label: "Touchpoints", value: metrics.touchpoints, note: range.label.toLowerCase() },
          {
            label: "Accounts overdue",
            value: `${metrics.accounts_overdue}/${metrics.accounts_owned}`,
            note: "90-day cadence",
            tone: metrics.accounts_overdue > 0 ? "warning" : "default",
          },
          { label: "Jobs won", value: metrics.jobs_won, note: money(metrics.billed_value) },
        ]}
      />

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded-md border">
          <div className="border-b px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide">
            How this score is built
          </div>
          <ScoreBreakdown score={score} teamMedian={null} name={name} />
        </div>

        <div className="space-y-3">
          <div className="rounded-md border">
            <div className="border-b px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide">
              Score over time
            </div>
            <div className="space-y-1.5 p-3">
              {series.map((s) => (
                <div key={s.label} className="flex items-center gap-2">
                  <span className="w-[104px] shrink-0 text-[11px] text-muted-foreground">
                    {s.label}
                  </span>
                  <ScoreBar score={s.score} className="flex-1" />
                  <span className="w-[28px] text-right font-mono text-[11px] tabular-nums">
                    {s.score.value ?? "—"}
                  </span>
                </div>
              ))}
              {series.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No history available.</p>
              )}
            </div>
          </div>

          <div className="rounded-md border">
            <div className="border-b px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide">
              Versus team median
            </div>
            {medians && medians.cohort_size >= 3 ? (
              <table className="w-full">
                <tbody>
                  {(
                    [
                      ["touchpoints", metrics.touchpoints, medianFor("touchpoints")],
                      ["meetings_held", metrics.meetings_held, medianFor("meetings_held")],
                      [
                        "accounts_advanced",
                        metrics.accounts_advanced,
                        medianFor("accounts_advanced"),
                      ],
                      ["contact_attempts", metrics.contact_attempts, medianFor("contact_attempts")],
                      ["jobs_won", metrics.jobs_won, medianFor("jobs_won")],
                      ...(group === "chase"
                        ? ([
                            [
                              "median_tta_minutes",
                              metrics.median_tta_minutes,
                              medianFor("median_tta_minutes"),
                            ],
                          ] as const)
                        : []),
                    ] as [string, number | null, number | null][]
                  ).map(([key, mine, med]) => (
                    <tr key={key} className="border-b last:border-0">
                      <td className="px-3 py-1.5 text-[12px]">
                        {COMPONENTS[key]?.label ?? key.replace(/_/g, " ")}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-[12px] tabular-nums">
                        {mine == null ? "—" : Math.round(mine)}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-[12px] tabular-nums text-muted-foreground">
                        {med == null ? "—" : Math.round(med)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-3 py-3 text-[11px] text-muted-foreground">
                A median needs at least three comparable people in scope, otherwise it would reveal
                an individual colleague&apos;s figures. Not shown here.
              </p>
            )}
          </div>
        </div>
      </div>

      <Tabs defaultValue="timeline">
        <TabsList className="flex-wrap">
          <TabsTrigger value="timeline" className="text-[12px]">
            Activity ({timeline.length})
          </TabsTrigger>
          <TabsTrigger value="accounts" className="text-[12px]">
            Accounts ({accounts.length})
          </TabsTrigger>
          <TabsTrigger value="pipeline" className="text-[12px]">
            Pipeline
          </TabsTrigger>
          <TabsTrigger value="jobs" className="text-[12px]">
            Jobs ({jobs.length})
          </TabsTrigger>
          <TabsTrigger value="chase" className="text-[12px]">
            Chase ({chase.length})
          </TabsTrigger>
          <TabsTrigger value="stalled" className="text-[12px]">
            Stalled ({stalled.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="mt-2">
          <Section empty={timeline.length === 0}>
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <Th>When</Th>
                  <Th>Kind</Th>
                  <Th>What</Th>
                  <Th>Detail</Th>
                </tr>
              </thead>
              <tbody>
                {timeline.map((e) => (
                  <tr key={`${e.kind}-${e.link_id}`} className="border-b last:border-0">
                    <Td mono>{stamp(e.occurred_at)}</Td>
                    <Td>
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {e.kind.replace(/_/g, " ")}
                      </Badge>
                    </Td>
                    <Td>{e.title}</Td>
                    <Td>
                      <span className="text-muted-foreground">{e.detail ?? "—"}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </TabsContent>

        <TabsContent value="accounts" className="mt-2">
          <Section empty={accounts.length === 0}>
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <Th>Account</Th>
                  <Th>Stage</Th>
                  <Th>Status</Th>
                  <Th>Last touch</Th>
                  <Th right>Days silent</Th>
                  <Th>Cadence</Th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className="border-b last:border-0">
                    <Td>
                      <Link
                        to="/accounts/$id"
                        params={{ id: a.id }}
                        className="font-medium hover:underline"
                      >
                        {a.name}
                      </Link>
                    </Td>
                    <Td>{a.stage.replace(/_/g, " ")}</Td>
                    <Td>{a.status}</Td>
                    <Td mono>{day(a.last_touch)}</Td>
                    <Td right mono>
                      {a.days_since_touch ?? "—"}
                    </Td>
                    <Td>
                      {a.overdue ? (
                        <span className="text-destructive">Overdue</span>
                      ) : (
                        <span className="text-muted-foreground">On cadence</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </TabsContent>

        <TabsContent value="pipeline" className="mt-2">
          <PipelineBoard accounts={accounts} />
        </TabsContent>

        <TabsContent value="jobs" className="mt-2">
          <Section empty={jobs.length === 0}>
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <Th>Job</Th>
                  <Th>Account</Th>
                  <Th>Loss</Th>
                  <Th>Status</Th>
                  <Th right>Billed</Th>
                  <Th right>Collected</Th>
                  <Th>Created</Th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-b last:border-0">
                    <Td>
                      <Link
                        to="/jobs/$id"
                        params={{ id: j.id }}
                        className="font-medium hover:underline"
                      >
                        {j.job_number ?? j.job_name ?? j.address ?? "Job"}
                      </Link>
                    </Td>
                    <Td>{j.account_name ?? "—"}</Td>
                    <Td>{j.loss_type ?? "—"}</Td>
                    <Td>{j.status.replace(/_/g, " ")}</Td>
                    <Td right mono>
                      {money(j.billed_amount)}
                    </Td>
                    <Td right mono>
                      {money(j.collected_amount)}
                    </Td>
                    <Td mono>{day(j.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </TabsContent>

        <TabsContent value="chase" className="mt-2">
          <Section empty={chase.length === 0}>
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <Th>Address</Th>
                  <Th>Accepted</Th>
                  <Th>Arrived</Th>
                  <Th right>TTA</Th>
                  <Th>Outcome</Th>
                  <Th>Converted</Th>
                </tr>
              </thead>
              <tbody>
                {chase.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <Td>{c.address ?? "—"}</Td>
                    <Td mono>{stamp(c.accepted_at)}</Td>
                    <Td mono>{stamp(c.arrived_at)}</Td>
                    <Td right mono>
                      {c.tta_minutes == null ? "—" : `${Math.round(c.tta_minutes)}m`}
                    </Td>
                    <Td>{c.outcome?.replace(/_/g, " ") ?? "—"}</Td>
                    <Td>
                      {c.job_id ? (
                        <Link to="/jobs/$id" params={{ id: c.job_id }} className="hover:underline">
                          Job created
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">No</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </TabsContent>

        <TabsContent value="stalled" className="mt-2">
          <Section empty={stalled.length === 0}>
            <table className="w-full">
              <thead className="border-b">
                <tr>
                  <Th>Record</Th>
                  <Th>Type</Th>
                  <Th>Status</Th>
                  <Th right>Days stale</Th>
                  <Th right>Escalation step</Th>
                  <Th>Notified</Th>
                </tr>
              </thead>
              <tbody>
                {stalled.map((s) => (
                  <tr key={s.id} className="border-b last:border-0">
                    <Td>{s.record_label ?? s.record_id}</Td>
                    <Td>{s.record_type}</Td>
                    <Td>{s.record_status ?? "—"}</Td>
                    <Td right mono>
                      {s.days_stale ?? "—"}
                    </Td>
                    <Td right mono>
                      {s.step ?? "—"}
                    </Td>
                    <Td mono>{stamp(s.notified_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

const PIPELINE_ORDER = [
  "target",
  "contacted",
  "meeting_booked",
  "meeting_held",
  "vendor_onboarding",
  "active",
  "nurture",
  "dormant",
  "lost",
];

function PipelineBoard({ accounts }: { accounts: PersonAccount[] }) {
  const byStage = new Map<string, PersonAccount[]>();
  for (const a of accounts) {
    if (!byStage.has(a.stage)) byStage.set(a.stage, []);
    byStage.get(a.stage)!.push(a);
  }
  const stages = [
    ...PIPELINE_ORDER.filter((s) => byStage.has(s)),
    ...[...byStage.keys()].filter((s) => !PIPELINE_ORDER.includes(s)),
  ];

  if (accounts.length === 0)
    return (
      <div className="rounded-md border px-3 py-6 text-sm text-muted-foreground">
        No accounts are assigned to this person.
      </div>
    );

  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {stages.map((stage) => (
        <div key={stage} className="min-w-[190px] flex-1 rounded-md border">
          <div className="flex items-center justify-between border-b px-2 py-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide">
              {stage.replace(/_/g, " ")}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              {byStage.get(stage)!.length}
            </span>
          </div>
          <div className="divide-y">
            {byStage.get(stage)!.map((a) => (
              <Link
                key={a.id}
                to="/accounts/$id"
                params={{ id: a.id }}
                className="block px-2 py-1.5 text-[12px] hover:bg-accent/60"
              >
                <div className="truncate font-medium">{a.name}</div>
                <div className="text-[10px] text-muted-foreground">
                  {a.days_since_touch == null
                    ? "never touched"
                    : `${a.days_since_touch}d since touch`}
                  {a.overdue && <span className="text-destructive"> · overdue</span>}
                </div>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
