import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { AlertTriangle, CalendarClock, PhoneCall } from "lucide-react";
import { PageHeader } from "@/components/ui-density";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppContext } from "@/components/app-context";
import { ExportExcelButton } from "@/components/export-excel-button";
import { ReportLocationSelect } from "@/components/report-location-select";
import { useLocationChoice } from "@/lib/use-own-location";
import { ALL_LOCATIONS, locationIdOf, locationLabel } from "@/lib/report-location";
import type { ExportColumn } from "@/lib/export-table";
import { companyOwnedNote } from "@/lib/account-ownership";
import { buildWeeklySalesReport, weekWindow, type WeeklyPerson } from "@/lib/weekly-sales";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/* ------------------------------------------------------------------ */
/* Excel export — three sheets: one row per rep, then every exception  */
/* and every pipeline move with the company it belongs to.             */
/*                                                                     */
/* All three are built from the same office-scoped `people`, so the    */
/* workbook can never describe a wider set of records than the screen  */
/* that produced it. Every sheet names the office as well: the Reps    */
/* sheet the one the report was run for, the two detail sheets the     */
/* office of each row, so an account with none reads "Unattributed"    */
/* instead of silently passing for one of this office's own.           */
/* ------------------------------------------------------------------ */

/** An account with no office at all — shown everywhere rather than nowhere. */
const UNATTRIBUTED = "Unattributed";

/** The office column every sheet carries, so no sheet is ambiguous on its own. */
function officeColumn<T>(get: (row: T) => string): ExportColumn<T> {
  return { key: "office", label: "Office", get };
}

const PEOPLE_COLUMNS: ExportColumn<WeeklyPerson>[] = [
  { key: "name", label: "Rep", get: (p) => p.name },
  {
    key: "exceptions",
    label: "To talk about",
    type: "number",
    get: (p) =>
      p.exceptions.missedCadence.length +
      p.exceptions.needsAttention.length +
      p.exceptions.annualWindow.length,
  },
  { key: "calls", label: "Calls connected", get: (p) => p.activity.callsConnected, type: "number" },
  { key: "meetings", label: "Meetings held", get: (p) => p.activity.meetingsHeld, type: "number" },
  {
    key: "emails",
    label: "Emails replied to",
    get: (p) => p.activity.emailsReplied,
    type: "number",
  },
  {
    key: "noReply",
    label: "Sent, no reply",
    get: (p) => p.activity.outboundNoReply,
    type: "number",
  },
  {
    key: "touched",
    label: "Accounts touched",
    get: (p) => p.activity.touchedAccounts,
    type: "number",
  },
  { key: "moves", label: "Pipeline moves", get: (p) => p.stageMoves.length, type: "number" },
  { key: "jobsClosed", label: "Jobs closed", get: (p) => p.jobsClosed, type: "number" },
  { key: "cash", label: "Payments received", get: (p) => p.cashReceivedCount, type: "number" },
];

type ExceptionRow = { rep: string; office: string; company: string; issue: string; detail: string };

const EXCEPTION_COLUMNS: ExportColumn<ExceptionRow>[] = [
  { key: "rep", label: "Rep", get: (r) => r.rep },
  { key: "office", label: "Office", get: (r) => r.office },
  { key: "company", label: "Company", get: (r) => r.company },
  { key: "issue", label: "Issue", get: (r) => r.issue },
  { key: "detail", label: "Detail", get: (r) => r.detail },
];

