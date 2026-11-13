/**
 * The T&M daily sheets on the job's Field Form tab.
 *
 * Mark: "for a T&M job, there is a sign in sheet, rate codes and the three
 * pages that are used for each day. can we have these pdfs, fillable,
 * available under field form, only when T&M is selected, and the new ticket
 * currently there should be for insurance and cash jobs."
 *
 * So, on a T&M job only (src/lib/field-forms-visibility.ts): pick the day,
 * open one of the three sheets, fill it on the phone, Save — which works with
 * no signal, like the field work ticket — and "Save + file PDF" writes the
 * entries onto Gold Star's own paper sheet and files it on the job's
 * Documents with the other reports. That filled PDF is what Mark sees. The
 * "Blank PDF" links hand out the original sheet with fillable boxes, for a
 * crew that still wants paper.
 *
 * One sheet per kind per day: opening today's sign-in sheet on a second phone
 * opens the same sheet, and both phones' signatures end up on it.
 *
 * David, 12 Oct:
 *  - the three sheets are small buttons in one row, not a tall list;
 *  - the day follows the calendar, so each morning is a fresh sheet and the
 *    earlier days stay one tap away and editable (`sheetDay`);
 *  - "Add person" offers the crew chief and the job's uploaded crew list,
 *    never every user (src/lib/job-crew-list.ts);
 *  - a filed PDF goes into its own job folder — Daily Sign-In, Daily Crew
 *    Chief, Daily Supply List — which every T&M job has under Documents
 *    (`ensureTmJobFolders`, David 20 Oct); filing makes one if it is missing.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CameraOff,
  CloudOff,
  Download,
  FileCheck2,
  Loader2,
  Upload,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { refreshTmDerived } from "@/lib/tm-derived";
import { Bi, useLabelLanguage } from "@/components/bilingual";
import { SyncBanner } from "@/components/offline/sync-banner";
import {
  CrewChiefEditor,
  SignInEditor,
  SupplyListEditor,
  type Person,
} from "@/components/tm-form-editors";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PaperScanUpload } from "@/components/paper-scan-upload";
import { TmFormsBundleDialog } from "@/components/tm-forms-bundle-dialog";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { fileIntoJobFolder, uploadDocumentFile } from "@/lib/documents";
import {
  crewPickList,
  fetchJobCrewList,
  readCrewNamesFile,
  saveJobCrewList,
} from "@/lib/job-crew-list";
import { todayLocal } from "@/lib/drying-log";
import { listQueue, newId, writeOrQueue } from "@/lib/offline-queue";
import { downloadPdf } from "@/lib/pdf-actions";
import {
  TM_FORM_KINDS,
  TM_FORM_META,
  getTmForm,
  heldPayload,
  keepQuantities,
  listTmForms,
  mergeSignIn,
  prefillCrewChief,
  prefillSignIn,
  prefillSupplyList,
  previousTmForm,
  setTmFormDocument,
  sheetDay,
  tmFormFilename,
  tmFormQueueLabel,
  trimSignIn,
  writeTmForm,
  type ClockSpan,
  type CrewMember,
  type JobFacts,
  type SignInPayload,
  type SupplyLine,
  type TmFormKind,
  type TmFormSummary,
  type TmFormWrite,
  type TmPayloadByKind,
} from "@/lib/tm-forms";
import { blankTmFormPdf, fillTmFormPdf, paperDate } from "@/lib/tm-forms-pdf";
import { laborCodes, loadTmRateCodes, type TmRateCode } from "@/lib/tm-rate-codes";
import { supplyCodesFor, type SupplyListKind } from "@/lib/job-supply-list";
import type { PaperScanKind } from "@/lib/paper-scan";
import { cn } from "@/lib/utils";

export type TmJob = {
  id: string;
  location_id: string;
  account_id: string | null;
  job_number: string | null;
  job_name: string | null;
  customer_name: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  crew_chief: string | null;
};

/** Shared with Settings › T&M rate codes, so an edit there reaches the pickers at once. */
const CODES_KEY = ["tm-rate-codes"] as const;

