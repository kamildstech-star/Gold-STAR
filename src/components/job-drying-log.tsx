import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FocusEvent,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  Camera,
  CalendarDays,
  CloudOff,
  CloudSun,
  Flag,
  GripVertical,
  ImagePlus,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { useAppContext } from "@/components/app-context";
import { useLabelLanguage } from "@/components/bilingual";
import { DehuReadingsDrawer, type DehuPairEntry } from "@/components/drying-dehu-readings";
import { MaterialPointsDrawer } from "@/components/drying-material-points";
import { DryingDayChart } from "@/components/drying-day-chart";
import { DryingPsychroGrid } from "@/components/drying-psychro-grid";
import { TAB_STRIP, TAB_TRIGGER } from "@/components/ui/tabs";
import type { GridSave } from "@/lib/drying-psychro-grid";
import { DryingSummaryCard } from "@/components/drying-summary";
import { ExportExcelButton } from "@/components/export-excel-button";
import { DryingReportButton } from "@/components/drying-report-button";
import { DailyUpdateButton } from "@/components/daily-update-button";
import { DryingRoomSelect } from "@/components/drying-room-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import {
  compareToBaseline,
  describeBaselineAlignment,
  describeDelta,
  findBaselineSet,
} from "@/lib/drying-baseline";
import { loadDryingCardOrder, orderCards, saveDryingCardOrder } from "@/lib/drying-card-order";
import {
  buildDryingDayTiles,
  describeInsideCell,
  describeOutsideCell,
  describeOutsideSetup,
  outsideDaysToFill,
  tileFigures,
  type DryingDayTile,
  type OutsideContext,
} from "@/lib/drying-day-grid";
import { pairDehuReadings } from "@/lib/dehu-performance";
import { dehusOnSite, listDryingPlacements } from "@/lib/drying-equipment";
import { materialsByDay, summarizePoint, type MaterialsDay } from "@/lib/drying-materials";
import { listMoisture } from "@/lib/drying-materials-data";
import { dryingLogReportName, dryingLogWorkbook } from "@/lib/drying-log-export";
import { jobHoursTotal } from "@/lib/equipment-hours";
import {
  DEHU_POINTS,
  DRYING_POINT_LABEL,
  ENTRY_POINTS,
  MODELLED_EXTERIOR_LABEL,
  buildDryingLog,
  equipmentPickupDate,
  buildReadingRow,
  checkReadingEntry,
  describeOutsideReading,
  fetchAndStoreOutsideConditions,
  listDryingReadings,
  readingQueueLabel,
  signedMeterPhotoUrl,
  todayLocal,
  writeDryingReading,
  type DryingPoint,
  type DryingReading,
  type DryingReadingBlobs,
  type DryingReadingInsert,
} from "@/lib/drying-log";
import {
  prepareMeterPhoto,
  readMeterPhoto,
  applyMeterRead,
  type MeterPhoto,
} from "@/lib/drying-meter-photo";
import { UNIT_ANY, chooseUnit, unitOptions } from "@/lib/drying-room-picker";
import { toastDbError } from "@/lib/db-errors";
import { addJobRoom, type AlbumContext, type RoomFields } from "@/lib/job-room-add";
import { fetchJobRooms, roomLabel, type JobRoom } from "@/lib/job-rooms";
import { useCanManageJob } from "@/lib/use-can-manage-job";
import { saveJobField } from "@/lib/job-update";
import { enqueue, newId } from "@/lib/offline-queue";
import {
  OUTSIDE_MAX_BACKFILL_DAYS,
  OUTSIDE_MODELLED_NOTE,
  backfillPastDays,
  describeOutsideFetchFailure,
  outsideReadingNote,
  outsideReadingNotes,
  type OutsideFetchFailure,
} from "@/lib/outside-conditions";
import { derive } from "@/lib/psychrometrics";
import { isMissingSchema } from "@/lib/schema-fallback";
import { cn } from "@/lib/utils";
import { DryingClockCard } from "@/components/drying-clock-card";
import {
  WATER_CATEGORIES,
  describeWaterCategory,
  isGrosslyContaminated,
  parseWaterCategory,
} from "@/lib/water-category";
import { WATER_CLASSES, parseWaterClass } from "@/lib/water-class";
import { signedUrlStaleMs } from "@/lib/signed-url";

/**
 * The drying log — a day-by-day psychrometric record of the loss.
 *
 * The form matches the walk. A technician goes round the property once with a
 * meter and reads every point on that one pass, so every internal point is on
 * screen at once and one button saves the lot. Inside and affected rooms
 * repeat, because a job with three wet rooms has three affected readings and a
 * fixed single box would send the crew back to picking one point at a time.
 *
 * Outside is not one of those boxes. It is the same for every job at that
 * address on that day and no crew should be typing it, so it is fetched — see
 * the baseline panel below — with manual entry kept as an override for the days
 * a crew has a real thermo-hygrometer in the driveway, or the fetch fails.
 *
 * Typed one-handed in a basement: numeric keypads, 44px targets, today's date
 * prefilled, and a save with no signal held rather than lost. Dew point and
 * grains per pound are shown as they are calculated and never asked for.
 *
 * Laid out as a calendar. One small square per day, oldest first, coloured by
 * whether the day was logged, with the entry form for the tapped day directly
 * underneath — the shape the office asked for ("little squares, one day each,
 * and right under it a section to add each day"). The chart and the full table
 * stay below for the report; the squares are for the glance.
 *
 * 2026-09-04, Melly Chein
 * -----------------------
 * Four additions from her call, all of them about making a typed number stand
 * up as evidence:
 *
 *  - INSIDE beside OUTSIDE. "I need one for outside exterior, I need one for
 *    interior." Outside is fetched at nine each morning; inside is a meter a
 *    technician holds. Each day square now carries the pair, and the pair is
 *    the story — an inside dew point falling towards the outside one is a
 *    property drying.
 *  - THE WATER CATEGORY. Sink water is category 1, storm water 2, sewage 3,
 *    and the category decides whether a wet carpet is dried or binned. It sits
 *    at the top of the log because it governs everything below it.
 *  - THE BASELINE SET, taken at the start or when the equipment went in —
 *    "should really be the same time". Every later day is read against it, and
 *    the panel says so when it was inferred rather than declared.
 *  - A PHOTO OF THE METER with each reading, through the job photo module's
 *    encoder and the same offline queue as everything else. She asked whether
 *    the numbers could be read off the photo automatically: not yet, and the
 *    seam for it is `readMeterPhoto` in src/lib/drying-meter-photo.ts, already
 *    called on every photo attached here.
 *
 * All four need supabase/migrations/20260904090000_drying_interior_readings.sql.
 * It IS applied on the live database as of 2026-09-07, but the panel still
 * probes for the columns and holds those fields back where they are absent,
 * because a second deployment may be behind.
 *
 * 2026-09-07, Mark
 * ----------------
 *  - WHICH ROOM the inside reading was taken in. An interior reading may now
 *    name a room from the job's own room list — the same picker the affected
 *    chamber uses — and a day may carry one per room, added with "Add another
 *    room". The room is optional and "No room" still means the property as a
 *    whole. See WHOLE_PROPERTY in src/lib/drying-log.ts for what this did to
 *    the per-day model: a named room forks the series, and the day square shows
 *    the WETTEST inside reading, which is the same one the baseline delta uses.
 *  - THE CAMERA on the meter photo, and the outside conditions saying why they
 *    are missing — see MeterPhotoField and DayTile below.
 *  - NO UNAFFECTED SECTION. "remove the unaffacted section." The form no longer
 *    offers the control reading; the argument the log makes is now outside
 *    against inside and affected. The point itself is not deleted — see
 *    `entry` on DRYING_POINTS — so a row already logged under it keeps its
 *    column on the chart, in the table and in the baseline comparison.
 *  - NO DEHU OUTLET SECTION either: "remove this as well." Same treatment — off
 *    the form, still understood. The dehumidifier picker went with it, so the
 *    panel no longer reads equipment_placements for the machines on site.
 *  - THE ROOM ABOVE THE FIELDS ("for now room should be above"), with the UNIT
 *    beside it ("add a section for unit numbers") narrowing the room list on a
 *    multi-unit job — see src/lib/drying-room-picker.ts. The unit is never
 *    saved; the room carries it.
 *  - THE CARDS MOVE ("allow cards to move around"). Inside and Affected can be
 *    dragged by their grip into either order, saved per person in
 *    user_view_prefs — see src/lib/drying-card-order.ts.
 *
 * 2026-09-28, Heshy Landau's checklist (IICRC S500)
 * -------------------------------------------------
 * His 1 Sep email via David is the list an insurance audit is held to. Four
 * gaps, all ADDITIVE — the daily Inside / Affected cards a tech fills today are
 * untouched, and the new readings live in collapsed drawers under them:
 *
 *  - WATER CLASS 1–4 beside the category (src/lib/water-class.ts): how much
 *    water there is to evaporate, where category is how dirty it was.
 *  - DEHUMIDIFIER INLET / OUTLET per machine on site, and the grain depression
 *    between them (src/lib/dehu-performance.ts). This completes the dehu_outlet
 *    point Mark had taken off the daily form on 2026-09-07; it stays off that
 *    form and comes back as its own drawer, next to its new inlet pair.
 *  - FIXED MATERIAL TEST POINTS with a dry standard, read daily until met
 *    (src/lib/drying-materials.ts). Progress shows on each day square.
 *  - EQUIPMENT HOUR METERS at set-up and pickup (the scan sessions on the
 *    Equipment tab), totalled in the summary as billing evidence.
 *
 * The DRYING SUMMARY at the top answers the checklist in five lines.
 * Migrations: 20260928160000 (class, inlet, hour meters) and 20260928161000
 * (test points); each new input is held back, and says so, until its own
 * migration is in the database.
 */

/** A colour per series, cycling. Same tokens the reports charts draw with. */
const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/**
 * The points a crew types. Outside is fetched, and overridden rather than
 * entered. ENTRY_POINTS rather than DRYING_POINTS: a point Mark has had taken
 * off the form (Unaffected, 2026-09-07) is still read everywhere a row for it
 * appears, but is never offered here.
 */
const TYPED_POINTS = ENTRY_POINTS.filter((p) => p.key !== "exterior");

/**
 * Points a crew takes more than one of on a single walk. Affected chambers
 * always came in numbers; since 2026-09-07 inside readings do too, because
 * Mark asked that a technician be able to say which room he is in and a
 * technician walks through several.
 */
const REPEATS: Partial<Record<DryingPoint, string>> = {
  interior: "Add another room",
  affected: "Add another room",
};

/**
 * Points whose reading is taken somewhere in particular, so the row offers the
 * job's room list. `interior` joined them on 2026-09-07; it stays OPTIONAL
 * there ("No room" is a legitimate answer and means the property as a whole),
 * which is what keeps a job logged the old way reading as one Inside series.
 */
const ROOM_POINTS: ReadonlySet<DryingPoint> = new Set(["interior", "affected"]);