function exceptionRows(
  people: WeeklyPerson[],
  officeName: (id: string | null) => string,
): ExceptionRow[] {
  return people.flatMap((p) => [
    ...p.exceptions.missedCadence.map((a) => ({
      rep: p.name,
      office: officeName(a.office),
      company: a.name,
      issue: "Missed cadence",
      detail: a.days === null ? "never touched" : `${a.days}d since a reply`,
    })),
    ...p.exceptions.needsAttention.map((a) => ({
      rep: p.name,
      office: officeName(a.office),
      company: a.name,
      issue: "Needs attention",
      detail: a.reason,
    })),
    ...p.exceptions.annualWindow.map((a) => ({
      rep: p.name,
      office: officeName(a.office),
      company: a.name,
      issue: "Annual meeting",
      detail: a.missed
        ? "annual meeting window closed with no meeting"
        : `annual meeting due ${a.dueOn ? new Date(a.dueOn).toLocaleDateString(DATE_LOCALE, US_DATE) : "soon"}`,
    })),
  ]);
}

type MoveRow = {
  rep: string;
  office: string;
  company: string;
  from: string | null;
  to: string | null;
  at: string;
};

const MOVE_COLUMNS: ExportColumn<MoveRow>[] = [
  { key: "rep", label: "Rep", get: (r) => r.rep },
  { key: "office", label: "Office", get: (r) => r.office },
  { key: "company", label: "Company", get: (r) => r.company },
  { key: "from", label: "From", get: (r) => r.from },
  { key: "to", label: "To", get: (r) => r.to },
  { key: "at", label: "When", get: (r) => r.at, type: "datetime" },
];

function moveRows(people: WeeklyPerson[], officeName: (id: string | null) => string): MoveRow[] {
  return people.flatMap((p) =>
    p.stageMoves.map((m) => ({
      rep: p.name,
      office: officeName(m.office),
      company: m.accountName,
      from: m.from,
      to: m.to,
      at: m.at,
    })),
  );
}

type Search = { loc?: string };