async function fetchTemplate(kind: TmFormKind): Promise<Uint8Array> {
  const res = await fetch(TM_FORM_META[kind].template);
  if (!res.ok) throw new Error(`The ${TM_FORM_META[kind].paperTitle} sheet could not be loaded.`);
  return new Uint8Array(await res.arrayBuffer());
}

function factsOf(job: TmJob): JobFacts {
  return {
    jobNumber: job.job_number,
    jobName: job.job_name,
    customerName: job.customer_name,
    address: job.address,
    locality: job.locality,
    region: job.region,
    postalCode: job.postal_code,
  };
}

export function TmFieldFormsPanel({
  job,
  crew,
  supplyList = "detailed",
}: {
  job: TmJob;
  crew: readonly CrewMember[];
  /**
   * FE10: which material list the job uses (job-supply-list.ts). A T&M job
   * gets all three daily sheets and the detailed supply list; any other job
   * gets only the Daily Supply List, offering the condensed ten.
   */
  supplyList?: SupplyListKind;
}) {
  const { bi } = useLabelLanguage();
  const condensed = supplyList === "condensed";
  const kinds: readonly TmFormKind[] = condensed ? ["supply_list"] : TM_FORM_KINDS;
  const onlyCodes = supplyCodesFor(supplyList);
  // null = follow the calendar; a date = somebody opened that day on purpose.
  const [chosen, setChosen] = useState<string | null>(null);
  const [today, setToday] = useState(() => todayLocal());
  const day = sheetDay(chosen, today);
  const [open, setOpen] = useState<TmFormKind | null>(null);
  const [blankBusy, setBlankBusy] = useState<TmFormKind | null>(null);
  const [bundleOpen, setBundleOpen] = useState(false);

  // A phone left on this tab overnight rolls over to the new day's sheets.
  useEffect(() => {
    const tick = () => setToday(todayLocal());
    const timer = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  const listQ = useQuery({
    queryKey: ["tm-forms", job.id],
    queryFn: () => listTmForms(job.id),
  });
  const codesQ = useQuery({ queryKey: CODES_KEY, queryFn: () => loadTmRateCodes() });
  const crewListQ = useQuery({
    queryKey: ["job-crew-list", job.id],
    queryFn: () => fetchJobCrewList(job.id),
  });

  const available = listQ.data?.available ?? true;
  // Who a scanned paper row is matched to: the crew chief and the uploaded list.
  const people: Person[] = useMemo(
    () =>
      crewPickList({
        assignments: crew,
        crewChiefId: job.crew_chief,
        uploaded: crewListQ.data?.names ?? [],
      }),
    [crew, job.crew_chief, crewListQ.data?.names],
  );
  const rows = listQ.data?.rows ?? [];
  const onDay = rows.filter((r) => r.form_date === day);
  const earlier = useMemo(() => {
    const byDay = new Map<string, TmFormSummary[]>();
    for (const r of rows) {
      if (r.form_date === day) continue;
      byDay.set(r.form_date, [...(byDay.get(r.form_date) ?? []), r]);
    }
    return [...byDay.entries()];
  }, [rows, day]);

  async function blank(kind: TmFormKind) {
    setBlankBusy(kind);
    try {
      const bytes = await blankTmFormPdf(kind, await fetchTemplate(kind));
      downloadPdf(bytes, tmFormFilename(kind, null));
    } catch (e) {
      toast.error("Could not make the blank sheet", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBlankBusy(null);
    }
  }

  return (
    <Card>
      {/* 13 Nov: one row — the title, the day, the two paper sheets (each one
          button: upload or photograph) and Download all — nothing above the
          sheets but that. It wraps on a phone. */}
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-tm-day-bar>
          <CardTitle className="mr-1 text-base">
            {condensed ? (
              <Bi en="Daily supply list" es="Lista diaria de suministros" />
            ) : (
              <Bi en="T&M daily sheets" es="Hojas diarias de T&M" />
            )}
          </CardTitle>
          <label className="flex items-center gap-2">
            <span className="text-sm font-semibold">
              <Bi en="Day" es="Día" />
            </span>
            <Input
              type="date"
              className="h-11 w-[11.5rem] text-[15px] font-medium tabular-nums sm:h-10"
              value={day}
              onChange={(e) => {
                const v = e.target.value;
                if (v) setChosen(v === today ? null : v);
              }}
            />
          </label>
          {day !== today && (
            <Button
              type="button"
              variant="ghost"
              className="h-11 px-2 sm:h-10"
              onClick={() => setChosen(null)}
            >
              {bi("Back to today", "Volver a hoy")}
            </Button>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {available && (
              <div
                className="flex flex-wrap items-center gap-2"
                role="group"
                aria-label={bi("Upload paper sheets", "Subir hojas de papel")}
              >
                {kinds
                  .filter((k): k is PaperScanKind => k === "sign_in" || k === "supply_list")
                  .map((k) => (
                    <PaperScanUpload
                      key={k}
                      kind={k}
                      job={job}
                      facts={factsOf(job)}
                      day={day}
                      people={people}
                      catalogue={codesQ.data?.rows ?? []}
                      savedDays={new Set(rows.filter((r) => r.kind === k).map((r) => r.form_date))}
                      disabled={listQ.isLoading}
                      onFiled={(d) => setChosen(d === today ? null : d)}
                    />
                  ))}
              </div>
            )}
            {/* David, 15 Oct: every filled sheet for the carrier, in one PDF.
                6 Nov: not on a phone — "this is going to be used in the field",
                where the crew only fills sheets in; the office bundles them. */}
            <Button
              type="button"
              variant="outline"
              className="hidden h-10 md:inline-flex"
              data-tm-download-all
              disabled={!available || listQ.isLoading || rows.length === 0}
              title={rows.length === 0 ? "No sheets saved on this job yet" : undefined}
              onClick={() => setBundleOpen(true)}
            >
              <Download className="mr-1.5 size-4" />
              {bi("Download all (PDF)", "Descargar todo (PDF)")}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <SyncBanner />

        {!available && (
          <div className="flex items-start gap-2 rounded-sm border border-dashed p-3 text-sm text-muted-foreground">
            <CameraOff className="mt-0.5 size-4 shrink-0" />
            <span>
              The T&amp;M sheets cannot be filled in the app yet — the database update (migration
              20261007231000) has not been applied. The blank sheets below still download.
            </span>
          </div>
        )}

        {available && listQ.isError && (
          <div className="flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>
              Could not load this job&rsquo;s sheets. That is <strong>not</strong> the same as there
              being none.{" "}
              <button type="button" className="underline" onClick={() => void listQ.refetch()}>
                Try again
              </button>
            </span>
          </div>
        )}

        {/* David, 12 Oct: small buttons in one row, so the tab stays short. */}
        <div
          className={cn("grid gap-2", condensed ? "grid-cols-1 sm:max-w-xs" : "grid-cols-3")}
          role="group"
          aria-label={condensed ? "Daily supply list" : "T&M sheets"}
        >
          {kinds.map((kind) => {
            const saved = onDay.find((r) => r.kind === kind);
            return (
              <button
                key={kind}
                type="button"
                data-tm-form={kind}
                disabled={!available || listQ.isLoading}
                onClick={() => setOpen(kind)}
                title={TM_FORM_META[kind].title}
                className={cn(
                  "flex min-h-11 flex-col items-start justify-center rounded-[8px] border px-2 py-1.5 text-left disabled:opacity-50",
                  saved && "border-primary/40 bg-primary/5",
                )}
              >
                <span className="flex w-full items-center gap-1 text-sm font-semibold leading-tight">
                  <span className="min-w-0 flex-1 truncate">{TM_FORM_META[kind].short}</span>
                  {saved?.document_id && (
                    <FileCheck2
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-label="PDF filed"
                    />
                  )}
                </span>
                <span className="text-[11px] leading-tight text-muted-foreground">
                  {saved
                    ? `${bi("Saved", "Guardado")} ${new Date(saved.updated_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                    : bi("Not started", "Sin empezar")}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <span className="mr-1">{bi("Blank paper:", "En blanco:")}</span>
          {kinds.map((kind) => (
            <Button
              key={kind}
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={blankBusy === kind}
              onClick={() => void blank(kind)}
            >
              {blankBusy === kind ? (
                <Loader2 className="mr-1 size-3 animate-spin" />
              ) : (
                <Download className="mr-1 size-3" />
              )}
              {TM_FORM_META[kind].short}
            </Button>
          ))}
        </div>

        {!condensed && (
          <CrewListControl
            jobId={job.id}
            names={crewListQ.data?.names ?? []}
            available={crewListQ.data?.available ?? true}
            loading={crewListQ.isLoading}
          />
        )}

        {earlier.length > 0 && (
          <section className="space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {bi("Other days", "Otros días")}
            </div>
            <ul className="divide-y rounded-[8px] border">
              {earlier.map(([d, sheets]) => (
                <li key={d} className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
                  <span className="min-w-[6.5rem] text-sm tabular-nums">{paperDate(d)}</span>
                  {kinds
                    .filter((k) => sheets.some((s) => s.kind === k))
                    .map((k) => (
                      <Button
                        key={k}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 px-2 text-xs"
                        onClick={() => {
                          setChosen(d === today ? null : d);
                          setOpen(k);
                        }}
                      >
                        {TM_FORM_META[k].short}
                        {sheets.find((s) => s.kind === k)?.document_id && (
                          <FileCheck2 className="ml-1 size-3 text-muted-foreground" />
                        )}
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          </section>
        )}
      </CardContent>

      {open && (
        <TmFormDialog
          key={`${open}:${day}`}
          kind={open}
          day={day}
          job={job}
          crew={crew}
          crewNames={crewListQ.data?.names ?? []}
          catalogue={codesQ.data?.rows ?? []}
          onlyCodes={onlyCodes}
          onClose={() => setOpen(null)}
        />
      )}
      <TmFormsBundleDialog
        open={bundleOpen}
        onOpenChange={setBundleOpen}
        jobId={job.id}
        jobNumber={job.job_number}
        facts={factsOf(job)}
        rows={rows}
        catalogue={codesQ.data?.rows ?? []}
        template={fetchTemplate}
      />
    </Card>
  );
}

/**
 * The job's crew list: how many names, and the upload that replaces them.
 *
 * David, 12 Oct: a spreadsheet of names only — one per cell or row — uploaded
 * once, and those names are the sign-in sheet's dropdown from then on.
 */
function CrewListControl({
  jobId,
  names,
  available,
  loading,
}: {
  jobId: string;
  names: readonly string[];
  available: boolean;
  loading: boolean;
}) {
  const { bi } = useLabelLanguage();
  const app = useAppContext();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      const read = await readCrewNamesFile(file);
      if (!read.ok) {
        toast.error(bi("That file could not be read", "No se pudo leer el archivo"), {
          description: read.reason,
        });
        return;
      }
      if (read.names.length === 0) {
        toast.error(bi("No names in that file", "No hay nombres en el archivo"), {
          description: "Put one name per cell or row, nothing else.",
        });
        return;
      }
      await saveJobCrewList(jobId, read.names);
      void qc.invalidateQueries({ queryKey: ["job-crew-list", jobId] });
      toast.success(
        bi(
          `${read.names.length} names on the crew list`,
          `${read.names.length} nombres en la lista`,
        ),
        {
          description: read.skipped
            ? `${read.skipped} cell(s) skipped — headers, numbers or over-long text.`
            : "They are the sign-in sheet's names from now on.",
        },
      );
    } catch (e) {
      toastDbError(e, { action: "Save the crew list" });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  if (!available) {
    return (
      <p className="rounded-sm border border-dashed p-2 text-xs text-muted-foreground">
        The crew list upload is waiting on a database update (migration 20261013090000). Until then
        the sign-in sheet offers the crew chief, and other names are typed in.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[8px] border px-3 py-1.5 text-sm">
      <Users className="size-4 shrink-0 text-muted-foreground" />
      <details className="min-w-0 flex-1">
        <summary className="cursor-pointer text-sm">
          {bi("Crew list", "Lista de personal")}:{" "}
          <span className="tabular-nums text-muted-foreground">
            {loading ? "…" : bi(`${names.length} names`, `${names.length} nombres`)}
          </span>
        </summary>
        {names.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">{names.join(" · ")}</p>
        ) : (
          <p className="mt-1 text-xs text-muted-foreground">
            {bi(
              "Upload a CSV or Excel file of names — one per cell or row, nothing else.",
              "Suba un CSV o Excel con nombres — uno por celda o renglón.",
            )}
          </p>
        )}
      </details>
      <input
        ref={input}
        type="file"
        accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9"
        disabled={busy || app.writesDisabled}
        onClick={() => input.current?.click()}
      >
        {busy ? (
          <Loader2 className="mr-1 size-3.5 animate-spin" />
        ) : (
          <Upload className="mr-1 size-3.5" />
        )}
        {names.length ? bi("Replace names", "Reemplazar") : bi("Upload names", "Subir nombres")}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One sheet, opened                                                   */
/* ------------------------------------------------------------------ */

type Loaded<K extends TmFormKind> = {
  payload: TmPayloadByKind[K];
  previous: TmPayloadByKind[K] | null;
  exists: boolean;
};

/** Everyone clocked in on this job on `day`, for the sign-in sheet's first draft. */
async function clockSpans(jobId: string, day: string): Promise<ClockSpan[]> {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start.getTime() + 36 * 3600_000);
  const { data, error } = await supabase
    .from("time_entries")
    .select("user_id, started_at, ended_at, entry_type")
    .eq("job_id", jobId)
    .gte("started_at", new Date(start.getTime() - 12 * 3600_000).toISOString())
    .lt("started_at", end.toISOString());
  if (error) throw error;
  const ids = [...new Set((data ?? []).map((d) => d.user_id))];
  const names = new Map<string, string>();
  if (ids.length) {
    const p = await supabase.from("profiles").select("user_id, full_name").in("user_id", ids);
    for (const r of p.data ?? []) names.set(r.user_id, r.full_name ?? "");
  }
  return (data ?? []).map((d) => ({
    userId: d.user_id,
    name: names.get(d.user_id) || "",
    startedAt: d.started_at,
    endedAt: d.ended_at,
    entryType: d.entry_type,
  }));
}

/**
 * What the sheet opens with: the save still waiting on this phone (merged
 * with the stored copy for a sign-in sheet), else the stored sheet, else a
 * first draft from the job, its crew, the clock and the last sheet. Every
 * read is allowed to fail — with no signal the crew still gets a sheet.
 */
async function loadSheet<K extends TmFormKind>(
  kind: K,
  day: string,
  job: TmJob,
  crew: readonly CrewMember[],
): Promise<Loaded<K>> {
  const soft = async <T,>(p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch {
      return fallback;
    }
  };
  const [stored, items, previous] = await Promise.all([
    soft(getTmForm(job.id, kind, day), null),
    soft(listQueue(), []),
    soft(previousTmForm(job.id, kind, day), null),
  ]);
  const held = heldPayload(items, job.id, kind, day);
  if (held) {
    const payload =
      kind === "sign_in"
        ? (mergeSignIn(
            (stored?.payload as SignInPayload | undefined) ?? null,
            held as SignInPayload,
          ) as TmPayloadByKind[K])
        : held;
    return { payload, previous, exists: true };
  }
  if (stored) return { payload: stored.payload, previous, exists: true };

  const facts = factsOf(job);
  if (kind === "sign_in") {
    const spans = await soft(clockSpans(job.id, day), []);
    return {
      payload: prefillSignIn({
        job: facts,
        day,
        spans,
        crew,
        previous: previous as SignInPayload | null,
        newId,
      }) as TmPayloadByKind[K],
      previous,
      exists: false,
    };
  }
  if (kind === "crew_chief") {
    const chief = crew.find((c) => c.userId === job.crew_chief)?.name ?? null;
    return {
      payload: prefillCrewChief({
        job: facts,
        crewChiefName: chief,
        crew,
        previous: previous as TmPayloadByKind["crew_chief"] | null,
      }) as TmPayloadByKind[K],
      previous,
      exists: false,
    };
  }
  const onSite = crew.filter((c) =>
    ["crew_chief", "lead_technician", "technician", "project_manager"].includes(c.role),
  ).length;
  return {
    payload: prefillSupplyList({
      job: facts,
      crewCount: onSite,
      previous: previous as TmPayloadByKind["supply_list"] | null,
    }) as TmPayloadByKind[K],
    previous,
    exists: false,
  };
}

function TmFormDialog<K extends TmFormKind>({
  kind,
  day,
  job,
  crew,
  crewNames,
  catalogue,
  onlyCodes,
  onClose,
}: {
  kind: K;
  day: string;
  job: TmJob;
  crew: readonly CrewMember[];
  crewNames: readonly string[];
  catalogue: readonly TmRateCode[];
  /** FE10: the condensed list's codes; null offers the whole catalogue. */
  onlyCodes: ReadonlySet<string> | null;
  onClose: () => void;
}) {
  const { bi } = useLabelLanguage();
  const app = useAppContext();
  const qc = useQueryClient();
  const meta = TM_FORM_META[kind];
  const [draft, setDraft] = useState<TmPayloadByKind[K] | null>(null);
  const [busy, setBusy] = useState<"save" | "pdf" | null>(null);

  const sheetQ = useQuery({
    queryKey: ["tm-form", job.id, kind, day],
    queryFn: () => loadSheet(kind, day, job, crew),
    // A sheet is opened to be edited; refetching under the crew's thumbs would
    // throw their typing away.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  const value = draft ?? sheetQ.data?.payload ?? null;

  // The crew chief (the one system user on the sheet), then the job's
  // uploaded crew list. Never every user in the system (David, 12 Oct).
  const people: Person[] = useMemo(
    () => crewPickList({ assignments: crew, crewChiefId: job.crew_chief, uploaded: crewNames }),
    [crew, job.crew_chief, crewNames],
  );

  /** What a save writes: blank sign-in rows and zero quantities dropped. */
  const cleaned = (v: TmPayloadByKind[K]): TmPayloadByKind[K] => {
    if (kind === "sign_in") return trimSignIn(v as SignInPayload) as TmPayloadByKind[K];
    if (kind === "supply_list") {
      const s = v as TmPayloadByKind["supply_list"];
      return { ...s, lines: keepQuantities(s.lines) } as TmPayloadByKind[K];
    }
    return v;
  };

  async function filePdf(fallback: TmPayloadByKind[K]) {
    // The stored copy, not the screen: on a sign-in sheet it carries the rows
    // signed on other phones too.
    const fresh = await getTmForm(job.id, kind, day).catch(() => null);
    const payload = (fresh?.payload ?? fallback) as TmPayloadByKind[K];
    const bytes = await fillTmFormPdf(kind, payload, day, await fetchTemplate(kind), catalogue);
    const filename = tmFormFilename(kind, day, job.job_number);
    const doc = await uploadDocumentFile({
      file: new File([bytes.slice().buffer as ArrayBuffer], filename, { type: "application/pdf" }),
      scope: { locationId: job.location_id, jobId: job.id, accountId: job.account_id },
      // The job's report column, with the drying report; no new document type.
      docType: "job_report",
      userId: app.userId ?? null,
      name: `${meta.paperTitle} - ${paperDate(day)}`,
    });
    await setTmFormDocument(job.id, kind, day, doc.id);
    // Into this kind's folder on the job — made with the job's Documents, or
    // here if it is still missing; an old-named one is renamed, not doubled.
    await fileIntoJobFolder({
      documentId: doc.id,
      scope: { locationId: job.location_id, jobId: job.id, accountId: job.account_id },
      folderName: meta.folder,
      folderAliases: meta.formerFolders,
      userId: app.userId ?? null,
    });
    void qc.invalidateQueries({ queryKey: ["job-documents", job.id] });
  }

  async function save(alsoPdf: boolean) {
    if (!value) return;
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    setBusy(alsoPdf ? "pdf" : "save");
    const payload = cleaned(value);
    const row: TmFormWrite = {
      id: newId(),
      job_id: job.id,
      kind,
      form_date: day,
      payload: payload as unknown as Record<string, unknown>,
      captured_at: new Date().toISOString(),
      created_by: app.userId ?? null,
    };
    try {
      const res = await writeOrQueue({
        kind: "tm_field_form",
        id: row.id,
        payload: row as unknown as Record<string, unknown>,
        label: tmFormQueueLabel(row),
        write: () => writeTmForm(row),
      });
      if (res.queued) {
        toast.warning(bi("Saved on this device", "Guardado en este teléfono"), {
          description: alsoPdf
            ? bi(
                "It uploads by itself when you have signal. File the PDF then.",
                "Se enviará solo al tener señal. Luego guarde el PDF.",
              )
            : bi("It uploads by itself when you have signal.", "Se enviará solo al tener señal."),
        });
      } else {
        if (alsoPdf) {
          try {
            await filePdf(payload);
            toast.success(bi("Saved, PDF filed on the job", "Guardado, PDF en el trabajo"), {
              description: `It is on the Documents tab, in the ${meta.folder} folder.`,
            });
          } catch (e) {
            toast.warning(bi("Saved — the PDF did not file", "Guardado — el PDF no se guardó"), {
              description: e instanceof Error ? e.message : "Try Save + file PDF again.",
            });
          }
        } else {
          toast.success(bi("Sheet saved", "Hoja guardada"));
        }
      }
      // The ledger and the T&M bill too, not just the forms list (TM6).
      refreshTmDerived(qc, job.id);
      onClose();
    } catch (e) {
      // writeOrQueue only throws on a refusal that retrying cannot fix; the
      // save is kept in the sync list with the reason.
      toastDbError(e, { action: `Save the ${meta.title.toLowerCase()}` });
    } finally {
      setBusy(null);
    }
  }

  const previousLines =
    kind === "supply_list"
      ? ((sheetQ.data?.previous as TmPayloadByKind["supply_list"] | null)?.lines ?? null)
      : null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* flex, not the primitive's grid, so the footer has somewhere to stick (#288). */}
      <DialogContent className="flex max-h-[92vh] max-w-2xl flex-col overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{bi(meta.title, meta.es)}</DialogTitle>
          <DialogDescription>
            {paperDate(day)} · {meta.paperTitle}
          </DialogDescription>
        </DialogHeader>

        {sheetQ.isLoading || !value ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {bi("Opening…", "Abriendo…")}
          </p>
        ) : kind === "sign_in" ? (
          <SignInEditor
            value={value as SignInPayload}
            onChange={(v) => setDraft(v as TmPayloadByKind[K])}
            laborCodes={laborCodes(catalogue)}
            people={people}
            newId={newId}
          />
        ) : kind === "crew_chief" ? (
          <CrewChiefEditor
            value={value as TmPayloadByKind["crew_chief"]}
            onChange={(v) => setDraft(v as TmPayloadByKind[K])}
            people={people}
          />
        ) : (
          <SupplyListEditor
            value={value as TmPayloadByKind["supply_list"]}
            onChange={(v) => setDraft(v as TmPayloadByKind[K])}
            catalogue={catalogue}
            onlyCodes={onlyCodes}
            previousLines={previousLines as SupplyLine[] | null}
          />
        )}

        {/* Pinned to the bottom of the dialog, as on the field work ticket: the
            sign-in sheet is a long form and Save must not be a scroll away. */}
        <DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 mt-2 gap-2 border-t bg-background px-6 py-3 sm:justify-between">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CloudOff className="size-3.5" />
            {bi("Save works with no signal", "Guardar funciona sin señal")}
          </span>
          <div className={cn("flex w-full gap-2 sm:w-auto")}>
            <Button
              variant="outline"
              className="h-12 flex-1 sm:flex-none"
              disabled={busy != null || !value}
              onClick={() => void save(true)}
            >
              {busy === "pdf" && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              {bi("Save + file PDF", "Guardar + PDF")}
            </Button>
            <Button
              className="h-12 flex-1 sm:flex-none"
              disabled={busy != null || !value}
              onClick={() => void save(false)}
            >
              {busy === "save" && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              {bi("Save", "Guardar")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
