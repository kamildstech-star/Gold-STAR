import { jobSearchOr, siteSearch } from "@/lib/job-site-names";
import { jobDisplayName } from "@/lib/job-display-name";
import { isMissingSchema } from "@/lib/schema-fallback";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { EmptyScopeGuard } from "@/components/empty-scope-guard";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext, usePreviewOfficeScope } from "@/components/app-context";
import { useJobCreatableLocations } from "@/components/location-picker";
import { useCan } from "@/lib/permissions";
import { useExportGate } from "@/lib/export-guard";
import { ExportExcelButton } from "@/components/export-excel-button";
import { ReportLocationSelect } from "@/components/report-location-select";
import { useLocationChoice } from "@/lib/use-own-location";
import { locationIdOf, locationLabel } from "@/lib/report-location";
import type { ExportColumn } from "@/lib/export-table";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useJobStages } from "@/lib/job-stages";
import { JobBoard, StageBadge, type JobCard } from "@/components/job-board";
import {
  CLOSED_STATUSES,
  DEFAULT_JOB_COLUMNS,
  JOB_COLUMNS,
  fmtDate,
  fmtMoney,
  type JobColumnKey,
  type JobLossType,
  type JobStatus,
} from "@/lib/jobs";
import { useLossTypes, usePaymentTypes } from "@/lib/loss-categories";
import { loadJobPhotoCounts } from "@/lib/job-photo-counts";
import { fetchTablePrefs, mergeColumnOrder, saveTablePrefs } from "@/lib/table-prefs";
import { daysSince } from "@/lib/pipeline";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Plus,
  SlidersHorizontal,
  Columns3,
  Download,
  GripVertical,
  Images,
  RotateCcw,
  Merge,
  Rows3,
  LayoutGrid,
  List,
  Columns2,
  Save,
  Trash2,
  Briefcase,
  Flame,
  Hammer,
  Clock,
  ExternalLink,
} from "lucide-react";
import { MetricStrip } from "@/components/metric-strip";

type Search = {
  tab: "all" | "mine";
  q: string;
  stage: string; // pipeline stage id, "all" = any
  loss: JobLossType | "all";
  type: string;
  source: string;
  hideClosed: boolean;
  page: number;
  density: "comfortable" | "compact";
  view: "table" | "boxes" | "board";
  /** "" = not chosen, resolve to the viewer's own office; "all" = every office. */
  loc: string;
};

const PAGE_SIZE = 25;

const defaults: Search = {
  tab: "all",
  q: "",
  stage: "all",
  loss: "all",
  type: "all",
  source: "all",
  hideClosed: true,
  page: 1,
  density: "comfortable",
  view: "table",
  loc: "",
};