export const Route = createFileRoute("/_authenticated/reports/weekly-sales")({
  head: () => ({
    meta: [
      { title: "Weekly sales report — Recovery Hub" },
      {
        name: "description",
        content:
          "The weekly sales meeting agenda: missed touchpoints, accounts in breach, captured activity, pipeline movement and cash received.",
      },
      { property: "og:title", content: "Weekly sales report — Recovery Hub" },
      {
        property: "og:description",
        content: "Exceptions-first weekly agenda built from captured sales activity.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  // `loc` is the office, so a link to this report carries the office it was
  // read at — the same search key the jobs list and profitability use.
  validateSearch: (raw: Record<string, unknown>): Search => ({
    loc: typeof raw.loc === "string" ? raw.loc : undefined,
  }),
  component: WeeklySalesPage,
});

function WeeklySalesPage() {
  const app = useAppContext();
  const { roles, userId } = app;
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const managerView = roles.some((r) =>
    ["owner", "sales_head", "admin", "dev", "regional", "location_manager"].includes(r),
  );
  const [who, setWho] = useState<string>("me");

  /*
   * One office, resolved once, exactly the way every other report screen
   * resolves it: the viewer's explicit choice, then the sidebar context, then
   * their own office — always bounded by the offices they may already see, so
   * this can only narrow what RLS allows. The figures on every card and all
   * three export sheets are built from this one value.
   */
  const officeChoice = useLocationChoice(search.loc);
  const officeId = locationIdOf(officeChoice);
  const officeName = locationLabel(officeChoice, app.visibleLocations);

  const query = useQuery({
    queryKey: ["weekly-sales", userId, who, managerView, officeId],
    enabled: Boolean(userId),
    queryFn: () =>
      buildWeeklySalesReport(managerView && who === "all" ? null : (userId as string), officeId),
  });

  const { start, end } = weekWindow();
  const people = query.data?.people ?? [];
  const unattributed = query.data?.unattributed ?? [];
  const companyOwned = query.data?.companyOwned ?? [];

  /** Office id → the label the picker uses, so page and workbook read alike. */
  const nameOffice = useMemo(() => {
    const byId = new Map(app.visibleLocations.map((l) => [l.id, `${l.code} · ${l.name}`]));
    return (id: string | null) => (id ? (byId.get(id) ?? "Another office") : UNATTRIBUTED);
  }, [app.visibleLocations]);

  return (
    <div className="space-y-3 p-3 md:p-4">
      <PageHeader
        title="Weekly sales report"
        subtitle={`${start.toLocaleDateString(DATE_LOCALE, US_DATE)} – ${end.toLocaleDateString(DATE_LOCALE, US_DATE)} · ${officeName} · exceptions first, because they are the agenda`}
      >
        <ReportLocationSelect
          value={officeChoice}
          onChange={(next) => void navigate({ search: (o: Search) => ({ ...o, loc: next }) })}
        />
        <ExportExcelButton
          report="weekly-sales"
          surface="reports"
          entity="weekly_sales"
          filters={{ who: managerView ? who : "me", loc: officeId, office: officeName }}
          sheets={[
            {
              name: "Reps",
              rows: people,
              // The office the whole sheet was run for, so a workbook opened a
              // month later still says which twelfth of the company it is.
              columns: [officeColumn<WeeklyPerson>(() => officeName), ...PEOPLE_COLUMNS],
            },
            {
              name: "Exceptions",
              rows: exceptionRows(people, nameOffice),
              columns: EXCEPTION_COLUMNS,
            },
            {
              name: "Pipeline moves",
              rows: moveRows(people, nameOffice),
              columns: MOVE_COLUMNS,
            },
          ]}
        />
        {managerView && (
          <Select value={who} onValueChange={setWho}>
            <SelectTrigger className="h-8 w-[180px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="me" className="text-xs">
                Just me
              </SelectItem>
              <SelectItem value="all" className="text-xs">
                Everyone in scope
              </SelectItem>
            </SelectContent>
          </Select>
        )}
      </PageHeader>

      {/*
       * An account with no office is counted under every office rather than
       * dropped from all twelve, so the report says which accounts those are
       * instead of leaving the figures quietly wrong.
       */}
      {unattributed.length > 0 && (
        <p className="rounded-md border border-dashed px-3 py-2 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">
            {unattributed.length} account{unattributed.length === 1 ? " has" : "s have"} no office
            on record
          </span>{" "}
          —{" "}
          {unattributed
            .slice(0, 5)
            .map((a) => a.name)
            .join(", ")}
          {unattributed.length > 5 ? ` and ${unattributed.length - 5} more` : ""}. They are counted
          under every office rather than dropped from all of them, and the export marks them “
          {UNATTRIBUTED}”.
        </p>
      )}

      {/*
       * Mark: "House accounts belong to the company rather than a rep." Every
       * figure on this page hangs off a person, so there is nowhere to file a
       * company account — it is held out of everyone's week. Naming them is
       * the difference between a short agenda and an agenda somebody thinks
       * lost three accounts.
       */}
      {companyOwned.length > 0 && (
        <p className="rounded-md border border-dashed px-3 py-2 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">
            {companyOwnedNote(companyOwned.length)}
          </span>{" "}
          {companyOwned
            .slice(0, 5)
            .map((a) => a.name)
            .join(", ")}
          {companyOwned.length > 5 ? ` and ${companyOwned.length - 5} more` : ""}. They are still
          worked — they are just nobody's week.
        </p>
      )}

      {query.isLoading && <p className="text-sm text-muted-foreground">Building the agenda…</p>}
      {!query.isLoading && people.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {officeChoice === ALL_LOCATIONS
            ? "No accounts are assigned in your scope yet, so there is nothing to report on."
            : `No accounts are assigned to you in ${officeName}, so there is nothing to report on.`}
        </p>
      )}

      {people.map((p) => (
        <PersonAgenda key={p.userId} person={p} />
      ))}
    </div>
  );
}

function PersonAgenda({ person }: { person: WeeklyPerson }) {
  const { activity, exceptions } = person;
  const exceptionCount =
    exceptions.missedCadence.length +
    exceptions.needsAttention.length +
    exceptions.annualWindow.length;

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b py-2">
        <CardTitle className="text-base">{person.name}</CardTitle>
        <Badge variant={exceptionCount > 0 ? "destructive" : "secondary"}>
          {exceptionCount} to talk about
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4 pt-3">
        {/* Exceptions lead */}
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <AlertTriangle className="size-3.5" /> Missed and at risk
          </h2>
          {exceptionCount === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              Nothing missed this week — every account has a landed touch inside cadence.
            </p>
          ) : (
            <ul className="space-y-1 text-[13px]">
              {exceptions.missedCadence.slice(0, 12).map((a) => (
                <li key={`c-${a.id}`} className="flex justify-between gap-2 border-b py-1">
                  <span>
                    {a.name}
                    <NoOffice office={a.office} />
                  </span>
                  <span className="text-muted-foreground">
                    {a.days === null ? "never touched" : `${a.days}d since a reply`}
                  </span>
                </li>
              ))}
              {exceptions.needsAttention.map((a) => (
                <li key={`n-${a.id}`} className="flex justify-between gap-2 border-b py-1">
                  <span>
                    {a.name}
                    <NoOffice office={a.office} />
                  </span>
                  <span className="text-muted-foreground">{a.reason}</span>
                </li>
              ))}
              {exceptions.annualWindow.map((a) => (
                <li key={`m-${a.id}`} className="flex justify-between gap-2 border-b py-1">
                  <span className="flex items-center gap-1.5">
                    <CalendarClock className="size-3.5" /> {a.name}
                    <NoOffice office={a.office} />
                  </span>
                  <span className={a.missed ? "text-destructive" : "text-muted-foreground"}>
                    {a.missed
                      ? "annual meeting window closed with no meeting"
                      : `annual meeting due ${a.dueOn ? new Date(a.dueOn).toLocaleDateString(DATE_LOCALE, US_DATE) : "soon"}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Captured activity */}
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold">
            <PhoneCall className="size-3.5" /> Activity that landed
          </h2>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border md:grid-cols-5">
            <Metric label="Calls connected" value={activity.callsConnected} />
            <Metric label="Meetings held" value={activity.meetingsHeld} />
            <Metric label="Emails replied to" value={activity.emailsReplied} />
            <Metric label="Sent, no reply" value={activity.outboundNoReply} />
            <Metric label="Accounts touched" value={activity.touchedAccounts} />
          </div>
        </section>

        {/* Pipeline movement + closed work */}
        <section className="grid gap-3 md:grid-cols-2">
          <div>
            <h2 className="mb-1 text-[13px] font-semibold">Pipeline movement</h2>
            {person.stageMoves.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">Nothing moved since last week.</p>
            ) : (
              <ul className="text-[13px]">
                {person.stageMoves.slice(0, 8).map((m, i) => (
                  <li key={i} className="flex justify-between gap-2 border-b py-1">
                    <span>
                      {m.accountName}
                      <NoOffice office={m.office} />
                    </span>
                    <span className="text-muted-foreground">
                      {m.from ?? "—"} → {m.to ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h2 className="mb-1 text-[13px] font-semibold">Work and cash</h2>
            <ul className="text-[13px]">
              <li className="flex justify-between border-b py-1">
                <span>Jobs closed</span>
                <span>{person.jobsClosed}</span>
              </li>
              <li className="flex justify-between border-b py-1">
                <span>Payments received</span>
                <span>{person.cashReceivedCount}</span>
              </li>
            </ul>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * The one thing a row on this page can say about its office: that it has none.
 * Everything else on the card already belongs to the office in the header, so
 * naming that office per row would be noise — but a record shown under every
 * office has to say so, or the figures read as this office's own.
 */
function NoOffice({ office }: { office: string | null }) {
  if (office) return null;
  return (
    <Badge variant="outline" className="ml-1.5 px-1 py-0 text-[10px] font-normal">
      {UNATTRIBUTED}
    </Badge>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-background p-2">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
