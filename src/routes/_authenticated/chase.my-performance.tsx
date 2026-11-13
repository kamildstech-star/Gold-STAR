import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Lightbulb,
  TriangleAlert,
  X,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/components/app-context";
import { fetchMyPerformance, type MyFunnel } from "@/lib/chase-my-performance";
import { FitText } from "@/components/ui/fit-text";

export const Route = createFileRoute("/_authenticated/chase/my-performance")({
  head: () => ({
    meta: [
      { title: "My chase performance — Gold Star" },
      {
        name: "description",
        content:
          "Your own chase funnel: chases taken, arrivals, signings, against your last month and an anonymous team average.",
      },
      { property: "og:title", content: "My chase performance — Gold Star" },
      {
        property: "og:description",
        content: "Your chases, arrivals and signings with coaching from your own numbers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: MyChasePerformance,
});

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);

function Delta({ now, then }: { now: number; then: number }) {
  const diff = now - then;
  if (then === 0 && now === 0) return <span className="text-[11px] text-muted-foreground">—</span>;
  const up = diff >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[11px] ${
        up ? "text-emerald-700 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
      }`}
    >
      <Icon className="size-3" />
      {Math.abs(diff)} vs last month ({then})
    </span>
  );
}

function Step({ label, value, prev }: { label: string; value: number; prev: number }) {
  return (
    <Card className="flex-1">
      <CardContent className="p-3">
        <FitText className="text-[32px] font-bold leading-none tabular-nums text-foreground">
          {value}
        </FitText>
        <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
        <div className="mt-1.5">
          <Delta now={value} then={prev} />
        </div>
      </CardContent>
    </Card>
  );
}

function Conversion({ now, prev }: { now: number | null; prev: number | null }) {
  return (
    <div className="hidden shrink-0 flex-col items-center justify-center px-1 sm:flex">
      <ArrowRight className="size-4 text-muted-foreground" />
      <span className="text-[12px] font-semibold tabular-nums text-foreground">
        {now == null ? "—" : `${now}%`}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {prev == null ? "last mo —" : `last mo ${prev}%`}
      </span>
    </div>
  );
}

const DISMISS_KEY = "chase.my-performance.outcome-nudge";

function MyChasePerformance() {
  // The viewed person's funnel under View As (read only).
  const { viewerUserId: subjectId } = useAppContext();
  const q = useQuery({
    queryKey: ["my-chase-performance", subjectId],
    enabled: !!subjectId,
    queryFn: () => fetchMyPerformance(subjectId!),
  });

  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
  }, []);
  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  const d = q.data;
  const f: MyFunnel = d?.funnel ?? { chases: 0, arrived: 0, signed: 0 };
  const p: MyFunnel = d?.previousFunnel ?? { chases: 0, arrived: 0, signed: 0 };
  const teamSignRate = d?.teamAverage.signRate ?? null;
  const mySignRate = pct(f.signed, f.chases);

  return (
    <div className="page-shell">
      <div className="mb-4">
        <h1 className="flex items-center gap-2 text-[20px] font-bold tracking-tight text-foreground">
          <Activity className="size-5 text-brand-gold" />
          My performance
        </h1>
        <p className="text-[12px] text-muted-foreground">
          This month, counted from the moment you took the chase. Compared with your own last month
          and an anonymous team average — no names, no rankings.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-[12px] text-muted-foreground">Loading your numbers…</p>
      ) : (
        <>
          {/* Nudge, never a block. */}
          {!dismissed && d && d.missingOutcomes.length > 0 && (
            <Card className="mb-3 border-amber-200 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/15">
              <CardContent className="flex items-start gap-2 p-3">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] font-semibold text-foreground">
                    {d.missingOutcomes.length} chase
                    {d.missingOutcomes.length === 1 ? "" : "s"} without an outcome logged
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Worth closing off when you get a minute — nothing on this page or anywhere else
                    is blocked by it.
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {d.missingOutcomes.slice(0, 6).map((r) => (
                      <li key={r.id} className="truncate text-[12px] text-foreground">
                        {r.address ?? "Unknown address"}
                        <span className="ml-1 text-[11px] text-muted-foreground">
                          {new Date(r.accepted_at ?? r.reported_at).toLocaleDateString("en-US", {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 px-2 text-[11px]"
                  onClick={dismiss}
                >
                  <X className="size-3.5" />
                  Dismiss
                </Button>
              </CardContent>
            </Card>
          )}

          {/* Funnel: their action onward. */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
            <Step label="Chases taken" value={f.chases} prev={p.chases} />
            <Conversion now={pct(f.arrived, f.chases)} prev={pct(p.arrived, p.chases)} />
            <Step label="Arrived" value={f.arrived} prev={p.arrived} />
            <Conversion now={pct(f.signed, f.arrived)} prev={pct(p.signed, p.arrived)} />
            <Step label="Signed" value={f.signed} prev={p.signed} />
          </div>

          <p className="mt-2 text-[12px] text-muted-foreground">
            You sign{" "}
            <span className="font-semibold text-foreground">
              {mySignRate == null ? "—" : `${mySignRate}%`}
            </span>{" "}
            of the chases you take.
            {teamSignRate != null && (
              <> Team average: {Math.round(teamSignRate * 100)}% sign rate.</>
            )}
          </p>

          <div className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
            <Card>
              <CardContent className="p-3">
                <p className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <Lightbulb className="size-3.5 text-brand-gold" />
                  From your own numbers
                </p>
                {d && d.insights.length > 0 ? (
                  <ul className="space-y-2">
                    {d.insights.map((i) => (
                      <li
                        key={i.title}
                        className={`rounded-md border p-2 ${
                          i.tone === "good"
                            ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-500/40 dark:bg-emerald-500/15"
                            : i.tone === "warn"
                              ? "border-amber-200 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/15"
                              : "border-border bg-muted/40"
                        }`}
                      >
                        <p className="text-[12px] font-semibold text-foreground">{i.title}</p>
                        <p className="text-[11px] text-muted-foreground">{i.body}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-[12px] text-muted-foreground">{d?.insightsNote}</p>
                )}
                {d?.medianArrivalMinutes != null && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Typical time from taking a chase to arriving:{" "}
                    <span className="font-medium text-foreground">
                      {Math.round(d.medianArrivalMinutes)} min
                    </span>
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-3">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  This month vs last month
                </p>
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="text-left text-[11px] text-muted-foreground">
                      <th className="py-1 font-normal">Step</th>
                      <th className="py-1 text-right font-normal">This</th>
                      <th className="py-1 text-right font-normal">Last</th>
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {(
                      [
                        ["Chases", f.chases, p.chases],
                        ["Arrived", f.arrived, p.arrived],
                        ["Signed", f.signed, p.signed],
                      ] as const
                    ).map(([label, a, b]) => (
                      <tr key={label} className="border-t border-border">
                        <td className="py-1.5 text-foreground">{label}</td>
                        <td className="py-1.5 text-right font-semibold text-foreground">{a}</td>
                        <td className="py-1.5 text-right text-muted-foreground">{b}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Only your own history is compared here.{" "}
                  <Link to="/chase" className="underline">
                    Back to chase
                  </Link>
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