export const Route = createFileRoute("/_authenticated/jobs/")({
  head: () => ({
    meta: [
      { title: "Jobs · Recovery Hub" },
      { name: "description", content: "Active and closed jobs across locations." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput): Search => ({
    tab: raw.tab === "mine" ? "mine" : "all",
    q: typeof raw.q === "string" ? raw.q : "",
    stage: typeof raw.stage === "string" ? raw.stage : "all",
    loss: typeof raw.loss === "string" ? (raw.loss as Search["loss"]) : "all",
    type: typeof raw.type === "string" ? raw.type : "all",
    source: typeof raw.source === "string" ? raw.source : "all",
    hideClosed:
      raw.hideClosed === undefined ? true : raw.hideClosed === true || raw.hideClosed === "true",
    page: Number(raw.page) > 0 ? Number(raw.page) : 1,
    density: raw.density === "compact" ? "compact" : "comfortable",
    view: raw.view === "boxes" || raw.view === "board" ? raw.view : "table",
    loc: typeof raw.loc === "string" ? raw.loc : "",
  }),
  component: JobsBoard,
});

type Row = {
  id: string;
  job_number: string;
  job_name: string | null;
  job_type: string | null;
  customer_name: string | null;
  address: string;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  county: string | null;
  location_id: string;
  loss_type: JobLossType | null;
  loss_type_id: string | null;
  status: JobStatus;
  stage_id: string | null;
  call_date: string | null;
  loss_date: string | null;
  reported_source_id: string | null;
  insurance_carrier: string | null;
  estimated_amount: number | null;
  billed_amount: number | null;
  created_at: string;
  additional_work_pending: boolean;
  scope: string | null;
  stage_entered_at: string | null;
};

type SavedFilter = { id: string; name: string; filters: Partial<Search> };

const sel = (s: string): string => s;
const SELECT =
  "id, job_number, job_name, job_type, customer_name, address, locality, region, postal_code, county, location_id, loss_type, loss_type_id, status, stage_id, call_date, loss_date, reported_source_id, insurance_carrier, estimated_amount, billed_amount, created_at, additional_work_pending, scope, stage_entered_at";

/** Legacy per-browser column choice, carried over once into the per-user row. */
const COLS_KEY = "rh.jobs.columns";
const JOBS_TABLE_KEY = "jobs";
const ALL_JOB_COLUMN_KEYS = JOB_COLUMNS.map((c) => c.key);
const isJobColumnKey = (k: string): k is JobColumnKey =>
  (ALL_JOB_COLUMN_KEYS as string[]).includes(k);

/**
 * `unknown` is not a fourth colour for decoration — it is the state for data we
 * could not load. A code that guesses is worse than one that is absent.
 */
type CodeTone = "ok" | "attention" | "neutral" | "unknown";

const CODE_TONE: Record<CodeTone, string> = {
  ok: "bg-success/15 text-success",
  attention: "bg-destructive/15 text-destructive",
  neutral: "bg-muted text-muted-foreground",
  unknown: "bg-muted text-muted-foreground opacity-60",
};

/** Per-row facts that do not live on `jobs`, bulk-loaded for the visible page. */
type CodeExtras = {
  equipmentOnSite: number | null;
  photos: number | null;
  /** A signed contract or service agreement exists. `null` = could not be read. */
  contractSigned: boolean | null;
};

type JobCodeDef = {
  code: string;
  /** Shown on hover. A row of cryptic letters teaches nobody anything. */
  title: string;
  resolve: (row: Row, extras: CodeExtras) => { tone: CodeTone; label?: string };
};

/**
 * Every code here is backed by a real column. `REF`, `A`, `24` and `ESE` were
 * asked for but never defined, and a green light against a guessed meaning is
 * worse than a missing one — they land here once someone says what they mean
 * and which column answers it.
 */
const JOB_CODES: JobCodeDef[] = [
  {
    code: "SCP",
    title: "SCP — scope written. Green once the job's scope has text, red while it is blank.",
    resolve: (r) => ({ tone: r.scope?.trim() ? "ok" : "attention" }),
  },
  {
    code: "AWP",
    title:
      "AWP — additional work pending. Red while extra work is still outstanding on this job, green when none is.",
    resolve: (r) => ({ tone: r.additional_work_pending ? "attention" : "ok" }),
  },
  {
    code: "EQ",
    title:
      "EQ — equipment still on site: placements on this job with no retrieval date. A count, not a pass or fail. EQ:? means the count could not be loaded.",
    resolve: (_r, x) => ({
      tone: x.equipmentOnSite == null ? "unknown" : "neutral",
      label: `EQ:${x.equipmentOnSite ?? "?"}`,
    }),
  },
  {
    code: "CTR",
    title:
      "CTR — contract signed. Green once a contract or service agreement on this job carries a signature (documents.signed_at), red until then. Grayed when the documents could not be read.",
    resolve: (_r, x) => ({
      tone: x.contractSigned == null ? "unknown" : x.contractSigned ? "ok" : "attention",
    }),
  },
];

/**
 * The picture indicator.
 *
 * Not a code, so it is an icon and a number rather than three letters — "are
 * there photos, and how many" is answered faster by a camera than by `PIC:4`.
 *
 * Red at zero, green with the count. This used to render nothing at zero, on
 * the theory that an unphotographed job is the normal early state and a 0 on
 * half the rows is noise. The office asked for the opposite: a job with no
 * pictures is the job that cannot be defended to a carrier, and they want it
 * to stand out in the same red the other missing things do. A count that
 * could not be read is not zero, and says so with `?`, exactly as EQ does.
 *
 * Deliberately not a link. Every other chip in this cluster is inert and the
 * whole row already navigates to the job; a single chip that jumps somewhere
 * else is a trap for anyone who clicks near it.
 */
function PhotoChip({ count }: { count: number | null }) {
  const tone: CodeTone = count == null ? "unknown" : count > 0 ? "ok" : "attention";
  return (
    <span
      className={`pill pill-tight font-mono tabular-nums ${CODE_TONE[tone]}`}
      title={
        count == null
          ? "The picture count could not be loaded — this is not a job with no pictures."
          : count === 0
            ? "No pictures on this job yet."
            : `${count} picture${count === 1 ? "" : "s"} on this job.`
      }
    >
      <Images className="mr-0.5 inline size-3 align-[-2px]" aria-hidden />
      {count ?? "?"}
      <span className="sr-only">
        {count == null ? " pictures, count unavailable" : " pictures"}
      </span>
    </span>
  );
}

/*
 * One line, always. The row is read as a pattern — this one red, that one
 * green — and a pattern that wraps onto a second line at some widths is two
 * patterns. So the pills sit closer together than elsewhere and the row
 * never wraps; a cell grows before a chip drops.
 */
function JobCodes({
  row,
  equipmentOnSite,
  photos,
  contractSigned,
}: {
  row: Row;
  equipmentOnSite: number | null;
  photos: number | null;
  contractSigned: boolean | null;
}) {
  const days = daysSince(row.stage_entered_at);
  return (
    <div className="flex flex-nowrap items-center gap-0.5">
      {JOB_CODES.map((d) => {
        const { tone, label } = d.resolve(row, { equipmentOnSite, photos, contractSigned });
        return (
          <span
            key={d.code}
            className={`pill pill-tight font-mono ${CODE_TONE[tone]}`}
            title={d.title}
          >
            {label ?? d.code}
          </span>
        );
      })}
      <PhotoChip count={photos} />
      <span
        className="pill pill-tight bg-muted font-mono tabular-nums text-muted-foreground"
        title={
          days == null
            ? "Time in status is unknown — this job has no record of when it entered its current stage."
            : `In this status for ${days} day${days === 1 ? "" : "s"}.`
        }
      >
        {days == null ? "?D" : `${days}D`}
      </span>
    </div>
  );
}

/** Money columns disappear entirely for rep-grade roles — nothing masked, nothing hinted. */
const MONEY_COLUMNS: JobColumnKey[] = ["estimated_amount", "billed_amount"];

function JobsBoard() {
  const app = useAppContext();
  // No job-creating role: no "New job" button at all.
  const canCreateJob = useJobCreatableLocations().length > 0;
  const showMoney = useCan("job.view_costs");
  const exportGate = useExportGate();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const setSearch = (patch: Partial<Search>) =>
    navigate({
      to: "/jobs",
      search: ((p: Search) => ({ ...p, page: patch.page ?? 1, ...patch })) as never,
    });
  const resetFilters = () => setSearch({ ...defaults });

  /*
   * The search box keeps its own text and pushes it to the URL on a short delay.
   *
   * It was bound straight to the search param — `value={search.q}` with an
   * onChange that navigated on every keystroke. A router navigation does not
   * land synchronously, so anyone typing at speed raced it: each keystroke
   * re-rendered the input from a `search.q` that had not caught up, and the
   * letters already typed were thrown away. Typing "GS-2026" left "6" in the
   * box, while setting the same string in one assignment always survived —
   * the signature of this race rather than of the filter itself.
   */
  const [queryDraft, setQueryDraft] = useState(search.q);
  // The last value this box put into the URL, so its own echo coming back is
  // not mistaken for somebody else changing the filter.
  const pushedQuery = useRef(search.q);

  useEffect(() => {
    // Changed from outside the box: Reset filters, a saved view, the back button.
    if (search.q === pushedQuery.current) return;
    pushedQuery.current = search.q;
    setQueryDraft(search.q);
  }, [search.q]);

  useEffect(() => {
    if (queryDraft === pushedQuery.current) return;
    const timer = window.setTimeout(() => {
      pushedQuery.current = queryDraft;
      setSearch({ q: queryDraft });
    }, 250);
    return () => window.clearTimeout(timer);
    // `setSearch` is rebuilt every render; depending on it would restart the
    // timer on each keystroke's re-render and never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryDraft]);

  /*
   * One office, resolved once: the stage and loss-type vocabularies, the KPI
   * counts, the rows and the Excel export all read it, so the figures at the
   * top can never describe a different set of jobs than the table underneath.
   * Defaults to the viewer's own office rather than to all twelve.
   */
  const officeChoice = useLocationChoice(search.loc);
  const officeId = locationIdOf(officeChoice);
  // View as person: "All" means all of THEIR offices, not all of the admin's.
  const previewOffices = usePreviewOfficeScope();
  const officeName = locationLabel(officeChoice, app.visibleLocations);

  const { stages, stageById } = useJobStages(officeId);
  const lossTypes = useLossTypes(officeId);
  const paymentTypes = usePaymentTypes();
  const [movingId, setMovingId] = useState<string | null>(null);
  /*
   * David, 22 Sep: "you click on a job, we're still having the split
   * screen... that should take you into the thing right away. The full view
   * should be the full view." Every row, card and tile goes straight to the
   * record. The list's page and filters live in the URL, so Back returns to
   * the same page of the same filtered list.
   */
  const openJob = (id: string) =>
    navigate({ to: "/jobs/$id", params: { id }, search: {} as never });
  const availableColumns = showMoney
    ? JOB_COLUMNS
    : JOB_COLUMNS.filter((c) => !MONEY_COLUMNS.includes(c.key));

  const [rows, setRows] = useState<Row[]>([]);
  /** Equipment on site per visible job. `null` = never loaded, so EQ reads `?`. */
  const [equipOnSite, setEquipOnSite] = useState<Map<string, number> | null>(null);
  /** Pictures per visible job. `null` = could not be counted, never "none". */
  const [photoCounts, setPhotoCounts] = useState<Map<string, number> | null>(null);
  /** Jobs with a signed contract on file. `null` = the read failed, so CTR greys out. */
  const [contractSigned, setContractSigned] = useState<Map<string, boolean> | null>(null);
  const [total, setTotal] = useState(0);
  /** Jobs one toggle away, so an empty "My Jobs" never reads as an empty screen. */
  const [allScopeTotal, setAllScopeTotal] = useState(0);

  const [loading, setLoading] = useState(true);
  /** A failed query must never render as "no jobs match" — that reads as data loss. */
  const [loadError, setLoadError] = useState<unknown>(null);
  const [sources, setSources] = useState<{ id: string; code: string; label: string }[]>([]);
  const [saved, setSaved] = useState<SavedFilter[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<string>("");
  const [merging, setMerging] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [cols, setCols] = useState<JobColumnKey[]>(DEFAULT_JOB_COLUMNS);
  const [colOrder, setColOrder] = useState<JobColumnKey[]>(ALL_JOB_COLUMN_KEYS);
  const [sortKey, setSortKey] = useState<JobColumnKey | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  /** Rows are ordered by the database, so the first query waits for the choice. */
  const [prefsRead, setPrefsRead] = useState(false);
  /**
   * Only true when the saved view was actually read. A failed read must not be
   * followed by a save, or the layout we could not load is overwritten with a
   * default and gone for good.
   */
  const [prefsWritable, setPrefsWritable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchTablePrefs(JOBS_TABLE_KEY).then(({ ok, prefs }) => {
      if (cancelled) return;
      if (ok && prefs) {
        const saved = (prefs.visible ?? []).filter(isJobColumnKey);
        if (saved.length) {
          // A column shipped since this view was saved stays visible if the
          // table shows it by default — otherwise nobody who ever touched
          // the picker would see a new column again.
          const seen = new Set(saved);
          setCols([...saved, ...DEFAULT_JOB_COLUMNS.filter((k) => !seen.has(k))]);
        }
        setColOrder(
          mergeColumnOrder(ALL_JOB_COLUMN_KEYS, (prefs.order ?? []).filter(isJobColumnKey)),
        );
        const key = prefs.sortKey ?? null;
        setSortKey(key && isJobColumnKey(key) ? key : null);
        if (prefs.sortDir) setSortDir(prefs.sortDir);
      } else if (ok) {
        // First run on the per-user row: adopt whatever this browser had, so
        // nobody's existing column choice disappears on the way over.
        try {
          const raw = localStorage.getItem(COLS_KEY);
          const parsed = raw ? (JSON.parse(raw) as string[]) : null;
          const legacy = Array.isArray(parsed) ? parsed.filter(isJobColumnKey) : [];
          if (legacy.length) setCols(legacy);
        } catch {
          /* a browser that refuses localStorage just gets the defaults */
        }
      }
      setPrefsWritable(ok);
      setPrefsRead(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!prefsWritable) return;
    const t = setTimeout(() => {
      void saveTablePrefs(JOBS_TABLE_KEY, {
        visible: cols,
        order: colOrder,
        sortKey,
        sortDir,
      });
    }, 600);
    return () => clearTimeout(t);
  }, [prefsWritable, cols, colOrder, sortKey, sortDir]);

  /**
   * Reconciled every render rather than only on restore: the money columns
   * appear and disappear with a permission, and a saved order that predates
   * either change must still place every column the table has today.
   */
  const orderedColumns = useMemo(() => {
    const byKey = new Map(availableColumns.map((c) => [c.key, c]));
    const keys = availableColumns.map((c) => c.key);
    return mergeColumnOrder(keys, colOrder).map((k) => byKey.get(k)!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMoney, colOrder]);

  const shownColumns = useMemo(
    () => orderedColumns.filter((c) => cols.includes(c.key)),
    [orderedColumns, cols],
  );
  /** What the Sort control offers: every column the database can order by. */
  const sortableColumns = useMemo(() => orderedColumns.filter((c) => c.sort), [orderedColumns]);

  const toggleSort = (key: JobColumnKey) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
    // Page 4 of the old order is not page 4 of the new one, and the row you
    // were looking for is now on page 1.
    if (search.page !== 1) setSearch({ page: 1 });
  };

  useEffect(() => {
    (async () => {
      const [srcRes, savedRes] = await Promise.all([
        supabase
          .from("reported_sources")
          .select("id, code, label")
          .eq("active", true)
          .order("sort_order"),
        app.userId
          ? supabase.from("job_saved_filters").select("id, name, filters").order("name")
          : Promise.resolve({ data: [] }),
      ]);
      setSources(srcRes.data ?? []);
      setSaved((savedRes.data ?? []) as SavedFilter[]);
    })();
  }, [app.userId]);

  const [kpi, setKpi] = useState({ active: 0, emergency: 0, recon: 0, stale: 0 });

  useEffect(() => {
    (async () => {
      const base = () => {
        let q = supabase.from("jobs").select("id", { count: "exact", head: true });
        if (officeId) q = q.eq("location_id", officeId);
        else if (previewOffices) q = q.in("location_id", previewOffices);
        return q.not("status", "in", `(${CLOSED_STATUSES.join(",")})`);
      };
      const staleSince = new Date(Date.now() - 14 * 86400000).toISOString();
      const [a, e, r, s] = await Promise.all([
        base(),
        base().in("status", ["new", "scheduled"]),
        base().in("status", ["in_progress", "drying"]),
        base().lt("created_at", staleSince),
      ]);
      setKpi({
        active: a.count ?? 0,
        emergency: e.count ?? 0,
        recon: r.count ?? 0,
        stale: s.count ?? 0,
      });
    })();
  }, [officeId, previewOffices]);

  const load = useCallback(async () => {
    // The database does the ordering, so asking before the saved sort is known
    // would fetch page 1 of the wrong order and then throw it away.
    if (!prefsRead) return;

    setLoading(true);
    let mineIds: string[] | null = null;
    // "My jobs" is the viewed person's under View As — read scope only.
    const me = app.viewerUserId;
    if (search.tab === "mine" && me) {
      const { data } = await supabase.from("job_assignments").select("job_id").eq("user_id", me);
      mineIds = (data ?? []).map((r) => r.job_id);
    }

    const from = (search.page - 1) * PAGE_SIZE;
    /*
     * Sorting is done by the database because the list is paged: sorting the
     * 25 rows already on screen would reorder a page, not the list, and the
     * top of a "sort by billed amount" would be whatever page you happened to
     * be on. Money columns are only sortable for people who can see them.
     */
    const sortCol = JOB_COLUMNS.find(
      (c) => c.key === sortKey && (showMoney || !MONEY_COLUMNS.includes(c.key)),
    )?.sort;
    const build = (withSite: boolean) => {
      let q = supabase.from("jobs").select(sel(SELECT), { count: "exact" });
      if (sortCol) q = q.order(sortCol, { ascending: sortDir === "asc", nullsFirst: false });
      // Always a deterministic tiebreaker, or rows shuffle between page turns.
      q = q.order("created_at", { ascending: false }).range(from, from + PAGE_SIZE - 1);

      if (officeId) q = q.eq("location_id", officeId);
      else if (previewOffices) q = q.in("location_id", previewOffices);
      if (search.stage !== "all") q = q.eq("stage_id", search.stage);
      if (search.loss !== "all") q = q.eq("loss_type_id", search.loss);
      if (search.type !== "all") q = q.eq("job_type", search.type);
      if (search.source !== "all") q = q.eq("reported_source_id", search.source);
      if (search.hideClosed) q = q.not("status", "in", `(${CLOSED_STATUSES.join(",")})`);
      if (search.q.trim()) {
        const t = search.q.trim().replace(/[(),]/g, "");
        // Community, building and facility names too (David, 21 Oct) — once
        // the columns exist; see job-site-names.ts.
        q = q.or(jobSearchOr(t, withSite));
      }
      if (search.tab === "mine") {
        if (mineIds && mineIds.length) {
          q = q.or(`id.in.(${mineIds.join(",")}),created_by.eq.${me}`);
        } else if (me) {
          q = q.eq("created_by", me);
        }
      }
      return q;
    };
    let res = await build(siteSearch.on).returns<Row[]>();
    if (res.error && siteSearch.on && search.q.trim() && isMissingSchema(res.error)) {
      siteSearch.on = false;
      res = await build(false).returns<Row[]>();
    }
    const { data, count, error } = res;
    setLoadError(error ?? null);
    if (error) toastDbError(error, { action: "Loading jobs" });
    const jobRows = data ?? [];
    setRows(jobRows);
    setTotal(count ?? 0);

    /*
     * One query for the whole page, tallied client-side. A count per row would
     * be 25 round trips on every filter change, every page turn.
     */
    if (jobRows.length) {
      const ids = jobRows.map((r) => r.id);
      const [eqRes, photos, docRes] = await Promise.all([
        supabase
          .from("equipment_placements")
          .select("job_id")
          .in("job_id", ids)
          .is("retrieved_at", null),
        loadJobPhotoCounts(ids),
        // The two types the signing flow writes (see contract-signing.ts).
        // A voided contract keeps its signed_at, so status is checked too.
        supabase
          .from("documents")
          .select("job_id, status, signed_at")
          .in("job_id", ids)
          .in("doc_type", ["contract", "service_agreement"]),
      ]);
      const { data: eq, error: eqErr } = eqRes;
      if (eqErr || !eq) {
        // null, not an empty map: EQ:? beats a confident EQ:0.
        setEquipOnSite(null);
      } else {
        const tally = new Map<string, number>();
        for (const p of eq) tally.set(p.job_id, (tally.get(p.job_id) ?? 0) + 1);
        setEquipOnSite(tally);
      }
      setPhotoCounts(photos);
      const { data: docs, error: docErr } = docRes;
      if (docErr || !docs) {
        // null again: a grey CTR is honest, a red one on a job that has a
        // contract is a phone call nobody needed to make.
        setContractSigned(null);
      } else {
        const signed = new Map<string, boolean>();
        for (const d of docs) {
          if (!d.job_id) continue;
          const isSigned = (d.status === "signed" || !!d.signed_at) && d.status !== "void";
          signed.set(d.job_id, (signed.get(d.job_id) ?? false) || isSigned);
        }
        setContractSigned(signed);
      }
    } else {
      setEquipOnSite(new Map());
      setPhotoCounts(new Map());
      setContractSigned(new Map());
    }

    if (search.tab === "mine" && (count ?? 0) === 0) {
      let allQ = supabase.from("jobs").select("id", { count: "exact", head: true });
      if (officeId) allQ = allQ.eq("location_id", officeId);
      const { count: allCount } = await allQ;
      setAllScopeTotal(allCount ?? 0);
    } else {
      setAllScopeTotal(0);
    }

    setSelected([]);
    setLoading(false);
  }, [
    officeId,
    previewOffices,
    app.viewerUserId,
    search.tab,
    search.stage,
    search.loss,
    search.type,
    search.source,
    search.hideClosed,
    search.q,
    search.page,
    prefsRead,
    sortKey,
    sortDir,
    showMoney,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  const sourceById = useMemo(
    () => new Map(sources.map((s) => [s.id, s.label] as const)),
    [sources],
  );

  /*
   * Counts what the Filters control itself holds. Search is its own visible box
   * and is deliberately excluded — a badge that reads "1" purely because you
   * typed in the search field teaches people to ignore the badge.
   */
  const activeFilters = useMemo(() => {
    let n = 0;
    if (search.stage !== "all") n++;
    if (search.loss !== "all") n++;
    if (search.type !== "all") n++;
    if (search.source !== "all") n++;
    if (!search.hideClosed) n++;
    return n;
  }, [search]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const dense = search.density === "compact";

  const equipFor = (id: string) => (equipOnSite ? (equipOnSite.get(id) ?? 0) : null);
  const photosFor = (id: string) => (photoCounts ? (photoCounts.get(id) ?? 0) : null);
  const contractFor = (id: string) => (contractSigned ? (contractSigned.get(id) ?? false) : null);

  const cell = (r: Row, key: JobColumnKey) => {
    switch (key) {
      case "codes":
        return (
          <JobCodes
            row={r}
            equipmentOnSite={equipFor(r.id)}
            photos={photosFor(r.id)}
            contractSigned={contractFor(r.id)}
          />
        );
      case "job_number":
        return <span className="font-mono text-xs">{r.job_number}</span>;
      case "job_name":
        // As the job page titles it: its name, else customer, else address.
        return jobDisplayName(r) ?? "—";
      case "job_type":
        return (
          <span className={`pill ${paymentTypes.tone(r.job_type)}`}>
            {paymentTypes.label(r.job_type)}
          </span>
        );
      case "status":
        return <StageBadge stage={stageById.get(r.stage_id ?? "")} />;
      case "call_date":
        return fmtDate(r.call_date);
      case "loss_date":
        return fmtDate(r.loss_date);
      case "customer_name":
        return r.customer_name ?? "—";
      case "address":
        return <span className="block max-w-[220px] truncate">{r.address}</span>;
      case "locality":
        return r.locality ?? "—";
      case "region":
        return r.region ?? "—";
      case "postal_code":
        return r.postal_code ?? "—";
      case "county":
        return r.county ?? "—";
      case "loss_type":
        return (
          <span className={`pill ${lossTypes.badge(r.loss_type_id)}`}>
            {lossTypes.label(r.loss_type_id)}
          </span>
        );
      case "reported_source":
        return r.reported_source_id ? (sourceById.get(r.reported_source_id) ?? "—") : "—";
      case "insurance_carrier":
        return r.insurance_carrier ?? "—";
      case "estimated_amount":
        return fmtMoney(r.estimated_amount);
      case "billed_amount":
        return fmtMoney(r.billed_amount);
      case "created_at":
        return fmtDate(r.created_at);
      default:
        return "—";
    }
  };

  const exportCsv = () => {
    void exportGate.runExport({
      surface: "jobs",
      entity: "jobs",
      recordCount: rows.length,
      filters: { ...search },
      download: () => buildJobsCsv(),
    });
  };

  const buildJobsCsv = () => {
    // The export follows the columns as arranged on screen, order included.
    const shown = shownColumns;
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const plain = (r: Row, key: JobColumnKey): string => {
      switch (key) {
        case "status":
          return stageById.get(r.stage_id ?? "")?.name ?? "";
        case "loss_type":
          return lossTypes.label(r.loss_type_id);
        case "job_type":
          return paymentTypes.label(r.job_type);
        case "reported_source":
          return r.reported_source_id ? (sourceById.get(r.reported_source_id) ?? "") : "";
        default:
          return String((r as Record<string, unknown>)[key] ?? "");
      }
    };
    const lines = [
      shown.map((c) => esc(c.label)).join(","),
      ...rows.map((r) => shown.map((c) => esc(plain(r, c.key))).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jobs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Excel gets the same columns in the same order as the CSV, but typed: money
   * stays numeric, dates stay dates. The customer (company) column is always
   * present even when hidden on screen — that is how the file gets filtered.
   */
  const excelColumns = (): ExportColumn<Row>[] => {
    const keys = shownColumns.map((c) => c.key);
    const cols = keys.includes("customer_name")
      ? shownColumns
      : [...shownColumns, JOB_COLUMNS.find((c) => c.key === "customer_name")!];
    return cols.map((c) => {
      switch (c.key) {
        case "status":
          return {
            key: c.key,
            label: c.label,
            get: (r) => stageById.get(r.stage_id ?? "")?.name ?? "",
          };
        case "loss_type":
          return { key: c.key, label: c.label, get: (r) => lossTypes.label(r.loss_type_id) };
        case "job_type":
          return { key: c.key, label: c.label, get: (r) => paymentTypes.label(r.job_type) };
        case "reported_source":
          return {
            key: c.key,
            label: c.label,
            get: (r) => (r.reported_source_id ? (sourceById.get(r.reported_source_id) ?? "") : ""),
          };
        case "estimated_amount":
          return { key: c.key, label: c.label, get: (r) => r.estimated_amount, type: "money" };
        case "billed_amount":
          return { key: c.key, label: c.label, get: (r) => r.billed_amount, type: "money" };
        case "call_date":
          return { key: c.key, label: c.label, get: (r) => r.call_date, type: "date" };
        case "created_at":
          return { key: c.key, label: c.label, get: (r) => r.created_at, type: "datetime" };
        case "codes":
          return { key: c.key, label: c.label, get: () => "" };
        default:
          return {
            key: c.key,
            label: c.label,
            get: (r) => {
              const v = (r as Record<string, unknown>)[c.key];
              return v == null ? "" : String(v);
            },
          };
      }
    });
  };

  const saveFilterSet = async () => {
    const name = saveName.trim();
    if (!name || !app.userId) return;
    const filters: Partial<Search> = {
      q: search.q,
      stage: search.stage,
      loss: search.loss,
      type: search.type,
      source: search.source,
      hideClosed: search.hideClosed,
      tab: search.tab,
    };
    const { data, error } = await supabase
      .from("job_saved_filters")
      .upsert({ user_id: app.userId, name, filters }, { onConflict: "user_id,name" })
      .select("id, name, filters")
      .maybeSingle();
    if (error || !data) return toastDbError(error, { action: "Saving filter set" });
    setSaved((prev) => [...prev.filter((s) => s.name !== name), data as SavedFilter]);
    setSaveName("");
    toast.success("Filter set saved");
  };

  const deleteFilterSet = async (id: string) => {
    const { error } = await supabase.from("job_saved_filters").delete().eq("id", id);
    if (error) return toastDbError(error, { action: "Deleting filter set" });
    setSaved((prev) => prev.filter((s) => s.id !== id));
  };

  const moveJob = async (card: JobCard, stageId: string) => {
    setMovingId(card.id);
    const prev = rows;
    setRows((rs) => rs.map((r) => (r.id === card.id ? { ...r, stage_id: stageId } : r)));
    const { error } = await supabase.from("jobs").update({ stage_id: stageId }).eq("id", card.id);
    setMovingId(null);
    if (error) {
      setRows(prev);
      toastDbError(error, { action: "Moving job" });
    }
  };

  const mergeJobs = async () => {
    if (!mergeTarget || selected.length < 2) return;
    setMerging(true);
    const losers = selected.filter((id) => id !== mergeTarget);
    try {
      /*
       * "photos" was in this list and has no job_id column - photos hang off
       * projects.job_id. The `as any` hid it from the typechecker and the
       * result was discarded, so merging two jobs silently left every photo
       * on a job that this function then cancels. Repointing the project is
       * what actually moves them; documents carry job_id directly.
       */
      for (const table of [
        "job_notes",
        "job_assignments",
        "job_contact_methods",
        "projects",
        "documents",
      ] as const) {
        const { error: moveError } = await supabase
          .from(table)
          .update({ job_id: mergeTarget })
          .in("job_id", losers);
        // Cancelling the losing jobs after a failed move would strand their
        // records on a cancelled job, so a failure has to stop the merge.
        if (moveError) throw moveError;
      }
      const { error } = await supabase
        .from("jobs")
        .update({ status: "cancelled" })
        .in("id", losers);
      if (error) throw error;
      await supabase.from("job_notes").insert(
        losers.map((id) => ({
          job_id: mergeTarget,
          author_id: app.userId,
          body: `Merged duplicate job ${id} into this record.`,
        })),
      );
      toast.success(`Merged ${losers.length} job${losers.length === 1 ? "" : "s"}`);
      setMergeOpen(false);
      load();
    } catch (e) {
      toastDbError(e, { action: "Merging jobs" });
    } finally {
      setMerging(false);
    }
  };

  /**
   * The filter body, defined once and rendered into two surfaces: a popover on
   * desktop and a bottom sheet on a phone. Two copies of these fields would
   * drift the moment a filter is added.
   */
  const filterFields = (
    <div className="space-y-3">
      <FilterSelect
        label="Status"
        value={search.stage}
        onChange={(v) => setSearch({ stage: v })}
        options={[
          ["all", "All statuses"],
          ...stages.map((s) => [s.id, s.name] as [string, string]),
        ]}
      />
      <FilterSelect
        label="Job type (payment)"
        value={search.type}
        onChange={(v) => setSearch({ type: v })}
        options={[
          ["all", "Cash and insurance"],
          ...paymentTypes.options.map((t) => [t.key, t.label] as [string, string]),
        ]}
      />
      <FilterSelect
        label="Loss type (service)"
        value={search.loss}
        onChange={(v) => setSearch({ loss: v as Search["loss"] })}
        options={[
          ["all", "All loss types"],
          ...lossTypes.options.map((s) => [s.id, s.label] as [string, string]),
        ]}
      />
      <FilterSelect
        label="Reported source"
        value={search.source}
        onChange={(v) => setSearch({ source: v })}
        options={[
          ["all", "All sources"],
          ...sources.map((s) => [s.id, s.label] as [string, string]),
        ]}
      />
      <label className="flex min-h-11 items-center justify-between rounded border px-2 md:min-h-0 md:p-2">
        <span className="text-xs font-medium">Hide closed jobs</span>
        <Switch checked={search.hideClosed} onCheckedChange={(v) => setSearch({ hideClosed: v })} />
      </label>
      <div className="space-y-2 border-t pt-2">
        <Label className="text-xs">Saved filter sets</Label>
        {saved.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            None yet — set filters, name them, and save.
          </p>
        ) : (
          <ul className="space-y-1">
            {saved.map((s) => (
              <li key={s.id} className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 flex-1 justify-start md:h-7"
                  onClick={() => setSearch({ ...defaults, ...s.filters })}
                >
                  {s.name}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 md:size-7"
                  aria-label={`Delete filter set ${s.name}`}
                  onClick={() => deleteFilterSet(s.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex gap-1">
          <Input
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            placeholder="Name this filter set"
            className="h-11 md:h-8"
          />
          <Button
            size="sm"
            className="h-11 md:h-8"
            onClick={saveFilterSet}
            disabled={!saveName.trim()}
            aria-label="Save filter set"
          >
            <Save className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );

  /** One job as a card — the phone list and the Boxes view render the same thing. */
  const jobTile = (r: Row) => (
    <div
      key={r.id}
      role="button"
      tabIndex={0}
      onClick={() => void openJob(r.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") void openJob(r.id);
      }}
      className="cursor-pointer rounded-[var(--radius-control)] border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-[var(--row-hover-bg)]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{r.job_number}</span>
        <StageBadge stage={stageById.get(r.stage_id ?? "")} />
      </div>
      <p className="mt-1 truncate text-[13px] font-semibold">
        {jobDisplayName(r) ?? "Untitled job"}
      </p>
      <p className="truncate text-xs text-muted-foreground">{r.customer_name ?? "—"}</p>
      <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
        {[r.address, r.locality, r.region].filter(Boolean).join(", ") || "No address"}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
        <span className={`pill ${lossTypes.badge(r.loss_type_id)}`}>
          {lossTypes.label(r.loss_type_id)}
        </span>
        <span className={`pill ${paymentTypes.tone(r.job_type)}`}>
          {paymentTypes.label(r.job_type)}
        </span>
        <span className="ml-auto">{fmtDate(r.call_date)}</span>
      </div>
      {/* The status codes are the reason to glance at this list at all — for
          the people who read them. The column picker's "Status codes" switch
          is honoured here too, so someone who turned them off in the table is
          not shown them again on every card. */}
      {cols.includes("codes") && (
        <div className="mt-1.5">
          <JobCodes
            row={r}
            equipmentOnSite={equipFor(r.id)}
            photos={photosFor(r.id)}
            contractSigned={contractFor(r.id)}
          />
        </div>
      )}
      {showMoney && (r.estimated_amount != null || r.billed_amount != null) && (
        <div className="mt-2 flex items-center justify-between border-t pt-2 text-xs tabular-nums">
          <span className="text-muted-foreground">Estimated</span>
          <span className="font-medium">{fmtMoney(r.estimated_amount)}</span>
        </div>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-[110rem] space-y-3 px-4 py-5 pb-32 md:pb-24">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="display-heavy text-[22px] leading-tight">Jobs</h1>
          <p className="text-sm text-muted-foreground">
            {loading ? "Loading…" : `${total} job${total === 1 ? "" : "s"}`}
            {search.hideClosed && " · closed hidden"}
          </p>
        </div>
        {/* Two label-bearing tab groups plus a button is a wall at 390px, so the
            view switcher drops to icons and the scope tabs shorten. */}
        <div className="flex w-full items-center gap-2 md:w-auto">
          <Tabs value={search.tab} onValueChange={(v) => setSearch({ tab: v as Search["tab"] })}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="mine">Mine</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs
            value={search.view}
            onValueChange={(v) => setSearch({ view: v as Search["view"], page: search.page })}
          >
            <TabsList>
              <TabsTrigger value="table" title="Table view" aria-label="Table view">
                <List className="size-4 md:mr-1.5" />
                <span className="hidden md:inline">Table</span>
              </TabsTrigger>
              <TabsTrigger value="boxes" title="Box view" aria-label="Box view">
                <LayoutGrid className="size-4 md:mr-1.5" />
                <span className="hidden md:inline">Boxes</span>
              </TabsTrigger>
              <TabsTrigger value="board" title="Board view" aria-label="Board view">
                <Columns2 className="size-4 md:mr-1.5" />
                <span className="hidden md:inline">Board</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {canCreateJob && (
            <Button asChild size="sm" className="ml-auto h-11 md:ml-0 md:h-8">
              {/* "Job" left it ambiguous next to a Job Calculator in the same
                  menu. It says where it goes. */}
              <Link to="/jobs/new" search={{}}>
                <Plus className="mr-1.5 size-4" />
                New job
              </Link>
            </Button>
          )}
        </div>
      </div>

      <MetricStrip
        metrics={[
          { label: "Active jobs", value: kpi.active, icon: Briefcase },
          {
            label: "Emergency / intake",
            value: kpi.emergency,
            icon: Flame,
            tone: "warning",
            note: kpi.active ? `${Math.round((kpi.emergency / kpi.active) * 100)}% of active` : "",
          },
          {
            label: "In progress",
            value: kpi.recon,
            icon: Hammer,
            note: kpi.active ? `${Math.round((kpi.recon / kpi.active) * 100)}% of active` : "",
          },
          {
            label: "Open 14+ days",
            value: kpi.stale,
            icon: Clock,
            tone: kpi.stale > 0 ? "danger" : "default",
          },
        ]}
      />

      <EmptyScopeGuard
        scopedCount={total}
        unscopedCount={allScopeTotal}
        noun="jobs"
        scopedLabel="assigned to you"
        unscopedLabel="in this location"
        switchLabel="View all jobs"
        onSwitch={() => setSearch({ tab: "all" })}
      />

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <ReportLocationSelect
            value={officeChoice}
            onChange={(next) => setSearch({ loc: next, page: 1 })}
          />
          {/* Search is the primary action, so it never collapses behind a control. */}
          <Input
            value={queryDraft}
            onChange={(e) => setQueryDraft(e.target.value)}
            placeholder="Search job #, name, customer or address"
            className="h-11 w-full sm:h-9 sm:w-72"
          />

          {/*
           * Phone: every filter lives in a bottom sheet behind one 44px control.
           * The same fields render in the desktop popover below — one definition,
           * two surfaces, so the two can never drift apart.
           */}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" className="h-11 md:hidden">
                <SlidersHorizontal className="mr-1.5 size-4" />
                Filters
                {activeFilters > 0 && (
                  <Badge className="ml-1.5 h-5 min-w-5 justify-center px-1">{activeFilters}</Badge>
                )}
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="max-h-[85svh] gap-3 rounded-t-xl p-4">
              <SheetHeader className="text-left">
                <SheetTitle className="text-base">Filters</SheetTitle>
              </SheetHeader>
              {filterFields}
              <Button variant="outline" className="h-11 w-full" onClick={resetFilters}>
                <RotateCcw className="mr-1.5 size-4" />
                Reset filters
              </Button>
            </SheetContent>
          </Sheet>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="hidden md:inline-flex">
                <SlidersHorizontal className="mr-1.5 size-4" />
                Filters
                {activeFilters > 0 && (
                  <Badge className="ml-1.5 h-5 min-w-5 justify-center px-1">{activeFilters}</Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80 space-y-3">
              {filterFields}
            </PopoverContent>
          </Popover>

          {/*
           * Sort, for every view. The table header sorts by click, but the
           * box, board and phone card views have no header, so the same choice
           * lives here too — one state, two controls, so they can never
           * disagree. Only columns the database can order by are offered; see
           * JOB_COLUMNS for why status, loss type and source are not.
           */}
          <div className="flex items-center gap-1">
            <Select
              value={sortKey ?? "newest"}
              onValueChange={(v) => {
                if (v === "newest") setSortKey(null);
                else {
                  setSortKey(v as JobColumnKey);
                  setSortDir("asc");
                }
                if (search.page !== 1) setSearch({ page: 1 });
              }}
            >
              <SelectTrigger className="h-11 w-[10.5rem] sm:h-9 sm:w-40" aria-label="Sort by">
                <ArrowUpDown className="mr-1.5 size-3.5 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest first</SelectItem>
                {sortableColumns.map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              className="size-11 sm:size-9"
              disabled={!sortKey}
              aria-label={
                sortDir === "asc"
                  ? "Ascending — A to Z, oldest first. Switch to descending."
                  : "Descending — Z to A, newest first. Switch to ascending."
              }
              title={sortDir === "asc" ? "A to Z · oldest first" : "Z to A · newest first"}
              onClick={() => {
                setSortDir(sortDir === "asc" ? "desc" : "asc");
                if (search.page !== 1) setSearch({ page: 1 });
              }}
            >
              {sortDir === "asc" ? (
                <ArrowUp className="size-4" />
              ) : (
                <ArrowDown className="size-4" />
              )}
            </Button>
          </div>

          <Popover>
            <PopoverTrigger asChild>
              {/* Column choice is meaningless against the phone card layout. */}
              <Button variant="outline" size="sm" className="hidden md:inline-flex">
                <Columns3 className="mr-1.5 size-4" />
                Columns
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-60 p-0">
              <ColumnArranger
                columns={orderedColumns}
                visible={cols}
                onToggle={(key) =>
                  setCols(cols.includes(key) ? cols.filter((k) => k !== key) : [...cols, key])
                }
                onReorder={setColOrder}
                onReset={() => {
                  setCols(DEFAULT_JOB_COLUMNS);
                  setColOrder(ALL_JOB_COLUMN_KEYS);
                }}
              />
            </PopoverContent>
          </Popover>

          {/* Already inside the Filters surface — a second copy only fits on desktop. */}
          <label className="ml-auto hidden items-center gap-2 text-xs text-muted-foreground md:flex">
            Hide Closed Jobs
            <Switch
              checked={search.hideClosed}
              onCheckedChange={(v) => setSearch({ hideClosed: v })}
            />
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : loadError ? (
            /* A failed load is not an empty list. Say so, and offer the retry. */
            <div className="space-y-2 px-3 py-4 text-[13px]">
              <p className="font-medium text-destructive">Jobs could not be loaded.</p>
              <p className="text-muted-foreground">
                This is a connection or permission problem, not an empty list — no conclusion should
                be drawn from this screen.
              </p>
              <Button variant="outline" className="h-11 md:h-9" onClick={() => void load()}>
                <RotateCcw className="mr-1.5 size-4" />
                Try again
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-3 py-2.5 text-[13px] text-muted-foreground">
              {app.visibleLocations.length === 0 ? (
                "No location access. An admin must assign you to a location."
              ) : (
                <>
                  No jobs match these filters.{" "}
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    Reset filters
                  </button>
                </>
              )}
            </div>
          ) : search.view === "board" ? (
            <JobBoard
              stages={stages}
              cards={rows as JobCard[]}
              onOpen={(id) => void openJob(id)}
              onMove={(card, stage) => void moveJob(card, stage.id)}
              movingId={movingId}
              writesDisabled={app.writesDisabled}
              showMoney={showMoney}
            />
          ) : search.view === "boxes" ? (
            /* Box view: one card per job, scannable on a phone in a vehicle. */
            <div className="grid gap-2 p-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {rows.map(jobTile)}
            </div>
          ) : (
            <>
              {/*
               * Twelve truncated columns are unreadable at 390px, so the phone
               * gets the card form of the same rows. The saved column choice is
               * deliberately not consulted here — it describes a table that is
               * not on screen — and desktop still honours it below, untouched.
               * The one exception is the status-codes switch, which the card
               * reads: it is an opt-out of a row of chips, not a table layout.
               */}
              <div className="grid gap-2 p-3 md:hidden">{rows.map(jobTile)}</div>

              {/* Spreadsheet behaviour: header and the identity column stay put while you scan. */}
              <div className="hidden max-h-[calc(100vh-300px)] overflow-auto md:block">
                <Table className="text-[12.5px]">
                  <TableHeader className="sticky top-0 z-20">
                    <TableRow className="bg-muted/95 backdrop-blur">
                      <TableHead className="sticky left-0 z-30 w-8 bg-muted/95 backdrop-blur" />
                      {shownColumns.map((c, i) => (
                        <Fragment key={c.key}>
                          <TableHead
                            className={`whitespace-nowrap text-[11px] font-semibold uppercase tracking-wide ${
                              c.numeric ? "text-right" : ""
                            } ${i === 0 ? "sticky left-8 z-30 bg-muted/95 backdrop-blur" : ""}`}
                          >
                            {/* A column the database cannot order by shows no
                                control at all rather than one that does nothing. */}
                            {c.sort ? (
                              <button
                                type="button"
                                onClick={() => toggleSort(c.key)}
                                aria-label={`Sort by ${c.label}`}
                                className={`inline-flex items-center gap-1 uppercase hover:text-foreground ${
                                  c.numeric ? "flex-row-reverse" : ""
                                } ${sortKey === c.key ? "text-foreground" : ""}`}
                              >
                                {c.label}
                                {sortKey === c.key &&
                                  (sortDir === "asc" ? (
                                    <ArrowUp className="size-3" />
                                  ) : (
                                    <ArrowDown className="size-3" />
                                  ))}
                              </button>
                            ) : (
                              c.label
                            )}
                          </TableHead>
                        </Fragment>
                      ))}
                      {/* Quick-action gutter. Unlabelled — the controls under
                          it only appear on hover, so a heading would name a
                          column that is blank most of the time. */}
                      <TableHead className="w-[76px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow
                        key={r.id}
                        data-row
                        className="cursor-pointer"
                        onClick={() => void openJob(r.id)}
                      >
                        <TableCell
                          className={`sticky left-0 z-10 bg-background ${dense ? "py-1" : ""}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={selected.includes(r.id)}
                            onCheckedChange={(v) =>
                              setSelected((prev) =>
                                v ? [...prev, r.id] : prev.filter((i) => i !== r.id),
                              )
                            }
                          />
                        </TableCell>
                        {shownColumns.map((c, i) => (
                          <Fragment key={c.key}>
                            <TableCell
                              className={`${dense ? "py-1 text-xs" : "py-1.5"} ${
                                c.numeric ? "text-right tabular-nums" : ""
                              } ${i === 0 ? "sticky left-8 z-10 bg-background font-medium" : ""}`}
                            >
                              {cell(r, c.key)}
                            </TableCell>
                          </Fragment>
                        ))}
                        {/*
                         * Quick actions, revealed on row hover (`.row-actions`
                         * is opacity:0 until `[data-row]:hover` or keyboard
                         * focus). The row itself opens the record; this one
                         * opens it in a new tab, for comparing two jobs
                         * without losing the list.
                         */}
                        <TableCell
                          className={dense ? "py-1" : "py-1.5"}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span className="row-actions flex items-center justify-end gap-0.5">
                            <Button
                              asChild
                              size="sm"
                              variant="ghost"
                              className="size-7 p-0"
                              title="Open in a new tab"
                            >
                              <Link
                                to="/jobs/$id"
                                params={{ id: r.id }}
                                search={{} as never}
                                target="_blank"
                                rel="noopener"
                                aria-label={`Open ${r.job_number} in a new tab`}
                              >
                                <ExternalLink className="size-3.5" />
                              </Link>
                            </Button>
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/*
       * Parked above the app shell's fixed mobile nav bar so paging and the
       * record count are always reachable without any sideways scrolling.
       * Not a hard 54px either: the nav is taller than that and grows by the
       * home-indicator inset, so on a notched iPhone the pager sat ~40px
       * under it.
       *
       * `bottom-0`, NOT `above-mobile-nav`. This bar is sticky inside the app
       * shell's <main>, and <main> already reserves pb-[calc(4rem+env(safe-area-
       * inset-bottom))] below md for the fixed phone nav. A sticky element is held
       * inside its scroll container's padding edge, so bottom-0 already docks it
       * on top of the nav — notched iPhones included, since the padding carries
       * the same inset the nav does. above-mobile-nav (4rem) is for something
       * positioned against the VIEWPORT; here it counted the nav twice and
       * floated the bar 71px clear of it at 375px, rows showing underneath.
       */}
      <div className="sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-2 rounded-sm border bg-card p-2 shadow-[0_-1px_0_0_hsl(var(--border))]">
        <div className="flex flex-wrap items-center gap-2">
          {/* Reset lives in the Filters sheet on a phone; density and merge are
              table-only affordances and the table is not rendered there. */}
          <Button
            variant="outline"
            size="sm"
            className="hidden md:inline-flex"
            onClick={resetFilters}
          >
            <RotateCcw className="mr-1.5 size-4" />
            Reset filters
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="hidden md:inline-flex"
            onClick={() =>
              setSearch({ density: dense ? "comfortable" : "compact", page: search.page })
            }
          >
            <Rows3 className="mr-1.5 size-4" />
            {dense ? "Comfortable" : "Compact"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="hidden md:inline-flex"
            disabled={selected.length < 2 || app.writesDisabled}
            onClick={() => {
              setMergeTarget(selected[0]);
              setMergeOpen(true);
            }}
          >
            <Merge className="mr-1.5 size-4" />
            Merge{selected.length ? ` (${selected.length})` : ""}
          </Button>
          {exportGate.allowed && (
            <Button
              variant="outline"
              className="h-11 md:h-8"
              onClick={exportCsv}
              disabled={rows.length === 0}
            >
              <Download className="mr-1.5 size-4" />
              CSV
            </Button>
          )}
          <ExportExcelButton
            report="jobs"
            surface="jobs"
            entity="jobs"
            className="h-11 md:h-8"
            size="default"
            filters={{ ...search, office: officeName }}
            sheets={[{ name: "Jobs", rows, columns: excelColumns() }]}
          />
        </div>

        <div className="flex items-center gap-2 text-sm">
          <Button
            variant="outline"
            className="h-11 px-3 md:h-8"
            disabled={search.page <= 1}
            onClick={() => setSearch({ page: search.page - 1 })}
          >
            Prev
          </Button>
          <span className="whitespace-nowrap text-muted-foreground">
            {search.page} / {pages}
          </span>
          <Button
            variant="outline"
            className="h-11 px-3 md:h-8"
            disabled={search.page >= pages}
            onClick={() => setSearch({ page: search.page + 1 })}
          >
            Next
          </Button>
        </div>
      </div>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge jobs</DialogTitle>
            <DialogDescription>
              Notes, crew, contact methods and photos move to the job you keep. The others are
              canceled, not deleted, so the audit trail survives.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label className="text-xs">Keep this job</Label>
            <Select value={mergeTarget} onValueChange={setMergeTarget}>
              <SelectTrigger>
                <SelectValue placeholder="Choose the surviving job" />
              </SelectTrigger>
              <SelectContent>
                {selected.map((id) => {
                  const r = rows.find((x) => x.id === id);
                  return (
                    <SelectItem key={id} value={id}>
                      {r?.job_number} · {r ? jobDisplayName(r) : null}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMergeOpen(false)}>
              Cancel
            </Button>
            <Button onClick={mergeJobs} disabled={!mergeTarget || merging}>
              {merging ? "Merging…" : "Merge"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Show / hide and reorder, in one list.
 *
 * Reordering lives in this popover and not on the header cells: the table
 * scrolls sideways, and a drag begun on a header is the same gesture as the
 * two-finger or touch swipe that scrolls it — one would always steal the
 * other. A vertical list has no such conflict, is reachable from the keyboard,
 * and can move a column that is currently scrolled off screen. The control is
 * desktop-only for the same reason the Columns button is: below `md` this
 * screen renders cards, and there are no columns to arrange.
 */
function ColumnArranger({
  columns,
  visible,
  onToggle,
  onReorder,
  onReset,
}: {
  columns: { key: JobColumnKey; label: string }[];
  visible: JobColumnKey[];
  onToggle: (key: JobColumnKey) => void;
  onReorder: (keys: JobColumnKey[]) => void;
  onReset: () => void;
}) {
  const sensors = useSensors(
    // Without a threshold the drag handle would swallow plain clicks.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const keys = columns.map((c) => c.key);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = keys.indexOf(active.id as JobColumnKey);
    const to = keys.indexOf(over.id as JobColumnKey);
    if (from < 0 || to < 0) return;
    onReorder(arrayMove(keys, from, to));
  };

  return (
    <>
      <div className="border-b px-3 py-2 text-[11.5px] text-muted-foreground">
        Show columns · drag to reorder
      </div>
      <div className="max-h-80 overflow-y-auto py-1">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={keys} strategy={verticalListSortingStrategy}>
            {columns.map((c) => (
              <ColumnArrangerRow
                key={c.key}
                id={c.key}
                label={c.label}
                on={visible.includes(c.key)}
                onToggle={() => onToggle(c.key)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>
      <div className="border-t p-2">
        <Button size="sm" variant="ghost" className="h-7 w-full text-[12px]" onClick={onReset}>
          Reset columns
        </Button>
      </div>
    </>
  );
}

function ColumnArrangerRow({
  id,
  label,
  on,
  onToggle,
}: {
  id: JobColumnKey;
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`flex items-center gap-1 pr-2 text-sm ${
        isDragging ? "relative z-10 rounded bg-accent shadow-sm" : ""
      }`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}`}
        className="cursor-grab px-1.5 py-1.5 text-muted-foreground hover:text-foreground"
      >
        <GripVertical className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onToggle}
        className="flex flex-1 items-center gap-2 py-1.5 text-left hover:text-foreground"
      >
        <Checkbox checked={on} className="pointer-events-none size-3.5" />
        {label}
      </button>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <div className="grid gap-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map(([v, l]) => (
            <SelectItem key={v} value={v}>
              {l}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