function numOrNull(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** "1 Sep" — the log is read by day, and the year is on the job header. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * A phone keyboard covers the bottom half of the screen, and the viewport
 * resize that reveals it lands after the focus event — so on a form this long
 * the field just tapped can end up underneath it. Re-centring once the keyboard
 * has settled is the only thing that reliably keeps the digits visible while
 * they are typed.
 */
function keepVisible(e: FocusEvent<HTMLInputElement>) {
  const el = e.currentTarget;
  window.setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
}

/** One reading being typed. Its key is the row's primary key when it is saved. */
type EntryRow = {
  key: string;
  point: DryingPoint;
  /**
   * The unit the technician narrowed the room list to. Navigation only — it
   * is never saved, because the room already carries its unit. UNIT_ANY until
   * a unit or a room is picked.
   */
  unit: string;
  roomId: string;
  label: string;
  temp: string;
  rh: string;
  notes: string;
  /** The photograph of the meter, re-encoded on the tablet before it travels. */
  photo: MeterPhoto | null;
};

function blankRow(point: DryingPoint): EntryRow {
  return {
    key: newId(),
    point,
    unit: UNIT_ANY,
    roomId: "",
    label: "",
    temp: "",
    rh: "",
    notes: "",
    photo: null,
  };
}

function freshRows(): EntryRow[] {
  return TYPED_POINTS.map((p) => blankRow(p.key));
}

export function JobDryingLog({
  jobId,
  jobNumber,
  address,
  album,
}: {
  jobId: string;
  /** Printed on the exported log, so the file names the job it is about. */
  jobNumber?: string | null;
  address?: string | null;
  /**
   * What a room added from the room picker needs for its photo folder — the
   * same as the Rooms tab is given. Without it the picker offers no "+ Add
   * room", because a room made here must get the folder one made there would.
   */
  album?: Omit<AlbumContext, "userId">;
}) {
  const app = useAppContext();
  const qc = useQueryClient();

  const [date, setDate] = useState(() => todayLocal());
  const [rows, setRows] = useState<EntryRow[]>(freshRows);
  const [busy, setBusy] = useState(false);

  /*
   * The Days card shows the psychrometrics grid (every day at once, days
   * across) or the day squares with the chart. The client asked for the grid:
   * "you can put in all days at one time ... right now you have to click each
   * day separately and it takes up a lot more room." Grid first; the choice is
   * remembered on this device.
   */
  const [daysView, setDaysViewState] = useState<"grid" | "days">(() => {
    try {
      return window.localStorage.getItem(DAYS_VIEW_KEY) === "days" ? "days" : "grid";
    } catch {
      return "grid";
    }
  });
  const setDaysView = (v: "grid" | "days") => {
    setDaysViewState(v);
    try {
      window.localStorage.setItem(DAYS_VIEW_KEY, v);
    } catch {
      // Storage blocked — the choice holds for this visit.
    }
  };

  /**
   * The three outcomes the outside baseline can be in, kept apart on purpose.
   * "failed" is not "not fetched yet": one is a provider that could not be
   * reached and should be retried, the other is a job nobody has asked about.
   */
  const [fetchFailure, setFetchFailure] = useState<OutsideFetchFailure | null>(null);
  const [fetching, setFetching] = useState(false);

  /**
   * The "this is the baseline set" tick. Null means the technician has not
   * touched it and the suggestion stands, so changing the day re-suggests
   * rather than carrying yesterday's answer forward.
   */
  const [baselineChoice, setBaselineChoice] = useState<boolean | null>(null);
  useEffect(() => setBaselineChoice(null), [date]);

  const roomsQ = useQuery({
    queryKey: ["job-rooms", jobId],
    queryFn: () => fetchJobRooms(jobId),
  });

  const logQ = useQuery({
    queryKey: ["job-drying-log", jobId],
    queryFn: () => listDryingReadings(jobId),
  });

  /**
   * The site's coordinates (without them there is no grid square to ask about)
   * and the water category, in one read.
   *
   * `water_category` ships in the 2026-09-04 migration, so the select falls
   * back to the pair of columns that certainly exist rather than letting one
   * unshipped column take down the outside baseline with it.
   */
  const jobQ = useQuery({
    queryKey: ["job-drying-meta", jobId],
    queryFn: async () => {
      // Newest first, each step down dropping the column the next-older
      // migration added: water_class (20260928160000), then water_category
      // (20260904090000). One unshipped column must not take the outside
      // baseline down with it.
      type Meta = {
        lat: number | null;
        lon: number | null;
        water_category?: number | null;
        water_class?: number | null;
      };
      for (const cols of [
        "lat, lon, water_category, water_class",
        "lat, lon, water_category",
        "lat, lon",
      ]) {
        const res = await supabase
          .from("jobs")
          .select(cols as never)
          .eq("id", jobId)
          .maybeSingle();
        if (res.error) {
          if (isMissingSchema(res.error)) continue;
          throw res.error;
        }
        const row = res.data as Meta | null;
        return {
          lat: row?.lat ?? null,
          lon: row?.lon ?? null,
          waterCategory: parseWaterCategory(row?.water_category),
          waterClass: parseWaterClass(row?.water_class),
          categoryAvailable: cols.includes("water_category"),
          // The class column ships in the same migration as the dehu inlet
          // point and the hour meters, so it is the probe for all three.
          classAvailable: cols.includes("water_class"),
        };
      }
      throw new Error("The job could not be read.");
    },
  });

  /**
   * Every placement on the job: the dehumidifiers the inlet / outlet drawer
   * offers, and the hour meters the summary totals. See drying-equipment.ts.
   */
  const placementsQ = useQuery({
    queryKey: ["job-drying-equipment", jobId],
    queryFn: () => listDryingPlacements(jobId),
  });

  /** The fixed material test points and their readings; null = not migrated. */
  const moistureQ = useQuery({
    queryKey: ["job-moisture", jobId],
    queryFn: () => listMoisture(jobId),
  });

  /**
   * When the first piece of equipment went in. Melly's rule is that the
   * baseline set and the equipment drop "should really be the same time", so
   * the panel checks the two against each other and says when they disagree.
   */
  const dropQ = useQuery({
    queryKey: ["job-equipment-drop", jobId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("equipment_placements")
        .select("placed_at")
        .eq("job_id", jobId)
        .order("placed_at", { ascending: true })
        .limit(1);
      if (error) {
        if (isMissingSchema(error)) return null;
        throw error;
      }
      const at = data?.[0]?.placed_at;
      // Local calendar date, not the UTC slice of the stamp: a drop at 8pm
      // Pacific is not the next day's baseline.
      return at ? todayLocal(new Date(at)) : null;
    },
  });

  /**
   * The series labels the drying chart is read from. They carry the unit, so a
   * "Bedroom" series in a forty-unit block names a place rather than any of
   * forty of them.
   */
  const roomNames = useMemo(
    () => new Map((roomsQ.data?.rooms ?? []).map((r) => [r.id, roomLabel(r)])),
    [roomsQ.data],
  );

  const rooms = useMemo(() => roomsQ.data?.rooms ?? [], [roomsQ.data]);

  /**
   * The units on this job, for the picker that narrows the room list. Empty on
   * a house — and on a database without job_rooms.unit yet — so the unit
   * control is not drawn at all rather than sitting there with nothing in it.
   */
  const units = useMemo(() => unitOptions(rooms), [rooms]);

  /*
   * "+ Add room" under the room picker. Mark, 7 Oct 2026: "add a way to add a
   * room from here too." Shown to the people the job_rooms insert policy lets
   * in (can_manage_job) on a day writes are open; the policy still decides,
   * and a refusal is a toast. The room goes in through the Rooms tab's own
   * path — duplicates of a name allowed there are allowed here.
   */
  const canManageJob = useCanManageJob(jobId);
  const canAddRoom = Boolean(album) && canManageJob === true && !app.writesDisabled;
  const addRoom = async (fields: RoomFields): Promise<JobRoom | null> => {
    if (!album) return null;
    try {
      return await addJobRoom({
        ...album,
        userId: app.userId,
        queryClient: qc,
        room: fields,
        sortOrder: rooms.length * 10,
        // The Rooms tab shows folder trouble on the tab; here the room was
        // picked and the reading goes on, so it is said once and pointed there.
        onFolders: (outcome) => {
          if (outcome.ok) return;
          toast.warning("The room was saved, but its photo folder was not", {
            description: `${outcome.message} Use Repair photo folders on the Rooms tab to try again.`,
          });
        },
      });
    } catch (e) {
      toastDbError(e, { action: "Adding room" });
      return null;
    }
  };

  const readings: DryingReading[] = useMemo(() => logQ.data?.rows ?? [], [logQ.data]);
  // What the automatic outside column's footnote says: the model's sentence,
  // and one per NWS station that filled in for it — or the model's alone when
  // nothing automatic is on file yet, since that is what the column will hold.
  const automaticNotes = useMemo(() => {
    const notes = outsideReadingNotes(readings);
    return notes.length > 0 ? notes : [OUTSIDE_MODELLED_NOTE];
  }, [readings]);
  // Once every placement is retrieved the log stops on the pickup date.
  const pickupDate = equipmentPickupDate(placementsQ.data?.rows ?? []);
  const log = useMemo(
    () => buildDryingLog(readings, { roomNames, endDate: pickupDate }),
    [readings, roomNames, pickupDate],
  );

  /*
   * The log as a file for the adjuster. Built on every render rather than
   * memoised: its window runs to TODAY, and a tab left open overnight must not
   * hand a carrier yesterday's idea of which days are missing. It is a few
   * hundred rows at most, so the rebuild costs nothing.
   */
  const exportSheets = dryingLogWorkbook({
    rows: readings,
    roomNames,
    jobNumber,
    address,
    endDate: pickupDate,
  });

  /** The exterior baseline as it stands for the date being logged. */
  const outside = useMemo(() => {
    const onDate = readings.filter((r) => r.point === "exterior" && r.reading_date === date);
    return {
      auto: onDate.find((r) => r.source === "weather") ?? null,
      manual: onDate.find((r) => r.source !== "weather") ?? null,
    };
  }, [readings, date]);

  /** Dew point per series over time, oldest first — the trend the claim rests on. */
  const chartData = useMemo(() => {
    return [...log.days]
      .reverse()
      .filter((d) => !d.missing || Object.keys(d.bySeries).length > 0)
      .map((day) => {
        const entry: Record<string, string | number | null> = { date: shortDate(day.date) };
        for (const s of log.series) {
          const taken = day.bySeries[s.key];
          // The last reading of the day is the one the day is judged on.
          entry[s.key] = taken?.length ? (taken[0]!.dew_point_f ?? null) : null;
        }
        return entry;
      });
  }, [log]);

  /**
   * The set the whole job is read against. Declared by a crew when the column
   * exists; inferred as the first logged day until then — and the panel always
   * says which, because an inferred baseline taken three days after the dehus
   * went in flatters the drying.
   */
  const baseline = useMemo(() => findBaselineSet(readings), [readings]);

  const baselineInside = useMemo(
    () => baseline?.points.find((p) => p.point === "interior")?.dewPointF ?? null,
    [baseline],
  );

  /** The calendar squares, oldest first, with today always present. */
  const tiles = useMemo(
    () =>
      buildDryingDayTiles(
        log,
        todayLocal(),
        baseline ? { date: baseline.date, insideDewPoint: baselineInside } : null,
      ),
    [log, baseline, baselineInside],
  );

  /**
   * The first day this job's drying record covers — the oldest square, or the
   * day the first machine went in if that is earlier (a job can have equipment
   * on site before anybody has typed a reading).
   *
   * It is the floor for a backfill. Outside conditions before this date are
   * real weather but they are not this job's record, and writing them would
   * extend the strip backwards with days the log then counts as gaps.
   */
  const recordStart = useMemo(() => {
    const dates = [
      tiles[0]?.date,
      ...(placementsQ.data?.rows ?? []).map((p) => todayLocal(new Date(p.placed_at))),
    ].filter((d): d is string => Boolean(d));
    return dates.length > 0 ? dates.sort()[0]! : todayLocal();
  }, [tiles, placementsQ.data]);

  /**
   * Progress toward dry per day square: how many fixed test points were in
   * play that day and how many had reached their dry standard by then.
   */
  const materialsDays = useMemo(
    () =>
      moistureQ.data
        ? materialsByDay(
            moistureQ.data.points,
            moistureQ.data.readings,
            tiles.map((t) => t.date),
          )
        : new Map<string, MaterialsDay>(),
    [moistureQ.data, tiles],
  );

  /** The five-line answer to Heshy's checklist, from what is already loaded. */
  const summary = useMemo(() => {
    const placements = placementsQ.data?.rows ?? [];
    const today = todayLocal();
    // The latest day any machine was read is the day the verdict is quoted
    // for — yesterday's pair is still the newest evidence until today's lands.
    const dehuDates = readings
      .filter((r) => DEHU_POINTS.has(r.point) && r.reading_date <= today)
      .map((r) => r.reading_date)
      .sort();
    const lastDate = dehuDates[dehuDates.length - 1] ?? null;
    const pairs = lastDate ? pairDehuReadings(readings, lastDate) : [];
    const onSite = dehusOnSite(placements, today).length;
    const judged = pairs.filter((p) => p.performance).length;
    const active = (moistureQ.data?.points ?? []).filter((p) => !p.removed_at);
    return {
      dehus:
        onSite === 0 && judged === 0
          ? null
          : {
              onSite,
              judged,
              pulling: pairs.filter((p) => p.performance?.verdict === "pulling").length,
              date: lastDate,
            },
      // undefined while loading, null when the tables are not migrated — the
      // card says "…" for the one and "pending migration" for the other.
      materials:
        moistureQ.data === undefined
          ? undefined
          : moistureQ.data === null
            ? null
            : {
                total: active.length,
                dry: active.filter(
                  (p) => summarizePoint(p, moistureQ.data?.readings ?? []).status === "dry",
                ).length,
              },
      hours: !placementsQ.data
        ? undefined
        : !placementsQ.data.hoursAvailable
          ? null
          : jobHoursTotal(placements),
    };
  }, [placementsQ.data, moistureQ.data, readings]);

  /** The tapped day read against the baseline, point by point. */
  const deltas = useMemo(() => {
    const onDate = readings.filter((r) => r.reading_date === date);
    if (!baseline || onDate.length === 0) return [];
    // The dehumidifier pair is judged by its grain depression, not against
    // the baseline day — its exhaust is supposed to be far drier than the
    // house, and a "▼ 30°" on it says nothing about the house drying.
    return compareToBaseline(baseline, onDate).filter(
      (d) =>
        !DEHU_POINTS.has(d.point) && (d.baselineDewPointF != null || d.currentDewPointF != null),
    );
  }, [baseline, readings, date]);

  const baselineWarning = useMemo(
    () => describeBaselineAlignment(baseline?.date ?? null, dropQ.data ?? null),
    [baseline, dropQ.data],
  );

  /** What is already on file for the day being logged, series by series. */
  const onFile = useMemo(() => {
    const day = log.days.find((d) => d.date === date);
    if (!day) return [];
    return log.series
      .map((s) => ({ series: s, reading: day.bySeries[s.key]?.[0] ?? null }))
      .filter((x): x is { series: (typeof log.series)[number]; reading: DryingReading } =>
        Boolean(x.reading),
      );
  }, [log, date]);

  // A crew reading already stands for this date, so the override box would only
  // invite a second one. Anything half-typed is left alone — a box that empties
  // itself under the tech is worse than a spare one — and reopening is one tap.
  useEffect(() => {
    if (!outside.manual) return;
    setRows((current) =>
      current.some((r) => r.point === "exterior" && (r.temp.trim() || r.rh.trim()))
        ? current
        : current.filter((r) => r.point !== "exterior"),
    );
  }, [outside.manual]);

  const patch = (key: string, change: Partial<EntryRow>) =>
    setRows((current) => current.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const addRow = (point: DryingPoint) => setRows((current) => [...current, blankRow(point)]);

  const dropRow = (key: string) => setRows((current) => current.filter((r) => r.key !== key));

  /** One row's verdict, shared by the row's own hint and the save button. */
  const entryCheck = (r: EntryRow) =>
    checkReadingEntry({
      point: r.point,
      temperatureF: numOrNull(r.temp),
      relativeHumidity: numOrNull(r.rh),
      hasPhoto: !!r.photo,
    });

  /**
   * A photo is attached: re-encode it, then offer it to the OCR seam.
   *
   * `readMeterPhoto` returns null in this build — nothing reads a meter yet —
   * and `applyMeterRead` would only ever fill boxes the technician left empty.
   * The call is here rather than waiting for the reader so that registering one
   * is the whole change, and so this path is exercised on every photo taken.
   */
  const attachPhoto = async (key: string, file: Blob) => {
    const photo = await prepareMeterPhoto(file);
    setRows((current) => current.map((r) => (r.key === key ? { ...r, photo } : r)));
    const read = await readMeterPhoto(photo.blob);
    if (!read) return;
    setRows((current) =>
      current.map((r) => {
        if (r.key !== key) return r;
        const merged = applyMeterRead({ temp: r.temp, rh: r.rh }, read);
        return merged.filled ? { ...r, temp: merged.temp, rh: merged.rh } : r;
      }),
    );
  };

  /**
   * Whether this database has the 2026-09-04 columns. `undefined` while the log
   * is still loading, which reads as "assume yes" rather than flashing a
   * migration warning at every technician who opens a job.
   */
  const interiorAvailable = logQ.data ? logQ.data.interior : true;

  /**
   * The baseline tick.
   *
   * Suggested when there is no baseline at all, or when the day being logged IS
   * the baseline day and is being added to. Locked shut once a crew has
   * declared one somewhere else: a job with two declared baselines makes every
   * later comparison ambiguous, and the place to refuse that is here, in front
   * of the technician, rather than in a database constraint that would bounce a
   * reading taken in a basement back into the sync list forever.
   */
  const baselineLocked = !!baseline?.declared && baseline.date !== date;
  const suggestedBaseline = !baseline || baseline.date === date;
  const markBaseline = baselineLocked ? false : (baselineChoice ?? suggestedBaseline);

  const outsideRows = useMemo(() => rows.filter((r) => r.point === "exterior"), [rows]);

  // The override box is open exactly when an exterior row exists, rather than
  // being a second flag to keep in step with the rows it is meant to describe.
  const outsideOverride = outsideRows.length > 0;

  const toggleOverride = () =>
    setRows((current) =>
      current.some((r) => r.point === "exterior")
        ? current.filter((r) => r.point !== "exterior")
        : [blankRow("exterior"), ...current],
    );

  /**
   * Fill the outside figures this log is missing. "tap" is the button; "auto"
   * is the log filling itself on open, which says nothing when there was
   * nothing to do and reports a failure exactly as a tap would — a fill that
   * fails quietly is how this went unnoticed for a month.
   */
  const runFetch = async (mode: "tap" | "auto" = "tap") => {
    const lat = jobQ.data?.lat;
    const lon = jobQ.data?.lon;
    if (lat == null || lon == null) return;
    setFetching(true);
    setFetchFailure(null);
    try {
      /* Not "the past week" any more. The nightly fill has never written a row on
         this deployment, so the jobs on screen are carrying logs with every outside
         figure missing — a week-deep fetch would leave the older half of them
         blank for good. The window reaches back to the day the record starts,
         capped at OUTSIDE_MAX_BACKFILL_DAYS, and writes nothing before it. */
      const { written, skippedManual } = await fetchAndStoreOutsideConditions({
        jobId,
        lat,
        lon,
        pastDays: backfillPastDays(recordStart, todayLocal()),
        notBefore: recordStart,
      });
      await qc.invalidateQueries({ queryKey: ["job-drying-log", jobId] });
      if (mode === "auto") {
        if (written > 0) {
          toast.success(
            `Filled ${written} day${written === 1 ? "" : "s"} of outside conditions automatically.`,
          );
        }
        return;
      }
      toast.success(
        written === 0
          ? "Outside conditions were already up to date."
          : `Filled ${written} day${written === 1 ? "" : "s"} of outside conditions.`,
        skippedManual.length
          ? {
              description: `${skippedManual.length} day(s) left alone — a crew reading is on file.`,
            }
          : undefined,
      );
    } catch (error) {
      // Never a reading, and never silence. An empty Outside column that is
      // actually a failed fetch is the thing that gets typed over by hand —
      // and a database refusing the write is a different problem from a
      // provider that timed out, so the two are named apart.
      setFetchFailure(describeOutsideFetchFailure(error));
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }

    // One rule for what a saveable row is, shared with the row's own hint and
    // the save button's count — see checkReadingEntry.
    const checked = rows.map((r) => ({ row: r, check: entryCheck(r) }));
    const broken = checked.find((c) => c.check.error);
    if (broken) {
      toast.error(broken.check.error!);
      return;
    }
    const filled = checked.filter((c) => c.check.ready).map((c) => c.row);
    if (filled.length === 0) {
      toast.error("Enter at least one reading.");
      return;
    }

    setBusy(true);
    const built = filled.map((r) => {
      const row = buildReadingRow({
        // The entry row's key is the reading's primary key, so an offline drain
        // that runs twice updates one row rather than logging it twice.
        id: r.key,
        jobId,
        roomId: ROOM_POINTS.has(r.point) && r.roomId ? r.roomId : null,
        point: r.point,
        label: r.point === "affected" ? r.label : null,
        readingDate: date,
        temperatureF: numOrNull(r.temp)!,
        relativeHumidity: numOrNull(r.rh)!,
        notes: r.notes,
        userId: app.userId,
        isBaseline: markBaseline,
        photoMime: r.photo?.mime ?? null,
        hasPhotoThumb: !!r.photo?.thumb,
      });
      // The files travel beside the row, held on the tablet with it when there
      // is no signal, and are uploaded by the same writer either way.
      const blobs: DryingReadingBlobs = {};
      if (r.photo) {
        blobs.photo = { blob: r.photo.blob, mime: r.photo.mime };
        if (r.photo.thumb) blobs.thumb = { blob: r.photo.thumb, mime: "image/webp" };
      }
      return { row, blobs };
    });

    const held = await persistReadings(built);
    setBusy(false);
    // freshRows() has no exterior row, so the override box closes with it.
    setRows(freshRows());
    setBaselineChoice(null);
    if (held === 0) {
      toast.success(`Logged ${built.length} reading${built.length === 1 ? "" : "s"}.`);
    } else if (held === built.length) {
      toast.warning(`Saved ${held} reading${held === 1 ? "" : "s"} on this device`, {
        description: "They upload by themselves when you have signal.",
      });
    } else {
      toast.warning(`${built.length - held} logged, ${held} held on this device`, {
        description: "The held readings upload when you have signal.",
      });
    }
    void qc.invalidateQueries({ queryKey: ["job-drying-log", jobId] });
  };

  /**
   * The one write path for a batch of readings: straight to the server, or
   * held on the device when there is no signal or the server refuses. Shared by
   * the daily form and the dehumidifier drawer, so a reading is never saved
   * two different ways. Returns how many were held.
   */
  async function persistReadings(
    built: { row: DryingReadingInsert; blobs: DryingReadingBlobs }[],
  ): Promise<number> {
    const offline = typeof navigator !== "undefined" && !navigator.onLine;
    let held = 0;
    for (const { row, blobs } of built) {
      if (!offline) {
        try {
          await writeDryingReading(row, blobs);
          continue;
        } catch {
          // Anything the server refused, a table that does not exist yet
          // included, is held rather than lost. A reading the crew cannot
          // retake tomorrow is a day of drying that never happened as far as
          // the carrier is concerned.
        }
      }
      await enqueue({
        id: row.id as string,
        kind: "drying_reading",
        payload: row as unknown as Record<string, unknown>,
        blobs: Object.keys(blobs).length ? blobs : undefined,
        label: readingQueueLabel(row),
      });
      held += 1;
    }
    return held;
  }

  /**
   * The dehumidifier drawer's save: two rows per machine, inlet and outlet,
   * each naming the machine (equipment_id) and carrying its asset tag as the
   * label so every machine is its own series. Never marked as the baseline —
   * the machine's air is not the house's.
   */
  const saveDehuPairs = async (pairs: DehuPairEntry[]) => {
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    const built = pairs.flatMap(({ placement, inlet, outlet }) =>
      (
        [
          ["dehu_inlet", inlet],
          ["dehu_outlet", outlet],
        ] as const
      ).map(([point, air]) => ({
        row: buildReadingRow({
          id: newId(),
          jobId,
          roomId: placement.room_id,
          equipmentId: placement.equipment_id,
          point,
          label: placement.asset_tag,
          readingDate: date,
          temperatureF: air.temperatureF,
          relativeHumidity: air.relativeHumidity,
          userId: app.userId,
        }),
        blobs: {} as DryingReadingBlobs,
      })),
    );
    const held = await persistReadings(built);
    if (held === 0)
      toast.success(`Logged ${pairs.length} dehumidifier${pairs.length === 1 ? "" : "s"}.`);
    else
      toast.warning(`${held} of ${built.length} readings held on this device`, {
        description: "They upload by themselves when you have signal.",
      });
    void qc.invalidateQueries({ queryKey: ["job-drying-log", jobId] });
  };

  /**
   * The grid's save: each changed day-and-point becomes a NEW reading, through
   * the same writer as the day form (held on the device without signal). The
   * log judges a day on its newest reading, so the typed figures take over and
   * nothing on record is overwritten. Inside is that room's reading (11 Nov:
   * one pair per room), or the whole property's on a job with no rooms.
   */
  const saveGrid = async (saves: GridSave[]) => {
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    const built = saves.map((g) => ({
      row: buildReadingRow({
        id: newId(),
        jobId,
        roomId: g.roomId,
        point: g.point,
        readingDate: g.date,
        temperatureF: g.temperatureF,
        relativeHumidity: g.relativeHumidity,
        userId: app.userId,
      }),
      blobs: {} as DryingReadingBlobs,
    }));
    const held = await persistReadings(built);
    const days = new Set(saves.map((g) => g.date)).size;
    if (held === 0)
      toast.success(
        `Saved ${built.length} reading${built.length === 1 ? "" : "s"} across ${days} day${days === 1 ? "" : "s"}.`,
      );
    else
      toast.warning(`${held} of ${built.length} readings held on this device`, {
        description: "They upload by themselves when you have signal.",
      });
    void qc.invalidateQueries({ queryKey: ["job-drying-log", jobId] });
  };

  /** A date in the grid opens that day in the full form below. */
  const openDay = (d: string) => {
    setDate(d);
    window.setTimeout(
      () =>
        document
          .getElementById("drying-day-entry")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      60,
    );
  };

  const renderRow = (r: EntryRow, index: number, siblings: number) => {
    const preview = derive(numOrNull(r.temp), numOrNull(r.rh));
    const usesRoom = ROOM_POINTS.has(r.point);
    const usesLabel = r.point === "affected";
    const check = entryCheck(r);
    return (
      <div key={r.key} className="space-y-2 rounded-md border bg-background p-2">
        {siblings > 1 && (
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-muted-foreground">
              Reading {index + 1} of {siblings}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 text-muted-foreground"
              aria-label="Remove this reading"
              onClick={() => dropRow(r.key)}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}

        {/* WHERE the reading was taken, before WHAT it read. Mark, 2026-09-07:
            "for now room should be above". The room is its own labelled block
            at the top of the card, above the label box and the two numbers,
            rather than sharing a row with the delete button — a technician
            picks the room he is standing in, then reads the meter.

            "add a section for unit numbers": the unit comes first, and the
            room list narrows to it. Both are read off the job's room list —
            there is no unit on a reading, only the room, which carries its
            own unit. On a job with no units the unit box is not drawn. */}
        {usesRoom && (
          <div className={cn("grid gap-2", units.length > 0 && "grid-cols-2")}>
            {units.length > 0 && (
              <div className="space-y-1">
                <label
                  htmlFor={`unit-${r.key}`}
                  className="text-[11px] font-medium text-muted-foreground"
                >
                  Unit
                </label>
                <Select value={r.unit} onValueChange={(v) => patch(r.key, chooseUnit(rooms, r, v))}>
                  <SelectTrigger id={`unit-${r.key}`} className="h-11 w-full">
                    <SelectValue placeholder="Unit" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNIT_ANY}>Any unit</SelectItem>
                    {units.map((u) => (
                      <SelectItem key={u.key} value={u.key}>
                        {u.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1">
              <label
                htmlFor={`room-${r.key}`}
                className="text-[11px] font-medium text-muted-foreground"
              >
                Room
              </label>
              <DryingRoomSelect
                id={`room-${r.key}`}
                rooms={rooms}
                choice={r}
                onChoose={(choice) => patch(r.key, choice)}
                canAddRoom={canAddRoom}
                unitAvailable={roomsQ.data?.unitAvailable ?? true}
                onAddRoom={addRoom}
              />
            </div>
            {/* A unit with no room saves as the whole property, because the
                unit lives on the room. Said here, before the save, rather
                than discovered on the chart. */}
            {r.unit !== UNIT_ANY && !r.roomId && (
              <p className="col-span-full text-[11px] text-muted-foreground">
                Pick a room in this unit — without one the reading counts for the whole property,
                not the unit.
              </p>
            )}
          </div>
        )}

        {usesLabel && (
          <Input
            className="h-11"
            placeholder="Chamber label (optional)"
            value={r.label}
            onChange={(e) => patch(r.key, { label: e.target.value })}
          />
        )}

        <div className="grid grid-cols-2 gap-2">
          <Input
            className="h-11 text-base"
            inputMode="decimal"
            aria-label={`Temperature °F, reading ${index + 1}`}
            placeholder="Temp °F"
            value={r.temp}
            onFocus={keepVisible}
            onChange={(e) => patch(r.key, { temp: e.target.value })}
          />
          <Input
            className="h-11 text-base"
            inputMode="decimal"
            aria-label={`Relative humidity %, reading ${index + 1}`}
            placeholder="RH %"
            value={r.rh}
            onFocus={keepVisible}
            onChange={(e) => patch(r.key, { rh: e.target.value })}
          />
        </div>

        {/* The derived pair, live, so a fat-fingered 7 instead of 70 is
            obvious on site rather than in an office three weeks later. */}
        <div className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
          <span className="text-muted-foreground">Dew point / GPP</span>
          <span className="font-medium tabular-nums">
            {preview.dewPointF == null ? "—" : `${preview.dewPointF} °F`}
            {" · "}
            {preview.gpp == null ? "—" : `${preview.gpp} gr/lb`}
          </span>
        </div>

        {/* One note per reading. The field above it used to be the `label`
            column wearing a "Note (optional)" placeholder on two of the four
            points, which is why the form showed two note boxes and anything
            typed in the upper one vanished into a chamber name. */}
        <Input
          className="h-11"
          placeholder="Note (optional)"
          value={r.notes}
          onFocus={keepVisible}
          onChange={(e) => patch(r.key, { notes: e.target.value })}
        />

        {/* The photograph of the meter. Melly's "in addition to uploading the
            picture" — it is what an adjuster looks at when they doubt the
            number typed above it. */}
        <MeterPhotoField
          photo={r.photo}
          label={`Meter photo, reading ${index + 1}`}
          available={interiorAvailable}
          onPick={(file) => attachPhoto(r.key, file)}
          onClear={() => patch(r.key, { photo: null })}
        />

        {check.warning && (
          <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
            <span>{check.warning}</span>
          </p>
        )}
      </div>
    );
  };

  /**
   * The order the reading cards sit in. Mark: "allow cards to move around".
   * Loaded per person from user_view_prefs, held locally so a drag lands at
   * once, and written back on the drop. A failed write is said, not hidden —
   * the cards stay where they were dragged for this visit either way.
   */
  const cardOrderQ = useQuery({
    queryKey: ["drying-card-order", app.userId],
    enabled: !!app.userId,
    queryFn: () => loadDryingCardOrder(app.userId!),
  });
  const [cardOrder, setCardOrder] = useState<DryingPoint[]>([]);
  useEffect(() => {
    if (cardOrderQ.data) setCardOrder(cardOrderQ.data);
  }, [cardOrderQ.data]);

  const cards = useMemo(
    () =>
      orderCards(
        TYPED_POINTS.filter((p) => p.key !== "interior" || interiorAvailable),
        cardOrder,
      ),
    [cardOrder, interiorAvailable],
  );

  // A short pointer drag, a hold-then-drag on touch so a swipe still scrolls
  // the page, and the keyboard for anyone not using either — the same sensors
  // the dashboard grid uses.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onCardDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const keys = cards.map((c) => c.key);
    const from = keys.indexOf(active.id as DryingPoint);
    const to = keys.indexOf(over.id as DryingPoint);
    if (from < 0 || to < 0) return;
    const next = arrayMove(keys, from, to);
    setCardOrder(next);
    if (!app.userId || app.writesDisabled) return;
    saveDryingCardOrder(app.userId, next)
      .then(() => qc.invalidateQueries({ queryKey: ["drying-card-order", app.userId] }))
      .catch(() =>
        toast.error("The card order could not be saved", {
          description: "The cards stay where you put them for now, but will reset next time.",
        }),
      );
  };

  const readyCount = rows.filter((r) => entryCheck(r).ready).length;
  const coords = jobQ.data;
  const hasCoords = coords?.lat != null && coords?.lon != null;

  /**
   * What the squares need to say WHY a figure is missing rather than showing an
   * em-dash for every cause at once. `writesRefused` only becomes true after a
   * write has actually been refused — the panel never guesses that a database
   * is misconfigured, it reports what it was told.
   */
  const outsideCtx: OutsideContext = {
    hasLocation: hasCoords,
    writesRefused: fetchFailure?.kind === "blocked",
    interiorAvailable,
    hourOfDay: new Date().getHours(),
  };
  const outsideSetupNote = describeOutsideSetup(outsideCtx, tiles);

  /*
   * The log fills its own outside figures when it is opened.
   *
   * Mark: "we need the outisde information to automatically be inputted." The
   * nightly server job is meant to do that and, per the live database, has
   * never once succeeded — while every one of the 23 outside readings on file
   * was written by this page, from the browser. So the page does it without
   * being asked: once per job per visit, only when there is a day it could
   * actually fill (outsideDaysToFill), never while offline, never on a
   * read-only session, and never twice — a refused write sets writesRefused,
   * which empties the list, so a broken database cannot become a request on
   * every render.
   */
  const autoFilledFor = useRef<string | null>(null);
  const daysToFill = outsideDaysToFill(tiles, outsideCtx).length;
  useEffect(() => {
    if (autoFilledFor.current === jobId) return;
    if (!logQ.data?.available || fetching || app.writesDisabled || daysToFill === 0) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    autoFilledFor.current = jobId;
    void runFetch("auto");
    // runFetch is recreated every render; the ref is what makes this once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, logQ.data?.available, fetching, app.writesDisabled, daysToFill]);

  const selectedTile = tiles.find((t) => t.date === date) ?? null;
  const dayWord = selectedTile?.isToday ? "today" : shortDate(date);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Temperature and humidity at each point, every day. Dew point and grains per pound are
        calculated — never type them. Outside is the baseline, and drying is proven when the inside
        and affected dew points fall towards it.
      </p>

      {/*
        11 Nov (Athar, voice note): "previously you had one box that had the
        three-day drying with a reset, then another that was the drying
        summary ... and a third one that had the water category and the water
        class with a drop down in each. Can we have the same three that we had
        initially?" — the same three, side by side in one row on a laptop
        (stacked on a phone), so the days start higher on the screen.

        The clock is above the readings on purpose: the log's question is "is
        it dry yet", the clock is "how long has it had". David, 2 Sep: "Reset 3
        days of drying time (new button linked to scanning and alerts)." The
        water category governs everything below it.
      */}
      <div className="grid items-stretch gap-3 lg:grid-cols-3 [&>*]:h-full" data-drying-top-boxes>
        <DryingClockCard jobId={jobId} bare className="rounded-md border p-3" />

        <DryingSummaryCard
          waterCategory={jobQ.data?.waterCategory ?? null}
          waterClass={jobQ.data?.waterClass ?? null}
          dehus={summary.dehus}
          materials={summary.materials}
          hours={summary.hours}
        />

        <WaterCategoryPanel
          value={jobQ.data?.waterCategory ?? null}
          available={jobQ.data ? jobQ.data.categoryAvailable : true}
          disabled={app.writesDisabled}
          onChange={async (next) => {
            const ok = await saveJobField(jobId, "water_category", next, "Water category");
            if (ok) void qc.invalidateQueries({ queryKey: ["job-drying-meta", jobId] });
          }}
          classValue={jobQ.data?.waterClass ?? null}
          classAvailable={jobQ.data ? jobQ.data.classAvailable : true}
          onClassChange={async (next) => {
            const ok = await saveJobField(jobId, "water_class", next, "Water class");
            if (ok) void qc.invalidateQueries({ queryKey: ["job-drying-meta", jobId] });
          }}
        />
      </div>

      {!interiorAvailable && (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            This database did not report the inside-reading columns, so inside readings, the
            baseline flag and meter photos are held back — anything typed into them would be refused
            by the server. Everything else logs normally. They arrive with
            20260904090000_drying_interior_readings; if that has already been applied, reload, as
            the API caches the schema for a short time after a migration lands.
          </span>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* The calendar — one square per day, tap one to log it              */}
      {/* ---------------------------------------------------------------- */}
      {/*
        A container, not a viewport breakpoint: this card sits inside the job
        page's width cap and beside nothing on some layouts and a rail on
        others, so whether there is room for the squares AND a chart side by
        side is a question about the card, not the screen.
      */}
      <div className="@container space-y-2 rounded-md border p-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium">Days</p>
            <div
              role="group"
              aria-label="Days view"
              className={cn(TAB_STRIP, "w-auto max-md:w-auto")}
            >
              {(
                [
                  { value: "grid", label: "Grid", icon: Table2 },
                  { value: "days", label: "Day by day", icon: CalendarDays },
                ] as const
              ).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={daysView === o.value}
                  data-state={daysView === o.value ? "active" : "inactive"}
                  onClick={() => setDaysView(o.value)}
                  className={cn(TAB_TRIGGER, "h-8 text-[12px]")}
                >
                  <o.icon aria-hidden />
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {daysView === "days" ? (
              <>
                <span className="flex items-center gap-1">
                  <span className="size-2.5 rounded-sm border border-success/60 bg-success/20" />
                  logged
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2.5 rounded-sm border bg-muted" />
                  outside only
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2.5 rounded-sm border border-dashed" />
                  nothing yet
                </span>
                <span className="flex items-center gap-1">
                  <Camera className="size-2.5" aria-hidden />
                  meter photo
                </span>
              </>
            ) : null}
            {readings.length > 0 && (
              <Badge variant="secondary" className="shrink-0">
                {readings.length} reading{readings.length === 1 ? "" : "s"}
              </Badge>
            )}
            {/* The drying log as a document a carrier can be sent. Waits for
                the rooms, or "Inside — Kitchen" would go out as "Inside". */}
            <ExportExcelButton
              report={dryingLogReportName(jobNumber)}
              surface="drying-log"
              entity={jobNumber ?? jobId}
              filters={{ job_id: jobId }}
              sheets={exportSheets}
              disabled={readings.length === 0 || roomsQ.isLoading}
              className="h-9 shrink-0"
              label="Download log"
            />
            {/* The same readings as a carrier-ready PDF, MoistureMapper's layout.
                Waits for everything it draws: rooms, placements, test points. */}
            <DryingReportButton
              jobId={jobId}
              jobNumber={jobNumber}
              address={address}
              readings={readings}
              rooms={rooms}
              placements={placementsQ.data?.rows ?? []}
              moisture={moistureQ.data ?? null}
              waterCategory={jobQ.data?.waterCategory}
              waterClass={jobQ.data?.waterClass}
              disabled={
                readings.length === 0 ||
                roomsQ.isLoading ||
                placementsQ.isLoading ||
                moistureQ.isLoading
              }
              className="h-9 shrink-0"
            />
            {/* 11 Nov (point 7): the day's update email, from the same rows. */}
            <DailyUpdateButton
              jobId={jobId}
              jobNumber={jobNumber}
              address={address}
              readings={readings}
              rooms={rooms}
              placements={placementsQ.data?.rows ?? []}
              moisture={moistureQ.data ?? null}
              className="h-9 shrink-0"
            />
            {/* The outside figures are supposed to arrive by themselves. When
                they have not, the fix has to be reachable from the strip that
                shows them missing, not only from inside one day's section. */}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 shrink-0"
              onClick={() => runFetch()}
              disabled={fetching || !hasCoords || app.writesDisabled}
              title={
                hasCoords
                  ? `Fill in every missing outside figure this log covers, back to ${OUTSIDE_MAX_BACKFILL_DAYS} days, from Open-Meteo now`
                  : "This job has no coordinates to fetch conditions for"
              }
            >
              <RefreshCw className={`mr-1 size-3.5 ${fetching ? "animate-spin" : ""}`} />
              Fetch outside
            </Button>
          </div>
        </div>

        {logQ.isError ? (
          <div className="rounded-md border border-destructive/40 p-3 text-sm text-destructive">
            The drying log could not be loaded — this is not an empty log. Retry before re-taking
            any readings.
          </div>
        ) : logQ.isLoading ? (
          <div className="rounded-md border p-3 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            {logQ.data && !logQ.data.available && (
              <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
                The drying log table has not been created in this database yet. Readings you take
                are held on this device and will upload once the migration is applied.
              </div>
            )}
            {/*
              Mark, 2026-10-06: "shrink this to 2/3 size and have the last
              1/3 show a line graph, one line color for each reading."

              Two thirds squares, one third chart, once the card is wide
              enough (@3xl, 768px) for the squares to keep four across beside
              it. Narrower than that — a phone, a tablet held upright — the
              chart goes UNDER the squares at full width: a third of a phone
              is a chart nobody can read, and the squares are what a crew
              taps, so they stay on top.
            */}
            {daysView === "grid" ? (
              <DryingPsychroGrid
                dates={tiles.map((t) => t.date)}
                readings={readings}
                roomNames={roomNames}
                selectedDate={date}
                today={todayLocal()}
                onPickDate={openDay}
                onSave={saveGrid}
                writesDisabled={app.writesDisabled}
                writesReason={app.writesDisabledReason ?? null}
              />
            ) : (
              <div className="grid gap-3 @3xl:grid-cols-3">
                <div className="@container min-w-0 space-y-2 @3xl:col-span-2">
                  {/* Three across on a phone, five in the two thirds a laptop
                    leaves them, a week on a wide screen. The squares are small
                    on purpose; the day being logged is read in full below.

                    Counted against the squares' own column (@container), not
                    the viewport, since 2026-10-06: beside the chart a 1280px
                    screen leaves the squares about 720px, and the old
                    xl:grid-cols-7 would have packed seven into that and cut
                    figures off. Every step keeps a square at 105px or more,
                    the width the phone's three-across was set by.

                    Four across until 2026-10-05, when the humidity went on. Four
                    left about sixty pixels of content per square, which was
                    already truncating "out 55.9°" before a percentage was added
                    to it — a number that is cut off is not on the screen. Three
                    is the width at which the whole line is legible on a phone,
                    and the strip is no taller for it because each square now
                    carries a line that used to be two columns. */}
                  <RowCappedGrid
                    rows={DAY_ROWS_SHOWN}
                    selectedKey={date}
                    className="grid grid-cols-3 gap-1.5 @lg:grid-cols-4 @xl:grid-cols-5 @3xl:grid-cols-6 @4xl:grid-cols-7"
                  >
                    {tiles.map((t) => (
                      <DayTile
                        key={t.date}
                        tile={t}
                        materials={materialsDays.get(t.date) ?? null}
                        ctx={outsideCtx}
                        selected={t.date === date}
                        onSelect={() => setDate(t.date)}
                      />
                    ))}
                  </RowCappedGrid>
                  {/* The strip's own explanation. A square has room for "out fetch";
                    the reason it says that belongs here, in a sentence. */}
                  {outsideSetupNote && (
                    <p
                      className={cn(
                        "flex items-start gap-1.5 text-[11px]",
                        outsideCtx.writesRefused ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      <CloudOff className="mt-0.5 size-3 shrink-0" />
                      <span>{outsideSetupNote}</span>
                    </p>
                  )}
                  {log.gaps.length > 0 && (
                    <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                      <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
                      <span>
                        {log.gaps.length} day{log.gaps.length === 1 ? "" : "s"} with no crew reading
                        — an undocumented day is a day a carrier can refuse to pay equipment for.
                      </span>
                    </p>
                  )}
                </div>
                <div className="min-w-0 border-t pt-3 @3xl:border-t-0 @3xl:border-l @3xl:pt-0 @3xl:pl-3">
                  <DryingDayChart tiles={tiles} />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 11 Nov (client): the dew point trend sits right under the Days
          section, above the entry for the tapped day. */}
      {log.days.length > 0 && chartData.length > 1 && (
        <div className="rounded-md border bg-card p-2">
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="2 2" stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                width={44}
                tickLine={false}
                axisLine={false}
                unit="°"
              />
              <Tooltip
                contentStyle={{
                  fontSize: 12,
                  borderRadius: 3,
                  border: "1px solid var(--border)",
                  background: "var(--popover)",
                  color: "var(--popover-foreground)",
                }}
                formatter={(v) => `${v} °F dew point`}
                /* recharts 3 sorts tooltip rows and legend items by name
                   unless told not to; series order is deliberate here —
                   the modelled exterior baseline stays last. */
                itemSorter={() => 0}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} itemSorter={null} />
              {log.series.map((s, i) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                  strokeWidth={2}
                  /* The modelled baseline is drawn dashed, so a printed
                     chart cannot pass it off as a measured series. */
                  strokeDasharray={s.label === MODELLED_EXTERIOR_LABEL ? "4 3" : undefined}
                  dot={{ r: 2 }}
                  /* Left broken on purpose: a line drawn straight through a
                     missing day claims a reading that was never taken. */
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Entry for the tapped day — every internal point, one save          */}
      {/* ---------------------------------------------------------------- */}
      <div id="drying-day-entry" className="scroll-mt-24 space-y-3 rounded-md border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">
              {selectedTile?.isToday ? "Today" : shortDate(date)}
              {selectedTile?.status === "entered" && (
                <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                  {selectedTile.crewReadings} crew reading
                  {selectedTile.crewReadings === 1 ? "" : "s"} on file
                </span>
              )}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Add this day&rsquo;s readings. Anything already on file stays; a new reading is added
              beside it.
            </p>
          </div>
          {/* The picker stays for a day off the calendar's edge. */}
          <Input
            type="date"
            className="h-9 w-auto"
            aria-label="Reading date"
            value={date}
            max={todayLocal()}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        {onFile.length > 0 && (
          <ul className="grid gap-x-4 gap-y-0.5 rounded-md bg-muted/40 px-3 py-2 text-xs sm:grid-cols-2">
            {onFile.map(({ series, reading }) => (
              <li key={series.key} className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1 truncate text-muted-foreground">
                  <span className="truncate">{series.label}</span>
                  {reading.source === "weather" && (
                    <CloudSun
                      className="size-3 shrink-0"
                      aria-label={outsideReadingNote(reading)}
                    />
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
                  {reading.dew_point_f ?? "—"}° dew · {reading.temperature_f}°/
                  {reading.relative_humidity}%
                  <SavedMeterPhoto path={reading.photo_path} />
                </span>
              </li>
            ))}
          </ul>
        )}

        {/* ------------------------------------------------------------ */}
        {/* The baseline set, and this day read against it                */}
        {/* ------------------------------------------------------------ */}
        {/* 11 Nov: Baseline and Outside side by side, half each (stacked
            on a phone). */}
        <div className="grid gap-3 md:grid-cols-2" data-baseline-outside>
          <div className="min-w-0 space-y-2 rounded-md border bg-muted/20 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <Flag className="size-3.5 shrink-0 text-muted-foreground" />
                  Baseline
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {baseline
                    ? baseline.declared
                      ? `Set on ${shortDate(baseline.date)} — every later day is read against it.`
                      : `No day has been marked, so ${shortDate(baseline.date)} is being used as the ` +
                        "baseline because it is the first one logged. Mark the real one when you know it."
                    : "Nothing logged yet. The first set — job start, or when the equipment went in — is the baseline."}
                </p>
              </div>
              {baseline?.date === date && (
                <Badge variant="secondary" className="shrink-0">
                  This day
                </Badge>
              )}
            </div>

            {baselineWarning && (
              <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
                <span>{baselineWarning}</span>
              </p>
            )}

            {/* Melly: the baseline and the equipment drop "should really be the
              same time", so the tick names the drop date when there is one. */}
            <label
              className={cn(
                "flex min-h-11 items-center gap-2 text-xs",
                baselineLocked || !interiorAvailable
                  ? "cursor-not-allowed text-muted-foreground"
                  : "cursor-pointer",
              )}
            >
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={markBaseline}
                disabled={!interiorAvailable || baselineLocked}
                onChange={(e) => setBaselineChoice(e.target.checked)}
              />
              <span>
                {baselineLocked
                  ? `The baseline is already set on ${shortDate(baseline!.date)} — these readings are read against it.`
                  : `These readings are the baseline set${
                      dropQ.data ? ` (equipment went in ${shortDate(dropQ.data)})` : ""
                    }`}
              </span>
            </label>

            {deltas.length > 0 && (
              <ul className="grid gap-y-0.5 text-xs">
                {deltas.map((d) => (
                  <li key={d.point} className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-muted-foreground">
                      {DRYING_POINT_LABEL[d.point] ?? d.point}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 tabular-nums",
                        d.verdict === "drying" && "text-success",
                        d.verdict === "wetter" && "text-warning",
                      )}
                    >
                      {describeDelta(d)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* The outside baseline — fetched, not typed. Inside the day's
            section because it is that day's figure. */}
          <div className="min-w-0 space-y-2 rounded-md border bg-muted/20 p-2.5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Outside</p>
                <p className="text-[11px] text-muted-foreground">
                  The baseline the job is judged against — fetched automatically, not typed.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11 shrink-0"
                onClick={() => runFetch()}
                disabled={fetching || !hasCoords || app.writesDisabled}
              >
                <RefreshCw className={`mr-1 size-4 ${fetching ? "animate-spin" : ""}`} />
                {outside.auto ? "Refresh" : "Fetch outside"}
              </Button>
            </div>

            {!hasCoords && !jobQ.isLoading ? (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
                <span>
                  This job has no coordinates, so its outside conditions can never be fetched
                  automatically. Fix the site address on the job so it geocodes, or enter the
                  reading by hand below.
                </span>
              </div>
            ) : fetchFailure ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 p-2 text-xs text-destructive">
                <CloudOff className="mt-0.5 size-3.5 shrink-0" />
                <span>{fetchFailure.message}</span>
              </div>
            ) : outside.manual ? (
              <p className="text-xs text-muted-foreground">
                A crew reading is on file for {shortDate(date)} —{" "}
                <span className="tabular-nums">
                  {outside.manual.temperature_f}°/{outside.manual.relative_humidity}%
                </span>
                . An automatic figure will not be written over it.
              </p>
            ) : outside.auto ? (
              <div className="space-y-1">
                <p className="text-sm tabular-nums">
                  {describeOutsideReading(outside.auto)}
                  {outside.auto.dew_point_f == null
                    ? ""
                    : ` · ${outside.auto.dew_point_f} °F dew point`}
                </p>
                <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
                  <CloudSun className="mt-0.5 size-3 shrink-0" />
                  <span>{outsideReadingNote(outside.auto)}</span>
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Not fetched yet for {shortDate(date)}. One tap fills it — and every other day of the
                past week that is missing one. It is meant to arrive by itself each morning; if it
                never does, the nightly job is not running on this deployment.
              </p>
            )}

            <button
              type="button"
              className="text-[11px] underline underline-offset-2 text-muted-foreground"
              onClick={toggleOverride}
            >
              {outsideOverride ? "Cancel manual outside reading" : "Enter outside by hand instead"}
            </button>

            {outsideOverride && (
              <div className="space-y-2">
                <p className="text-[11px] text-muted-foreground">
                  A meter in the driveway beats a grid model. This is saved as a crew reading and
                  the automatic figure is never written over it.
                </p>
                {outsideRows.map((r, i) => renderRow(r, i, outsideRows.length))}
              </div>
            )}
          </div>
        </div>

        {/* Two points side by side where there is room; one column on a
            phone, where the keypad wants the width. The cards can be dragged
            into the order the property is walked in — by the grip, so a tap
            on a field is still a tap on a field. */}
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onCardDragEnd}>
          <SortableContext items={cards.map((c) => c.key)} strategy={rectSortingStrategy}>
            <div className="grid gap-3 md:grid-cols-2">
              {cards.map((p) => {
                const mine = rows.filter((r) => r.point === p.key);
                return (
                  <SortableReadingCard key={p.key} id={p.key} title={p.label} why={p.why}>
                    {mine.map((r, i) => renderRow(r, i, mine.length))}
                    {REPEATS[p.key] && (
                      <Button
                        type="button"
                        variant="outline"
                        className="h-11 w-full"
                        onClick={() => addRow(p.key)}
                      >
                        <Plus className="mr-1 size-4" />
                        {REPEATS[p.key]}
                      </Button>
                    )}
                  </SortableReadingCard>
                );
              })}
            </div>
          </SortableContext>
        </DndContext>

        {/* Sticky so the save stays reachable at the bottom of a long form on
            a phone without scrolling back down past three sections.

            bottom-2 is right on a phone too, and above-mobile-nav would be
            wrong. The scroller is the shell's <main>, which already carries
            pb-[calc(4rem+safe-area)] for the bottom nav, and a sticky box
            sticks inside its scroller's padding, so this bar already rests
            8px above that 4rem, about 15px clear of the 57px nav (measured in
            Chrome at 360px wide). above-mobile-nav would add a second 4rem
            and leave the bar floating 70px up, readings showing through the
            gap beneath it. */}
        <div className="sticky bottom-2 z-10 pt-1">
          <Button
            className="h-12 w-full shadow-lg"
            onClick={save}
            disabled={busy || app.writesDisabled || readyCount === 0}
          >
            <Plus className="mr-1 size-4" />
            {readyCount === 0
              ? `Log readings for ${dayWord}`
              : `Log ${readyCount} reading${readyCount === 1 ? "" : "s"} for ${dayWord}`}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Leave a point blank if it was not read — nothing empty is saved, and the log shows the day
          as incomplete rather than inventing a number.
        </p>

        {/* Heshy's checklist, the advanced readings. Collapsed, below the
            daily save, each with its own save — the everyday walk above is
            not one box longer for them. */}
        <DehuReadingsDrawer
          date={date}
          dayWord={dayWord}
          dehus={dehusOnSite(placementsQ.data?.rows ?? [], date)}
          readings={readings}
          roomNames={roomNames}
          available={jobQ.data ? jobQ.data.classAvailable : true}
          disabled={app.writesDisabled}
          onSave={saveDehuPairs}
        />
        <MaterialPointsDrawer
          jobId={jobId}
          date={date}
          dayWord={dayWord}
          rooms={rooms}
          data={moistureQ.data}
          userId={app.userId}
          disabled={app.writesDisabled}
          onChanged={() => void qc.invalidateQueries({ queryKey: ["job-moisture", jobId] })}
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The full table — for the report, not the glance                 */}
      {/* ---------------------------------------------------------------- */}
      {log.days.length > 0 && (
        <>
          {/* Collapsed by default: the squares above answer the daily
              question, and the full grid is what goes in the report. */}
          <details className="group rounded-md border">
            <summary className="cursor-pointer select-none px-3 py-2 text-sm font-medium">
              Full log table
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                every reading, newest first
              </span>
            </summary>
            <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto border-t">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Day</TableHead>
                    {log.series.map((s) => (
                      <TableHead key={s.key} className="whitespace-nowrap">
                        {s.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {log.days.map((day) => (
                    <TableRow key={day.date} className={day.missing ? "bg-warning/5" : undefined}>
                      <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                        {shortDate(day.date)}
                      </TableCell>
                      {day.missing && Object.keys(day.bySeries).length === 0 ? (
                        <TableCell
                          colSpan={Math.max(1, log.series.length)}
                          className="text-xs text-warning"
                        >
                          No reading taken
                        </TableCell>
                      ) : (
                        log.series.map((s) => {
                          const taken = day.bySeries[s.key] ?? [];
                          const r = taken[0];
                          return (
                            <TableCell key={s.key} className="align-top">
                              {r ? (
                                <div className="leading-tight">
                                  <div className="flex items-center gap-1 text-[13px] font-medium tabular-nums">
                                    {r.dew_point_f ?? "—"} °F
                                    {r.source === "weather" && (
                                      <CloudSun
                                        className="size-3 text-muted-foreground"
                                        aria-label={outsideReadingNote(r)}
                                      />
                                    )}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground tabular-nums">
                                    {r.temperature_f}°/{r.relative_humidity}%
                                    {r.grains_per_pound == null
                                      ? ""
                                      : ` · ${r.grains_per_pound} gr/lb`}
                                  </div>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          );
                        })
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="flex items-start gap-1 border-t px-3 py-2 text-[11px] text-muted-foreground">
              <CloudSun className="mt-0.5 size-3 shrink-0" />
              <span>
                &ldquo;{MODELLED_EXTERIOR_LABEL}&rdquo; is not a crew reading.{" "}
                {automaticNotes.join(" ")} Every other column was read off a meter on site.
              </span>
            </p>
          </details>
        </>
      )}
    </div>
  );
}

/**
 * One reading card — Inside, Affected — that can be dragged into a different
 * slot. Only the grip starts a drag: the card is full of inputs and a select,
 * and a pointer landing on any of those has to keep meaning "type here".
 *
 * The dragged card keeps its slot as a dimmed outline, the way the dashboard
 * grid does it, so the gap the card will drop into stays visible.
 */
function SortableReadingCard({
  id,
  title,
  why,
  children,
}: {
  id: DryingPoint;
  title: string;
  why: string;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "space-y-2",
        isDragging &&
          "rounded-md opacity-40 outline-2 outline-dashed outline-offset-2 outline-primary/40",
      )}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          aria-label={`Drag to move the ${title} card`}
          title="Drag to move this card"
          className="-ml-1 mt-0.5 touch-none cursor-grab rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-4" />
        </button>
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-[11px] text-muted-foreground">{why}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

/**
 * One day on the calendar. Small on purpose: the date, the wettest room's dew
 * point, and — since 2026-09-04 — the OUT / IN pair, because those two beside
 * each other are what Melly asked for and what shows a property drying.
 *
 * The square did not grow to take them. The unaffected control moved off it
 * into the hover text: it is a per-room control, and this row is about the
 * building. The colour still says whether anyone logged the day — the nightly
 * weather fill alone leaves the square grey, because a modelled baseline is not
 * evidence that a crew visited.
 */
function DayTile({
  tile,
  materials,
  ctx,
  selected,
  onSelect,
}: {
  tile: DryingDayTile;
  /** Fixed test points that day: in play, and at their dry standard. */
  materials: MaterialsDay | null;
  ctx: OutsideContext;
  selected: boolean;
  onSelect: () => void;
}) {
  const outsideCell = describeOutsideCell(tile, ctx);
  const insideCell = describeInsideCell(tile, ctx);
  const figures = tileFigures(tile, ctx);
  const state =
    tile.status === "entered"
      ? `${tile.crewReadings} crew reading${tile.crewReadings === 1 ? "" : "s"}`
      : tile.status === "weather_only"
        ? "outside filled by the nightly job, no crew reading"
        : "nothing logged";
  // The same figures in a sentence, for a screen reader. Not a hiding place:
  // since 2026-10-05 every figure in here is also printed on the square.
  const detail = [
    state,
    tile.isBaseline ? "the baseline set" : null,
    // Always said, present or not. "no outside figure — this database is
    // refusing automatic outside readings" is the sentence that stops a crew
    // waiting all week for a number that is never coming.
    outsideCell.long,
    insideCell.long,
    tile.unaffectedDewPoint == null ? null : `unaffected ${tile.unaffectedDewPoint}°`,
    tile.affectedDewPoint == null ? null : `wettest affected ${tile.affectedDewPoint}°`,
    tile.meterPhotos > 0
      ? `${tile.meterPhotos} meter photo${tile.meterPhotos === 1 ? "" : "s"}`
      : null,
    materials
      ? `materials ${materials.dry} of ${materials.total} at dry standard, ${materials.read} read that day`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`${shortDate(tile.date)}${tile.isToday ? " (today)" : ""}: ${detail}`}
      title={detail}
      className={cn(
        // Top-aligned rather than spread: every square now has the same rows
        // in the same order, so the Dew line sits at the same height across
        // the whole strip and can be read along it.
        "flex flex-col gap-0.5 rounded-md border p-1.5 text-left leading-tight transition-colors",
        tile.status === "entered" && "border-success/60 bg-success/10 hover:bg-success/15",
        tile.status === "weather_only" && "bg-muted/60 hover:bg-muted",
        tile.status === "empty" && "border-dashed text-muted-foreground hover:bg-muted/40",
        tile.isBaseline && "ring-1 ring-inset ring-primary/50",
        selected && "ring-2 ring-primary ring-offset-1 ring-offset-background",
      )}
    >
      <span className="flex items-center justify-between gap-1 text-[11px] font-medium">
        <span className="whitespace-nowrap">{tile.isToday ? "Today" : shortDate(tile.date)}</span>
        <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
          {tile.isBaseline && <Flag className="size-3 text-primary" aria-hidden />}
          {tile.meterPhotos > 0 && <Camera className="size-3" aria-hidden />}
          {tile.outsideModelled && <CloudSun className="size-3" aria-hidden />}
        </span>
      </span>

      {/* Every figure on this square carries a label printed inside it.

          Mark, 2026-10-05: "for the temp readings, everything need to be
          labeled in the box." A crew on a phone cannot hover and a carrier
          reviewer reading a screenshot cannot either, so nothing here may
          exist only in the title text. The shape and the reasoning live with
          tileFigures in drying-day-grid.ts; this only draws it.

          No line may clip: `whitespace-nowrap`, and no ellipsis class anywhere in
          the figures. The strip was cutting "in n…" before any of this, and a
          number that is cut off is not on the screen. The widths were checked
          at 375px with three-digit temperatures and negative dew points. */}
      <span className="flex items-baseline justify-between gap-0.5 whitespace-nowrap">
        <span className="text-[10px] text-muted-foreground">{figures.affected.label}</span>
        <span className="text-xs font-semibold sm:text-[13px] tabular-nums text-foreground">
          {figures.affected.value}
        </span>
      </span>

      {/* Out and In as columns, Temp / RH / Dew as rows: each figure is
          labelled by the row it sits on and the column it sits in, and the
          out/in pair for each quantity is side by side on one line. The Dew
          row is the comparison a crew reads — inside falling towards outside
          is drying — so it is drawn a shade stronger.

          A side with no reading prints its word ("fetch", "none", "setup")
          down its column in place of the three figures. Never "out —". */}
      <span className="grid grid-cols-[auto_1fr_1fr] items-baseline gap-x-1 whitespace-nowrap text-[10px] leading-snug tabular-nums text-muted-foreground">
        <span className="col-start-2 text-right font-medium">{figures.out.heading}</span>
        <span className="col-start-3 text-right font-medium">{figures.in.heading}</span>
        {figures.rows.map((row, i) => (
          <Fragment key={row.label}>
            <span className={cn("col-start-1", row.compare && "font-medium text-foreground")}>
              {row.label}
            </span>
            {figures.out.word == null ? (
              <span
                className={cn(
                  "col-start-2 text-right",
                  row.compare && "font-medium text-foreground",
                )}
              >
                {row.out}
              </span>
            ) : (
              i === 0 && (
                <span
                  className={cn(
                    "col-start-2 row-span-3 self-center text-right",
                    figures.out.state === "blocked" && "text-destructive",
                    figures.out.state === "unfetched" && "italic",
                  )}
                >
                  {figures.out.word}
                </span>
              )
            )}
            {figures.in.word == null ? (
              <span
                className={cn(
                  "col-start-3 text-right",
                  row.compare && "font-medium text-foreground",
                )}
              >
                {row.in}
              </span>
            ) : (
              i === 0 && (
                <span
                  className={cn(
                    "col-start-3 row-span-3 self-center text-right",
                    figures.in.state === "blocked" && "text-destructive",
                  )}
                >
                  {figures.in.word}
                </span>
              )
            )}
          </Fragment>
        ))}
      </span>

      {/* Inside against the baseline: the one number that says whether the
          property is actually drying. Negative is drier. Labelled like every
          other figure — a bare "▼3.7" was a number nobody could name. */}
      {figures.insideVsBaseline && (
        <span className="flex items-baseline justify-between gap-1 whitespace-nowrap text-[10px] tabular-nums">
          <span className="text-muted-foreground">{figures.insideVsBaseline.label}</span>
          <span
            className={cn(
              "font-medium",
              figures.insideVsBaseline.drier ? "text-success" : "text-warning",
            )}
          >
            {figures.insideVsBaseline.value}
          </span>
        </span>
      )}

      {/* Heshy's "progress toward dry" on the timeline: test points at their
          dry standard out of those in play. Only drawn once a job has points,
          so a job without them keeps the square it had. */}
      {materials && (
        <span className="flex items-baseline justify-between gap-1 whitespace-nowrap text-[10px] tabular-nums">
          <span className="text-muted-foreground">Materials dry</span>
          <span
            className={cn(
              materials.dry === materials.total ? "text-success" : "text-muted-foreground",
            )}
          >
            {materials.dry}/{materials.total}
          </span>
        </span>
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* The water category                                                  */
/* ------------------------------------------------------------------ */

/**
 * Melly: "if it's a regular sink water category one, or a stormwater category
 * two, sewage is category three — it's a different type of category."
 *
 * At the top of the drying log because it governs everything under it: a
 * category 3 loss is not dried in place, so a crew reading dew points in a
 * sewage-flooded room needs to know that before they start.
 *
 * Never defaulted. An unset category reads as unset — guessing "clean" is the
 * guess that gets somebody's carpet dried instead of binned.
 */
function WaterCategoryPanel({
  value,
  available,
  disabled,
  onChange,
  classValue,
  classAvailable,
  onClassChange,
}: {
  value: number | null;
  available: boolean;
  disabled: boolean;
  onChange: (next: number | null) => Promise<void> | void;
  classValue: number | null;
  classAvailable: boolean;
  onClassChange: (next: number | null) => Promise<void> | void;
}) {
  const { bi } = useLabelLanguage();
  return (
    <div className="flex flex-col justify-between gap-3 rounded-md border p-3">
      {/* 11 Nov (client): each label above its full-width dropdown, no helper
          lines, spread over the box's height so it fills like the other two. */}
      <div className="space-y-1.5">
        <p className="text-sm font-medium">Water category</p>
        <Select
          value={value == null ? "none" : String(value)}
          disabled={disabled || !available}
          onValueChange={(v) => void onChange(v === "none" ? null : parseWaterCategory(v))}
        >
          <SelectTrigger className="h-11 w-full sm:h-10" aria-label="Water category">
            <SelectValue placeholder="Not set" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Not set</SelectItem>
            {WATER_CATEGORIES.map((c) => (
              <SelectItem key={c.value} value={String(c.value)}>
                {c.label} — {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isGrosslyContaminated(value) && (
        <p className="flex items-start gap-1.5 rounded-md border border-destructive/40 p-2 text-[11px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          <span>
            {describeWaterCategory(value)}. Porous materials are removed, not dried — the readings
            below document the structure, not a decision to dry what has to come out.
          </span>
        </p>
      )}

      {/* Says what was OBSERVED, not what is permanently true. PostgREST keeps
          a schema cache, so for a short while after 20260904090000 lands the
          column is really there and this probe still misses it — which is
          exactly what a user saw on 2026-09-07, with the column present in the
          database. An assertion that a migration is missing has to be
          falsifiable by reloading, and now it says so. */}
      {!available && (
        <p className="text-[11px] text-muted-foreground">
          This database did not report a water category column on jobs, so the category cannot be
          saved. If the 2026-09-04 migration has already been applied, reload the page — the API
          caches the schema for a short time after a migration lands.
        </p>
      )}

      {/* The CLASS, beside the category. Heshy's checklist asks for both: the
          category is how dirty the water was, the class is how much there is
          to evaporate and out of what — it sizes the equipment. Never
          defaulted, for the same reason the category is not. */}
      <div className="space-y-1.5 border-t pt-3">
        <p className="text-sm font-medium">{bi("Water class", "Clase de agua")}</p>
        <Select
          value={classValue == null ? "none" : String(classValue)}
          disabled={disabled || !classAvailable}
          onValueChange={(v) => void onClassChange(v === "none" ? null : parseWaterClass(v))}
        >
          <SelectTrigger className="h-11 w-full sm:h-10" aria-label="Water class">
            <SelectValue placeholder="Not set" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Not set</SelectItem>
            {WATER_CLASSES.map((c) => (
              <SelectItem key={c.value} value={String(c.value)}>
                {c.label} — {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!classAvailable && (
        <p className="text-[11px] text-muted-foreground">
          The water class arrives with 20260928160000_drying_class_dehu_inlet_hour_meters and cannot
          be saved until it is applied. If it has been, reload the page.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The meter photo                                                     */
/* ------------------------------------------------------------------ */

/**
 * A link to the photograph behind a reading already on file.
 *
 * The bucket is private and stays private, so the link is a short-lived signed
 * URL fetched on demand rather than a public path. Nothing is rendered when the
 * reading has no photo, or while the URL is still being minted — a broken
 * camera icon beside a reading reads as "the photo is gone", which is a
 * different and much worse claim than "there is no photo".
 */
function SavedMeterPhoto({ path }: { path: string | null | undefined }) {
  const q = useQuery({
    queryKey: ["drying-meter-photo-url", path ?? null],
    enabled: !!path,
    // Signed for ten minutes; refetched a minute early so a long shift never
    // clicks a link that expired while the panel sat open.
    staleTime: signedUrlStaleMs(),
    queryFn: () => signedMeterPhotoUrl(path!),
  });
  if (!path || !q.data) return null;
  return (
    // A 14px glyph was the whole target. The box grows to 44px only under
    // a finger, so the desktop list keeps its 18px rows.
    <a
      href={q.data}
      target="_blank"
      rel="noreferrer"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground touch:size-11"
      aria-label="Photo of the meter for this reading"
      title="Photo of the meter"
    >
      <Camera className="size-3.5 touch:size-4" />
    </a>
  );
}

/**
 * Take a photograph of the meter for one reading — or pick one already on the
 * device.
 *
 * TWO CONTROLS, NOT ONE. This was a single `<input capture="environment">`
 * behind one "Photo of the meter" button, and Mark asked on 2026-09-07 to "add
 * a camera option to take a picture of the meter". He was right that there was
 * not one: `capture` on a mobile browser does not add the camera to a file
 * picker, it REPLACES the picker with the camera, so a phone got the camera and
 * nothing else while a desktop got a file dialog and no camera. One button
 * cannot be both. So there are two inputs, differing only in `capture`, and the
 * button that opens each says which it is.
 *
 * `capture="environment"` asks for the REAR camera, which is the one that can
 * be pointed at an instrument while the technician reads it. A desktop browser
 * ignores the attribute and opens a file dialog, so "Take photo" degrades to
 * the same thing "Choose file" does rather than to nothing.
 *
 * Once a photo is attached, Retake reopens the camera directly: a meter
 * photographed with a thumb over the display is the common case, and making
 * that a delete-then-reattach is two taps in a wet basement.
 *
 * NOTHING ELSE IS NEW. The bytes go through the job photo module's encoder
 * (`makeVariants` via prepareMeterPhoto — a 2048px WebP and a 480px thumbnail,
 * made on the tablet before anything touches the network) and then through the
 * same offline queue as every other reading, because connectivity where a meter
 * is read is poor and a photo taken with no signal has to survive the drive
 * out. The bucket stays private; it is read back through a signed URL.
 */
function MeterPhotoField({
  photo,
  label,
  available,
  onPick,
  onClear,
}: {
  photo: MeterPhoto | null;
  label: string;
  available: boolean;
  onPick: (file: Blob) => Promise<void>;
  onClear: () => void;
}) {
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const previewUrl = useMemo(() => (photo ? URL.createObjectURL(photo.blob) : null), [photo]);
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  if (!available) return null;

  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    // Cleared before the await, so cancelling and re-choosing the SAME file
    // still fires a change event and the second attempt is not swallowed.
    e.target.value = "";
    if (!f) return;
    setBusy(true);
    try {
      await onPick(f);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {/* Identical but for `capture`. Both accept an image of any type the
          browser can hand over, including the HEIC an iPhone produces —
          prepareMeterPhoto keeps the original bytes when it cannot re-encode
          them, because a large photo beats no photo. */}
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        aria-label={`${label} — take with the camera`}
        onChange={(e) => void pick(e)}
      />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        aria-label={`${label} — choose an existing file`}
        onChange={(e) => void pick(e)}
      />
      {photo && previewUrl ? (
        <>
          <img
            src={previewUrl}
            alt={label}
            className="size-11 shrink-0 rounded-md border object-cover"
          />
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            Meter photo attached
          </span>
          <Button
            type="button"
            variant="ghost"
            className="h-11 shrink-0 px-2 text-[11px] text-muted-foreground"
            disabled={busy}
            aria-label={`Retake ${label}`}
            onClick={() => cameraRef.current?.click()}
          >
            <Camera className="mr-1 size-4" />
            {busy ? "Preparing…" : "Retake"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 text-muted-foreground"
            aria-label={`Remove ${label}`}
            onClick={onClear}
          >
            <X className="size-4" />
          </Button>
        </>
      ) : (
        <div className="grid w-full grid-cols-2 gap-2">
          {/* The camera first and wider on the phrasing, because standing in
              front of the meter is the flow this exists for. */}
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full justify-start text-muted-foreground"
            disabled={busy}
            aria-label={`${label}: take a photo with the camera`}
            onClick={() => cameraRef.current?.click()}
          >
            <Camera className="mr-2 size-4 shrink-0" />
            <span className="truncate">{busy ? "Preparing…" : "Take photo"}</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full justify-start text-muted-foreground"
            disabled={busy}
            aria-label={`${label}: choose an existing photo`}
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus className="mr-2 size-4 shrink-0" />
            <span className="truncate">Choose file</span>
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Rows of day squares on screen before the strip scrolls. 5 Nov: "after 4
 * rows make scroll"; 6 Nov, David: "cut it down to three instead of four" so
 * the strip ends level with the two charts beside it ("I like when it's
 * lined up").
 */
const DAY_ROWS_SHOWN = 3;

/** Where the Days card's Grid / Day by day choice is remembered. */
const DAYS_VIEW_KEY = "drying-days-view";

/**
 * A grid cut at the bottom of its Nth row, the rest scrolling inside it.
 * Measured, not a fixed height: a row is three squares on a phone and seven
 * on a wide screen, and a square's height follows its figures. The day being
 * logged is scrolled into view, so picking one never hides it.
 */
function RowCappedGrid({
  rows,
  selectedKey,
  className,
  children,
}: {
  rows: number;
  selectedKey: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const items = [...grid.children] as HTMLElement[];
      const tops = [...new Set(items.map((el) => el.offsetTop))].sort((a, b) => a - b);
      if (tops.length <= rows) return setMaxHeight(null);
      const lastRow = items.filter((el) => el.offsetTop === tops[rows - 1]);
      const bottom = Math.max(...lastRow.map((el) => el.offsetTop + el.offsetHeight));
      const next = bottom - grid.offsetTop + 2;
      setMaxHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(grid);
    return () => ro.disconnect();
  }, [children, rows]);

  useEffect(() => {
    const grid = ref.current;
    if (!grid || maxHeight == null) return;
    const el = grid.querySelector<HTMLElement>('[aria-pressed="true"], [data-selected="true"]');
    if (!el) return;
    const top = el.offsetTop - grid.offsetTop;
    if (top < grid.scrollTop || top + el.offsetHeight > grid.scrollTop + grid.clientHeight)
      grid.scrollTo({ top: Math.max(0, top - 4) });
  }, [selectedKey, maxHeight]);

  return (
    <div
      ref={ref}
      data-day-strip
      className={cn(className, maxHeight != null && "overflow-y-auto overscroll-contain pr-1")}
      style={maxHeight != null ? { maxHeight } : undefined}
    >
      {children}
    </div>
  );
}
