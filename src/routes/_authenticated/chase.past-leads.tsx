import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "@/components/back-link";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Search, ArrowLeft, ShieldAlert, X, Info, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  LOSS_TYPES,
  PAST_LEAD_MAX_RESULTS,
  PAST_LEAD_MIN_CHARS,
  STATUS_LABEL,
  fetchMyChaseRegion,
  fetchMyPastLeadSummary,
  searchMyPastLeads,
  whatTheyDid,
  type PastLead,
} from "@/lib/chase-past-leads";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/chase/past-leads")({
  head: () => ({
    meta: [
      { title: "Past Leads — Gold Star Chase" },
      {
        name: "description",
        content:
          "Search your own past chase leads by address or ZIP. View-only, last 14 days, your territory.",
      },
      { property: "og:title", content: "Past Leads — Gold Star Chase" },
      {
        property: "og:description",
        content: "Search-only lookup of the chases you took in the last 14 days.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: PastLeadsPage,
});

const dateOnly = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(DATE_LOCALE, US_DATE) : "—";

const dateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

function StatusChip({ code }: { code: string }) {
  const tone =
    code === "office_only"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300"
      : code === "claimed_elsewhere"
        ? "bg-muted text-muted-foreground"
        : "bg-primary/10 text-primary";
  return (
    <span
      className={cn("inline-flex h-7 items-center rounded-full px-3 text-[13px] font-medium", tone)}
    >
      {STATUS_LABEL[code] ?? code}
    </span>
  );
}

function PastLeadsPage() {
  const [q, setQ] = React.useState("");
  const [type, setType] = React.useState("all");
  const [submitted, setSubmitted] = React.useState<{ q: string; type: string } | null>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const regionQ = useQuery({ queryKey: ["my-chase-region"], queryFn: fetchMyChaseRegion });
  const region = regionQ.data ?? "your territory";

  const term = q.trim();
  const ready = term.length >= PAST_LEAD_MIN_CHARS;

  const resultsQ = useQuery({
    queryKey: ["chase-past-leads", submitted?.q, submitted?.type],
    enabled: !!submitted && submitted.q.length >= PAST_LEAD_MIN_CHARS,
    queryFn: () => searchMyPastLeads(submitted!.q, submitted!.type),
  });

  const rows: PastLead[] = submitted ? (resultsQ.data ?? []) : [];

  const run = () => {
    if (ready) setSubmitted({ q: term, type });
  };

  return (
    <div className="page-shell max-w-[1200px] pb-10">
      {/* Header */}
      <BackLink
        fallbackTo="/chase"
        label="Chase"
        className="inline-flex items-center gap-2 text-[15px] font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" />
        Chase
      </BackLink>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-[34px] font-bold leading-none tracking-tight text-foreground">
          Past Leads
        </h1>
        <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary/10 px-3 text-[14px] font-medium text-primary">
          <MapPin className="size-3.5" />
          {region}
        </span>
      </div>

      <p className="mt-2 text-[14px] text-muted-foreground">
        Recent chase history in your territory is searchable for 14 days.
      </p>

      {/* Guard banner */}
      <div className="mt-4 flex items-start gap-3 rounded-xl border border-amber-300/70 bg-amber-50 px-4 py-3.5 dark:border-amber-500/30 dark:bg-amber-500/10">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-400" />
        <p className="text-[14px] leading-6 text-foreground">
          <span className="font-semibold">
            Past leads clear from the active deck after 24 hours.
          </span>
        </p>
      </div>

      {/* Search block */}
      <div className="mt-4 rounded-xl border border-border bg-card p-4">
        <div className="flex items-stretch gap-0">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-4.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && run()}
              placeholder={`Search by address or ZIP — minimum ${PAST_LEAD_MIN_CHARS} characters`}
              className="h-[62px] rounded-l-lg rounded-r-none border-2 border-primary/70 pl-11 pr-10 text-[17px] shadow-none focus-visible:ring-0"
            />
            {q && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQ("");
                  setSubmitted(null);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-5" />
              </button>
            )}
          </div>
          <Button
            onClick={run}
            disabled={!ready}
            className="h-[62px] rounded-l-none rounded-r-lg px-8 text-[16px] font-semibold"
          >
            Search
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-muted-foreground">
            Enter at least {PAST_LEAD_MIN_CHARS} characters&nbsp; • &nbsp;Maximum{" "}
            {PAST_LEAD_MAX_RESULTS} results&nbsp; • &nbsp;No paging
          </p>
          <Select
            value={type}
            onValueChange={(v) => {
              setType(v);
              if (submitted) setSubmitted({ q: submitted.q, type: v });
            }}
          >
            <SelectTrigger className="h-11 w-[190px] rounded-lg text-[14px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {LOSS_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="capitalize">
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Results */}
      {submitted && (
        <div className="mt-4 rounded-xl border border-border bg-card">
          <div className="px-6 pt-5">
            <h2 className="text-[19px] font-semibold text-primary">Search Results</h2>
            <div className="mt-1 text-[14px] text-muted-foreground">
              {resultsQ.isLoading ? "Searching…" : `${rows.length} matches in ${region}`}
            </div>
          </div>

          {rows.length === 0 && !resultsQ.isLoading ? (
            <p className="px-6 py-8 text-[14px] text-muted-foreground">
              No past lead of yours matches that.
            </p>
          ) : (
            <table className="mt-4 w-full border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-border text-left text-[13px] font-medium text-muted-foreground">
                  <th className="px-6 py-2.5 font-medium">Address</th>
                  <th className="px-3 py-2.5 font-medium">Loss Type</th>
                  <th className="px-3 py-2.5 font-medium">Date</th>
                  <th className="px-3 py-2.5 font-medium">Your Activity</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-6 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.id}
                    className={cn(
                      "border-b border-border/70 last:border-0",
                      r.is_masked && "text-muted-foreground",
                    )}
                  >
                    <td className={cn("px-6 py-4", !r.is_masked && "text-foreground")}>
                      {r.address ?? "—"}
                      {r.locality && (
                        <span className="ml-1 text-muted-foreground">· {r.locality}</span>
                      )}
                    </td>
                    <td className="px-3 py-4 capitalize">
                      {String(r.incident_type).replace(/_/g, " ")}
                    </td>
                    <td className="px-3 py-4 tabular-nums">{dateOnly(r.reported_at)}</td>
                    <td className="px-3 py-4">{whatTheyDid(r)}</td>
                    <td className="px-3 py-4">
                      <StatusChip code={r.status_code ?? "view_only"} />
                    </td>
                    <td className="px-6 py-4 text-right">
                      {r.is_masked ? (
                        <span className="block max-w-[190px] text-[13px] leading-5 text-muted-foreground">
                          Contact the office for records older than 14 days.
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setOpenId(r.id)}
                          className="text-[14px] font-medium text-primary hover:underline"
                        >
                          View summary
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {rows.length > 0 && (
            <p className="border-t border-border px-6 py-4 text-[14px] text-muted-foreground">
              Showing {rows.length} of up to {PAST_LEAD_MAX_RESULTS} results
            </p>
          )}
        </div>
      )}

      {/* Why search-only */}
      <div className="mt-4 flex items-start gap-4 rounded-xl border border-border bg-card px-6 py-5">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-primary/40 text-primary">
          <Info className="size-5" />
        </span>
        <div>
          <h3 className="text-[15px] font-semibold text-foreground">Why search-only?</h3>
          <p className="mt-1 text-[14px] leading-6 text-muted-foreground">
            Protects homeowner privacy and prevents a browsable directory of fire and loss
            addresses.
            <br />
            Full property data loads only after an eligible lead is claimed.
          </p>
        </div>
      </div>

      <SummarySheet id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function SummarySheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["past-lead-summary", id],
    enabled: !!id,
    queryFn: () => fetchMyPastLeadSummary(id!),
  });
  const s = q.data;
  const attempts =
    (s?.my_attempts as
      Array<{ at: string; reason?: string; sub_reason?: string; note?: string }> | undefined) ?? [];

  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-[18px]">{s?.address ?? "Lead summary"}</SheetTitle>
        </SheetHeader>
        {q.isLoading ? (
          <p className="mt-4 text-[13px] text-muted-foreground">Loading…</p>
        ) : !s ? (
          <p className="mt-4 text-[13px] text-muted-foreground">Not available.</p>
        ) : (
          <div className="mt-4 space-y-4 text-[13px]">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Loss type" value={String(s.incident_type).replace(/_/g, " ")} />
              <Field label="Reported" value={dateTime(s.reported_at)} />
              <Field label="Accepted" value={dateTime(s.accepted_at)} />
              <Field label="Arrived" value={dateTime(s.arrived_at)} />
              <Field
                label="Outcome"
                value={s.outcome ? String(s.outcome).replace(/_/g, " ") : "None logged"}
              />
              <Field label="Lifecycle" value={String(s.lifecycle)} />
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Your attempt notes
              </p>
              {attempts.length === 0 ? (
                <p className="mt-1 text-muted-foreground">No notes you wrote.</p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {attempts.map((a, i) => (
                    <li key={i} className="rounded-lg border border-border p-3">
                      <p className="text-[12px] text-muted-foreground">{dateTime(a.at)}</p>
                      {a.reason && <p className="font-medium capitalize">{a.reason}</p>}
                      {a.note && <p className="mt-0.5 text-muted-foreground">{a.note}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="capitalize text-foreground">{value}</p>
    </div>
  );
}
