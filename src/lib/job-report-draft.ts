/**
 * Writing a loss report from the job's facts.
 *
 * Mark, 13 Oct: "make these reports much smarter and better, use a better ai
 * engine". The draft read like a database dump: the crew's text-message notes
 * pasted in raw, and labour as "a crew of 17 people worked 136 man-hours over 1
 * day on site, accounting for 17 crew-days". This file is the writing half:
 *
 *  1. `buildReportFacts` turns the (already redacted and section-narrowed)
 *     snapshot into a clean, structured brief: dates in words, crew notes as
 *     sentences (crew-notes.ts), field forms oldest first, equipment with its
 *     placed/removed dates and counts, drying points against their goals, and
 *     the outstanding items the data itself shows. Every number the report may
 *     use is in here, so the provenance check (report-provenance.ts) can hold
 *     the draft to it.
 *  2. `reportOutline` is the carrier-ready running order — summary of loss,
 *     cause and affected areas, mitigation by day, drying, equipment, labour,
 *     outstanding items — restricted to the parts the sender ticked.
 *  3. `templateReport` writes that outline without a model, for when no AI is
 *     configured or every model call fails. Plain, but clean.
 *  4. `draftJobReport` runs the model plan (strongest model first), rewrites
 *     once if the draft quotes figures or uses a number the facts do not hold,
 *     marks whatever is still unsupported, and falls back to the template.
 *
 * Nothing here talks to the network: the model call is injected, so every
 * path is a unit test.
 */
import { waterCategoryInfo } from "@/lib/water-category";
import { waterClassInfo } from "@/lib/water-class";
import type { AiProviderName } from "@/lib/ai-provider.server";
import { cleanCrewNote } from "@/lib/crew-notes";
import {
  JOB_TYPE_OPTIONS,
  MATERIAL_OPTIONS,
  SCOPE_OPTIONS,
  TRASH_OPTIONS,
} from "@/lib/field-work-ticket";
import { equipmentLeftSentence, type EquipmentLeft } from "@/lib/job-report-field-forms";
import {
  indexFacts,
  markUnsupported,
  provenanceInstruction,
  unsupportedFigures,
  type ProvenanceProblem,
} from "@/lib/report-provenance";
import { crewForModel, rewriteInstruction, voiceProblems } from "@/lib/report-voice";

type Obj = Record<string, unknown>;
export type ReportFacts = Obj;

const OFFICE_TIME_ZONE = "America/New_York";
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-09-23" or an ISO instant → "September 23, 2026". Null for anything else. */
export function longDate(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  let ymd = v;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) return null;
    ymd = new Intl.DateTimeFormat("en-CA", {
      timeZone: OFFICE_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }
  const [y, m, d] = ymd.split("-").map(Number);
  if (!y || !m || !d || m > 12) return null;
  return `${MONTH_NAMES[m - 1]} ${d}, ${y}`;
}

/** "water_mitigation" → "Water mitigation". */
function words(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = v.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const OPTION_LABEL = new Map(
  [...JOB_TYPE_OPTIONS, ...SCOPE_OPTIONS, ...MATERIAL_OPTIONS, ...TRASH_OPTIONS].map((o) => [
    o.key,
    o.en,
  ]),
);

function optionList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" && v ? [v] : [];
  return arr
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .map((x) => OPTION_LABEL.get(x) ?? words(x) ?? x);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Drops null, empty strings and empty arrays so the brief carries only what exists. */
function compact<T extends Obj>(o: T): Partial<T> {
  const out: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

const EQUIPMENT_TYPE: Record<string, [string, string]> = {
  air_mover: ["air mover", "air movers"],
  dehumidifier: ["dehumidifier", "dehumidifiers"],
  air_scrubber: ["air scrubber", "air scrubbers"],
  hepa: ["HEPA unit", "HEPA units"],
  heater: ["heater", "heaters"],
  generator: ["generator", "generators"],
  moisture_meter: ["moisture meter", "moisture meters"],
};

function machineWords(type: string | null, n: number): string {
  const [one, many] = EQUIPMENT_TYPE[type ?? ""] ?? ["machine", "machines"];
  return n === 1 ? one : many;
}

/** "2 dehumidifiers and 3 air movers" from placements, counted by type. */
function countByType(rows: readonly { type: string | null }[]): string | null {
  const counts = new Map<string | null, number>();
  for (const r of rows) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const left: EquipmentLeft[] = [...counts.entries()].map(([type, n]) => ({
    item: machineWords(type, n),
    count: n,
  }));
  return equipmentLeftSentence(left);
}

/* ------------------------------------------------------------------ */
/* 1. The facts                                                        */
/* ------------------------------------------------------------------ */

export function buildReportFacts(
  snapshot: Obj,
  opts: { photosAttached?: boolean } = {},
): ReportFacts {
  const job = (snapshot["job"] ?? {}) as Obj;
  const facts: Obj = {};

  facts["claim"] = compact({
    job_number: str(job["job_number"]),
    job_name: str(job["job_name"]),
    customer: str(job["customer_name"]),
    property_manager_or_account: str(job["account_name"]),
    property_address: str(job["address"]),
    loss_type: words(job["loss_type"]),
    date_of_loss: longDate(job["loss_date"]),
    // No date reported / time reported: off client reports (David, 27 Oct).
    first_response: longDate(job["first_response_at"]),
    insurance_carrier: str(job["carrier"]),
    claim_number: str(job["claim_number"]),
    adjuster: str(job["adjuster_name"]),
    job_status: words(job["status"]),
  });

  const category = waterCategoryInfo(job["water_category"]);
  const waterClass = waterClassInfo(job["water_class"]);
  const loss = compact({
    description: str(job["initial_loss_description"]),
    scope: str(job["scope"]),
    // "Category 2 (gray water)", "Class 2 (significant water, fast evaporation)".
    water_category: category ? `${category.label} (${category.name.toLowerCase()} water)` : null,
    water_class: waterClass
      ? `${waterClass.label} (${waterClass.name.toLowerCase().replace(" — ", ", ")})`
      : null,
  });
  if (Object.keys(loss).length > 0) facts["loss"] = loss;

  // Dates & timeline
  const timeline = snapshot["timeline"] as Obj | undefined;
  if (timeline) {
    const history = (timeline["status_history"] ?? []) as Obj[];
    facts["key_dates"] = compact({
      date_of_loss: longDate(job["loss_date"]),
      first_response: longDate(job["first_response_at"]),
      work_started: longDate(job["start_date"]),
      work_completed: longDate(job["completion_date"]),
      days_from_loss_to_first_response: num(timeline["days_loss_to_response"]),
      days_from_start_to_completion: num(timeline["days_start_to_completion"]),
      status_changes: history.map((h) =>
        compact({
          date: longDate(h["changed_at"]),
          from: words(h["from_status"]),
          to: words(h["to_status"]),
        }),
      ),
    });
  }

  /*
   * T3 (David, 27 Oct): each regeneration read longer than the last. Nothing
   * is appended from the previous version — every version is written fresh
   * from the job — but the same visit text was handed over several times: a
   * crew note copied onto every day's form, the same words again as a job
   * note, and earlier report PDFs listed back under Documents. Each thing is
   * now given to the writer once.
   */
  const said = new Set<string>();
  const firstSaying = (text: string | null | undefined): string | null => {
    const t = (text ?? "").trim();
    if (!t) return null;
    const key = t
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[.!]+$/, "");
    if (said.has(key)) return null;
    said.add(key);
    return t;
  };

  // Field form updates → mitigation performed, by day, oldest first.
  const forms = snapshot["field_forms"] as Obj[] | undefined;
  if (forms) {
    facts["mitigation_by_day"] = [...forms]
      .sort((a, b) => String(a["work_date"] ?? "").localeCompare(String(b["work_date"] ?? "")))
      .map((f) =>
        compact({
          date: longDate(f["work_date"]),
          crew_chief: str(f["crew_chief"]),
          work_types: optionList(f["job_types"]),
          scope_completed: optionList(f["scope_completed"]),
          materials_used: optionList(f["materials_used"]),
          crew_notes: firstSaying(cleanCrewNote(str(f["work_notes"]))),
          debris: optionList(f["trash"]).join(", ") || null,
          equipment_left_on_site: equipmentLeftSentence(
            (f["equipment_left"] ?? []) as EquipmentLeft[],
          ),
          status: str(f["status"]),
        }),
      );
  }

  // Drying progress — crew measurements only (job-report-drying.ts).
  const drying = snapshot["drying"] as Obj | null | undefined;
  if ("drying" in snapshot) {
    if (!drying) {
      facts["drying"] = { readings: "Drying readings could not be read for this job." };
    } else {
      const points = (drying["moisture_points"] ?? []) as Obj[];
      const air = drying["affected_air"] as Obj | null;
      facts["drying"] = compact({
        material_points: points.map((p) => {
          const first = p["first_reading"] as Obj | null;
          const latest = p["latest_reading"] as Obj | null;
          return compact({
            room: str(p["room"]),
            material: str(p["material"]),
            location: str(p["location"]),
            dry_goal_pct: num(p["dry_goal_pct"]),
            first_reading: first
              ? { date: longDate(first["date"]), moisture_pct: num(first["moisture_pct"]) }
              : null,
            latest_reading:
              latest && (!first || latest["date"] !== first["date"])
                ? { date: longDate(latest["date"]), moisture_pct: num(latest["moisture_pct"]) }
                : null,
            goal_met_on: longDate(p["goal_met_on"]),
            at_goal_now: typeof p["at_goal_now"] === "boolean" ? p["at_goal_now"] : null,
            material_removed: p["material_removed"] === true ? true : null,
          });
        }),
        material_points_at_goal:
          (num(drying["points_total"]) ?? 0)
            ? `${num(drying["points_at_goal"]) ?? 0} of ${num(drying["points_total"])}`
            : null,
        days_with_crew_readings: num(drying["crew_reading_days"]) || null,
        first_crew_reading: longDate(drying["first_crew_reading"]),
        last_crew_reading: longDate(drying["last_crew_reading"]),
        affected_area_air: air
          ? {
              first: {
                date: longDate((air["first"] as Obj)["date"]),
                grains_per_pound: num((air["first"] as Obj)["grains_per_pound"]),
              },
              latest: {
                date: longDate((air["latest"] as Obj)["date"]),
                grains_per_pound: num((air["latest"] as Obj)["grains_per_pound"]),
              },
            }
          : null,
        affected_rooms: (drying["affected_rooms"] ?? []) as string[],
      });
    }
  }

  // Equipment on site
  if ("equipment" in snapshot || "equipment_from_field_forms" in snapshot) {
    const placements = ((snapshot["equipment"] ?? []) as Obj[])
      .map((p) => ({
        type: str(p["type"]),
        name: str(p["name"]),
        asset_tag: str(p["asset_tag"]),
        placed_at: str(p["placed_at"]),
        retrieved_at: str(p["retrieved_at"]),
        days_on_site: num(p["days_on_site"]),
        still_on_site: p["still_on_site"] === true,
        note: str(p["note"]),
      }))
      .sort((a, b) => (a.placed_at ?? "").localeCompare(b.placed_at ?? ""));
    const still = placements.filter((p) => p.still_on_site);
    const forms = snapshot["equipment_from_field_forms"] as Obj | undefined;
    const latest = forms?.["latest"] as Obj | null | undefined;
    facts["equipment"] = compact({
      placements: placements.map((p) =>
        compact({
          machine: [words(p.type), p.name].filter(Boolean).join(" — ") || "Machine",
          asset_tag: p.asset_tag,
          placed_on: longDate(p.placed_at),
          removed_on: longDate(p.retrieved_at),
          days_on_site: p.days_on_site,
          still_on_site: p.still_on_site ? true : null,
          note: p.note,
        }),
      ),
      machines_placed: placements.length || null,
      machines_placed_by_type: countByType(placements),
      machines_still_on_site: still.length || null,
      machines_still_on_site_by_type: countByType(still),
      machines_removed: placements.length - still.length || null,
      most_left_on_site_at_once_by_crew: str(forms?.["peak_sentence"]),
      latest_left_on_site_by_crew: latest
        ? compact({ date: longDate(latest["work_date"]), machines: str(latest["sentence"]) })
        : null,
    });
  }

  // Crew & hours
  const crew = snapshot["crew"] as Obj | undefined;
  if (crew) {
    const c = crewForModel(crew);
    const byDay = ((c["by_day"] ?? []) as Obj[])
      .filter((d) => d["date"])
      .sort((a, b) => String(a["date"]).localeCompare(String(b["date"])));
    const daysOnSite = num(c["days_on_site"]) ?? (byDay.length || null);
    const crewDays = num(c["crew_days"]);
    const people = num(c["distinct_people"]);
    facts["labor"] = compact({
      man_hours_on_site: num(c["man_hours_on_site"]),
      days_on_site: daysOnSite,
      // Equal to people × one day on a single-day job: saying it again is the
      // "17 people … accounting for 17 crew-days" Mark read out.
      crew_days: daysOnSite === 1 && crewDays === people ? null : crewDays,
      people_on_job: people,
      largest_crew_on_one_day: num(c["peak_crew"]),
      first_day_on_site: longDate(byDay[0]?.["date"]),
      last_day_on_site: byDay.length > 1 ? longDate(byDay[byDay.length - 1]?.["date"]) : null,
      by_day:
        byDay.length > 1
          ? byDay.map((d) =>
              compact({
                date: longDate(d["date"]),
                crew_size: num(d["crew_size"]),
                man_hours: num(d["hours"]),
              }),
            )
          : null,
      crew_roles: ((c["assignments"] ?? []) as Obj[])
        .map((a) => words(a["role"]))
        .filter((r): r is string => !!r),
    });
  }

  // Job notes
  const notes = snapshot["notes"] as Obj[] | undefined;
  if (notes) {
    facts["job_notes"] = notes
      .map((n) =>
        compact({
          date: longDate(n["created_at"]),
          note: firstSaying(cleanCrewNote(str(n["body"]))),
        }),
      )
      .filter((n) => n.note);
  }

  // Documents
  const documents = snapshot["documents"] as Obj[] | undefined;
  if (documents) {
    // A report never lists earlier versions of itself.
    facts["documents"] = documents
      .filter((d) => d["doc_type"] !== "job_report")
      .map((d) =>
        compact({
          name: str(d["name"]),
          type: words(d["doc_type"]),
          status: words(d["status"]),
          filed_on: longDate(d["created_at"]),
          signed_on: longDate(d["signed_at"]),
        }),
      );
  }

  // Money — only present when ticked and the role may see it.
  for (const k of ["money", "estimates", "calculator_estimates", "invoices", "payments"]) {
    if (k in snapshot) facts[k] = snapshot[k];
  }
  if (snapshot["financials_note"]) facts["financials_note"] = snapshot["financials_note"];

  if (Array.isArray(snapshot["missing"])) facts["missing"] = snapshot["missing"];

  if (opts.photosAttached)
    facts["photographs"] = "A set of photographs is attached to this report.";

  const outstanding = outstandingItems(facts);
  if (outstanding.length > 0) facts["outstanding_items"] = outstanding;

  return facts;
}

/**
 * Open items the facts themselves show — never inferred beyond them: machines
 * still on site, the latest visit's open status, materials not yet at goal.
 */
function outstandingItems(facts: Obj): string[] {
  const out: string[] = [];
  const eq = facts["equipment"] as Obj | undefined;
  if (eq?.["machines_still_on_site_by_type"]) {
    out.push(`Still on site: ${eq["machines_still_on_site_by_type"]}.`);
  }
  const days = facts["mitigation_by_day"] as Obj[] | undefined;
  const last = days?.[days.length - 1];
  const status = str(last?.["status"]);
  if (status && !/^Work on this visit is complete\.$/.test(status)) {
    out.push(last?.["date"] ? `As of ${last["date"]}: ${status}` : status);
  }
  const drying = facts["drying"] as Obj | undefined;
  for (const p of (drying?.["material_points"] ?? []) as Obj[]) {
    if (p["at_goal_now"] !== false || p["material_removed"]) continue;
    const reading = (p["latest_reading"] ?? p["first_reading"]) as Obj | undefined;
    const where = [p["room"], p["material"]].filter(Boolean).join(" — ");
    if (reading && p["dry_goal_pct"] != null) {
      out.push(
        `${where}: ${reading["moisture_pct"]}% on ${reading["date"]}, above its dry goal of ${p["dry_goal_pct"]}%.`,
      );
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 2. The running order                                                */
/* ------------------------------------------------------------------ */

export type OutlineSection = { heading: string; guidance: string };

/** The carrier-ready order, limited to the parts the facts actually carry. */
export function reportOutline(facts: ReportFacts): OutlineSection[] {
  const has = (k: string) => {
    const v = facts[k];
    return (
      v != null &&
      !(Array.isArray(v) && v.length === 0) &&
      !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as Obj).length === 0)
    );
  };
  const drying = facts["drying"] as Obj | undefined;
  const out: OutlineSection[] = [
    {
      heading: "Summary of loss",
      guidance:
        "Two to four sentences: the property and customer, the claim (carrier, claim number, adjuster " +
        "when given), the type and date of loss, and where the job stands. Use only `claim`. " +
        // 12 Nov: a job with no claim number came back as "claim number 2609221".
        "`job_number` is Gold Star's own job number, never a claim number: give a claim number only " +
        "when `claim_number` is present, and otherwise do not mention one.",
    },
  ];
  const forms = (facts["mitigation_by_day"] ?? []) as Obj[];
  if (
    has("loss") ||
    forms.some((f) => f["work_types"]) ||
    (drying?.["affected_rooms"] as unknown[] | undefined)?.length
  ) {
    out.push({
      heading: "Cause and affected areas",
      guidance:
        "What happened and which areas were affected, from `loss`, the work types in " +
        "`mitigation_by_day` and `drying.affected_rooms`, with the water category and class from `loss` " +
        "when given (IICRC S500 terms, as written). State a cause only if one is written; never infer one.",
    });
  }
  if (has("key_dates")) {
    out.push({ heading: "Key dates", guidance: "The dates in `key_dates`, in order, as prose." });
  }
  if (has("mitigation_by_day")) {
    out.push({
      heading: "Mitigation performed",
      guidance:
        "A summary of the work to date from `mitigation_by_day` — what has been done, materials used, " +
        "what is on site now and the crew's notes — merged into one account of the job as it stands, " +
        "not a diary of every visit. Group visits that did the same work; give a date only where it " +
        "marks a change. Never repeat a sentence. Never paste a note verbatim if it reads like " +
        "shorthand; keep every time, unit and quantity exactly as given.",
    });
  }
  if (has("drying")) {
    out.push({
      heading: "Drying progress",
      guidance:
        "From `drying`: each material's first and latest reading against its dry goal and the day the " +
        "goal was met, then the affected-area air readings. These are the crew's own measurements.",
    });
  }
  if (has("equipment")) {
    out.push({
      heading: "Equipment",
      guidance:
        "From `equipment`: what was placed and when, what was removed and when, how long it stayed, and " +
        "what is still on site, with the counts given.",
    });
  }
  if (has("labor")) {
    out.push({
      heading: "Labor",
      guidance:
        "From `labor`, in one or two plain sentences: who worked, on which days and for how many " +
        "man-hours. Each figure once. Never restate one figure under another name.",
    });
  }
  if (has("job_notes")) {
    out.push({ heading: "Job notes", guidance: "The points in `job_notes`, as sentences." });
  }
  if (has("documents")) {
    out.push({ heading: "Documents", guidance: "Each item in `documents` and where it stands." });
  }
  if (has("money") || has("estimates") || has("calculator_estimates")) {
    out.push({ heading: "Amounts", guidance: "The figures in `money` and the estimates." });
  }
  if (has("invoices")) {
    out.push({ heading: "Invoices", guidance: "Each invoice and the payments against it." });
  }
  if (has("missing")) {
    out.push({
      heading: "What this job does not have yet",
      guidance: "Each line of `missing`, stated plainly as a fact about the job.",
    });
  }
  if (has("outstanding_items")) {
    out.push({
      heading: "Outstanding items and next steps",
      guidance: "Only the items in `outstanding_items`. Do not add next steps of your own.",
    });
  }
  return out;
}

export function outlineInstruction(outline: readonly OutlineSection[]): string {
  return (
    "REPORT OUTLINE — use these headings, in this order, and no others. Leave out a heading whose " +
    "data is not in the JOB DATA:\n" +
    outline.map((s, i) => `${i + 1}. ${s.heading} — ${s.guidance}`).join("\n")
  );
}

/* ------------------------------------------------------------------ */
/* 3. The template draft                                               */
/* ------------------------------------------------------------------ */

const sentence = (s: string) => {
  const t = s.trim();
  if (!t) return "";
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
};
const list = (xs: readonly string[]) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const money = (v: unknown) => {
  const n = num(v);
  return n == null
    ? null
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function summarySection(f: Obj): string {
  const c = (f["claim"] ?? {}) as Obj;
  const parts: string[] = [];
  const job = c["job_name"]
    ? `${c["job_name"]}${c["job_number"] ? ` (job ${c["job_number"]})` : ""}`
    : c["job_number"]
      ? `Job ${c["job_number"]}`
      : "This job";
  parts.push(
    sentence(
      `${job}${c["property_address"] ? ` at ${c["property_address"]}` : ""}` +
        `${c["customer"] ? `, for ${c["customer"]}` : ""}` +
        `${c["property_manager_or_account"] ? ` (${c["property_manager_or_account"]})` : ""}`,
    ),
  );
  if (c["loss_type"] || c["date_of_loss"]) {
    parts.push(
      sentence(
        `${c["loss_type"] ? `${c["loss_type"]} loss` : "Loss"}` +
          `${c["date_of_loss"] ? ` on ${c["date_of_loss"]}` : ""}`,
      ),
    );
  }
  if (c["first_response"]) parts.push(sentence(`First response on ${c["first_response"]}`));
  if (c["insurance_carrier"] || c["claim_number"]) {
    parts.push(
      sentence(
        [
          c["insurance_carrier"] ? `Carrier: ${c["insurance_carrier"]}` : null,
          c["claim_number"] ? `claim number ${c["claim_number"]}` : null,
          c["adjuster"] ? `adjuster ${c["adjuster"]}` : null,
        ]
          .filter(Boolean)
          .join(", "),
      ),
    );
  }
  if (c["job_status"])
    parts.push(sentence(`Current status: ${String(c["job_status"]).toLowerCase()}`));
  return parts.join(" ");
}

function causeSection(f: Obj): string {
  const loss = (f["loss"] ?? {}) as Obj;
  const parts: string[] = [];
  if (loss["description"]) parts.push(sentence(String(loss["description"])));
  if (loss["scope"]) parts.push(sentence(`Scope: ${loss["scope"]}`));
  if (loss["water_category"] || loss["water_class"]) {
    parts.push(
      sentence(
        `The loss is classified as ${[loss["water_category"], loss["water_class"]]
          .filter(Boolean)
          .join(", ")} under IICRC S500`,
      ),
    );
  }
  const types = [
    ...new Set(
      ((f["mitigation_by_day"] ?? []) as Obj[]).flatMap((d) => (d["work_types"] ?? []) as string[]),
    ),
  ];
  if (types.length)
    parts.push(sentence(`Type of work: ${list(types.map((t) => t.toLowerCase()))}`));
  const rooms = ((f["drying"] as Obj | undefined)?.["affected_rooms"] ?? []) as string[];
  if (rooms.length) parts.push(sentence(`Affected areas: ${list(rooms)}`));
  return parts.join(" ");
}

function keyDatesSection(f: Obj): string {
  const k = (f["key_dates"] ?? {}) as Obj;
  const lines: string[] = [];
  const add = (label: string, key: string) => {
    if (k[key]) lines.push(`${label}: ${k[key]}.`);
  };
  add("Date of loss", "date_of_loss");
  add("First response", "first_response");
  add("Work started", "work_started");
  add("Work completed", "work_completed");
  if (k["days_from_loss_to_first_response"] != null) {
    lines.push(
      `First response came ${plural(Number(k["days_from_loss_to_first_response"]), "day", "days")} after the loss.`,
    );
  }
  for (const s of (k["status_changes"] ?? []) as Obj[]) {
    if (!s["to"]) continue;
    lines.push(
      sentence(
        `${s["date"] ? `${s["date"]}: ` : ""}moved ${s["from"] ? `from ${String(s["from"]).toLowerCase()} ` : ""}to ${String(s["to"]).toLowerCase()}`,
      ),
    );
  }
  return lines.join("\n");
}

function mitigationSection(f: Obj): string {
  return ((f["mitigation_by_day"] ?? []) as Obj[])
    .map((d) => {
      const bits: string[] = [];
      if (d["crew_chief"]) bits.push(`Crew chief ${d["crew_chief"]}.`);
      if (d["work_types"])
        bits.push(sentence(`Work: ${list(d["work_types"] as string[]).toLowerCase()}`));
      if (d["scope_completed"])
        bits.push(sentence(`Completed: ${list(d["scope_completed"] as string[]).toLowerCase()}`));
      if (d["materials_used"])
        bits.push(
          sentence(`Materials used: ${list(d["materials_used"] as string[]).toLowerCase()}`),
        );
      if (d["crew_notes"]) bits.push(sentence(String(d["crew_notes"])));
      if (d["equipment_left_on_site"])
        bits.push(sentence(`Left on site: ${d["equipment_left_on_site"]}`));
      if (d["debris"]) bits.push(sentence(`Debris: ${String(d["debris"]).toLowerCase()}`));
      if (d["status"]) bits.push(sentence(String(d["status"])));
      return `${d["date"] ?? "Undated visit"}: ${bits.join(" ")}`.trim();
    })
    .join("\n");
}

function dryingSection(f: Obj): string {
  const d = (f["drying"] ?? {}) as Obj;
  const lines: string[] = [];
  if (d["readings"]) lines.push(String(d["readings"]));
  for (const p of (d["material_points"] ?? []) as Obj[]) {
    const where =
      [p["room"], p["material"]].filter(Boolean).join(" — ") +
      (p["location"] ? ` (${p["location"]})` : "");
    const first = p["first_reading"] as Obj | undefined;
    const latest = p["latest_reading"] as Obj | undefined;
    let line = `${where}: `;
    if (first) line += `${first["moisture_pct"]}% on ${first["date"]}`;
    if (latest) line += `${first ? ", " : ""}${latest["moisture_pct"]}% on ${latest["date"]}`;
    if (!first && !latest) line += "no reading yet";
    if (p["dry_goal_pct"] != null) {
      line += `; dry goal ${p["dry_goal_pct"]}%`;
      line += p["goal_met_on"] ? `, met on ${p["goal_met_on"]}` : ", not yet met";
    } else {
      line += "; no dry goal set";
    }
    line += ".";
    if (p["material_removed"]) line += " The material was removed.";
    lines.push(line);
  }
  if (d["material_points_at_goal"]) {
    lines.push(`Material points at their dry goal: ${d["material_points_at_goal"]}.`);
  }
  const air = d["affected_area_air"] as Obj | undefined;
  if (air) {
    const a = air["first"] as Obj;
    const b = air["latest"] as Obj;
    lines.push(
      a["date"] === b["date"]
        ? `Affected-area air: ${a["grains_per_pound"]} grains per pound on ${a["date"]}.`
        : `Affected-area air went from ${a["grains_per_pound"]} grains per pound on ${a["date"]} to ${b["grains_per_pound"]} on ${b["date"]}.`,
    );
  }
  if (d["days_with_crew_readings"]) {
    lines.push(
      `The crew took readings on ${plural(Number(d["days_with_crew_readings"]), "day", "days")}` +
        (d["first_crew_reading"] &&
        d["last_crew_reading"] &&
        d["first_crew_reading"] !== d["last_crew_reading"]
          ? `, from ${d["first_crew_reading"]} to ${d["last_crew_reading"]}.`
          : d["first_crew_reading"]
            ? `, on ${d["first_crew_reading"]}.`
            : "."),
    );
  }
  return lines.join("\n");
}

function equipmentSection(f: Obj): string {
  const e = (f["equipment"] ?? {}) as Obj;
  const lines: string[] = [];
  if (e["machines_placed_by_type"]) {
    lines.push(
      sentence(
        `Placed on site: ${e["machines_placed_by_type"]}` +
          (e["machines_still_on_site_by_type"]
            ? `; still on site: ${e["machines_still_on_site_by_type"]}`
            : "; all removed"),
      ),
    );
  }
  for (const p of (e["placements"] ?? []) as Obj[]) {
    let line = `${p["machine"]}${p["asset_tag"] ? ` (${p["asset_tag"]})` : ""}: placed ${p["placed_on"] ?? "on an unstated date"}`;
    line += p["removed_on"]
      ? `, removed ${p["removed_on"]}`
      : p["still_on_site"]
        ? ", still on site"
        : "";
    if (p["days_on_site"] != null)
      line += `, ${plural(Number(p["days_on_site"]), "day", "days")} on site`;
    line += ".";
    if (p["note"]) line += ` ${sentence(String(p["note"]))}`;
    lines.push(line);
  }
  const latest = e["latest_left_on_site_by_crew"] as Obj | undefined;
  if (e["most_left_on_site_at_once_by_crew"]) {
    lines.push(
      sentence(`Most equipment on site at once: ${e["most_left_on_site_at_once_by_crew"]}`),
    );
  }
  if (latest?.["machines"]) {
    lines.push(
      sentence(
        `Left on site${latest["date"] ? ` as of ${latest["date"]}` : ""}: ${latest["machines"]}`,
      ),
    );
  }
  return lines.join("\n");
}

function laborSection(f: Obj): string {
  const l = (f["labor"] ?? {}) as Obj;
  const hours = num(l["man_hours_on_site"]);
  const days = num(l["days_on_site"]);
  const crew = num(l["largest_crew_on_one_day"]) ?? num(l["people_on_job"]);
  if (!hours) return "No crew hours on this job yet.";
  if (days === 1 || (!days && !l["last_day_on_site"])) {
    return sentence(
      `${l["first_day_on_site"] ? `On ${l["first_day_on_site"]}, ` : ""}` +
        `${crew ? `a crew of ${crew}` : "the crew"} worked ${hours} man-hours on site`,
    );
  }
  const lines = [
    sentence(
      `Crews worked on site on ${plural(days ?? 0, "day", "days")}` +
        (l["first_day_on_site"] && l["last_day_on_site"]
          ? `, from ${l["first_day_on_site"]} to ${l["last_day_on_site"]}`
          : "") +
        `, for ${hours} man-hours` +
        (l["crew_days"] != null ? ` over ${l["crew_days"]} crew-days` : "") +
        (crew ? `, with up to ${crew} people on site on a single day` : ""),
    ),
  ];
  for (const d of (l["by_day"] ?? []) as Obj[]) {
    lines.push(
      `${d["date"]}: ${d["crew_size"] != null ? `crew of ${d["crew_size"]}, ` : ""}${d["man_hours"]} man-hours.`,
    );
  }
  return lines.join("\n");
}

function notesSection(f: Obj): string {
  return ((f["job_notes"] ?? []) as Obj[])
    .map((n) => `${n["date"] ? `${n["date"]}: ` : ""}${sentence(String(n["note"]))}`)
    .join("\n");
}

function documentsSection(f: Obj): string {
  return ((f["documents"] ?? []) as Obj[])
    .map((d) =>
      sentence(
        `${d["name"] ?? d["type"] ?? "Document"}${d["type"] && d["name"] ? ` (${d["type"]})` : ""}` +
          `${d["status"] ? `: ${String(d["status"]).toLowerCase()}` : ""}` +
          `${d["signed_on"] ? `, signed ${d["signed_on"]}` : ""}`,
      ),
    )
    .join("\n");
}

function amountsSection(f: Obj): string {
  const m = (f["money"] ?? {}) as Obj;
  const lines = (
    [
      ["Estimated", "estimated"],
      ["Billed", "billed"],
      ["Approved", "approved"],
      ["Collected", "collected"],
      ["Carrier shortfall", "shortfall"],
    ] as const
  )
    .map(([label, k]) => (money(m[k]) ? `${label}: ${money(m[k])}.` : null))
    .filter((x): x is string => !!x);
  return lines.join("\n");
}

function invoicesSection(f: Obj): string {
  return ((f["invoices"] ?? []) as Obj[])
    .map((i) =>
      sentence(
        `Invoice ${i["invoice_number"] ?? ""}`.trim() +
          (i["issue_date"] ? `, issued ${longDate(i["issue_date"])}` : "") +
          (i["status"] ? `, ${String(words(i["status"])).toLowerCase()}` : "") +
          (money(i["billed_amount"]) ? `, billed ${money(i["billed_amount"])}` : "") +
          (money(i["collected_amount"]) ? `, collected ${money(i["collected_amount"])}` : ""),
      ),
    )
    .join("\n");
}

const TEMPLATE_WRITERS: Record<string, (f: Obj) => string> = {
  "Summary of loss": summarySection,
  "Cause and affected areas": causeSection,
  "Key dates": keyDatesSection,
  "Mitigation performed": mitigationSection,
  "Drying progress": dryingSection,
  Equipment: equipmentSection,
  Labor: laborSection,
  "Job notes": notesSection,
  Documents: documentsSection,
  Amounts: amountsSection,
  Invoices: invoicesSection,
  "What this job does not have yet": (f) =>
    ((f["missing"] ?? []) as string[]).map((g) => `- ${g}`).join("\n"),
  "Outstanding items and next steps": (f) =>
    ((f["outstanding_items"] ?? []) as string[]).map((g) => `- ${g}`).join("\n"),
};

/** The outline written without a model: only the facts, in plain sentences. */
export function templateReport(facts: ReportFacts): string {
  const blocks: string[] = [];
  for (const s of reportOutline(facts)) {
    const body = TEMPLATE_WRITERS[s.heading]?.(facts).trim();
    if (body) blocks.push(`${s.heading}\n${body}`);
  }
  if (facts["photographs"]) blocks.push(`Photographs\n${facts["photographs"]}`);
  return blocks.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* 4. Drafting                                                         */
/* ------------------------------------------------------------------ */

export type DraftAttempt = { provider: AiProviderName; model: string };

export type DraftResult = {
  narrative: string;
  /** The model that wrote it, or TEMPLATE_MODEL. */
  model: string;
  engine: "ai" | "template";
  /** Figures still marked [[check: …]] in the narrative. */
  unsupported: string[];
  /** Quoted figures / named sources the rewrite could not remove. */
  voice: string[];
  /** Why each model attempt that failed, failed. */
  errors: string[];
};

export const TEMPLATE_MODEL = "template (no AI model available)";

type Checked = {
  text: string;
  numbers: ProvenanceProblem[];
  voice: ReturnType<typeof voiceProblems>;
};

/**
 * Strongest model first; one rewrite on a draft that quotes figures or uses a
 * number the facts do not hold; then the next model only if this one failed
 * outright. The template is the last resort. The result is always a draft a
 * person must approve.
 */
export async function draftJobReport(opts: {
  facts: ReportFacts;
  system: string;
  user: string;
  plan: readonly DraftAttempt[];
  complete: (system: string, user: string, attempt: DraftAttempt) => Promise<string>;
}): Promise<DraftResult> {
  const index = indexFacts(opts.facts);
  const check = (text: string): Checked => ({
    text,
    numbers: unsupportedFigures(text, index),
    voice: voiceProblems(text),
  });
  const score = (c: Checked) => c.numbers.length * 2 + c.voice.length;
  const errors: string[] = [];

  for (const attempt of opts.plan) {
    let best: Checked;
    try {
      const first = (await opts.complete(opts.system, opts.user, attempt)).trim();
      if (!first) {
        errors.push(`${attempt.model}: empty reply`);
        continue;
      }
      best = check(first);
    } catch (e) {
      errors.push(`${attempt.model}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    if (score(best) > 0) {
      try {
        const extra =
          (best.voice.length ? rewriteInstruction(best.voice) : "") +
          provenanceInstruction(best.numbers);
        const second = (await opts.complete(opts.system + extra, opts.user, attempt)).trim();
        if (second) {
          const c = check(second);
          if (score(c) < score(best)) best = c;
        }
      } catch (e) {
        errors.push(`${attempt.model} rewrite: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return {
      narrative: markUnsupported(best.text, best.numbers),
      model: attempt.model,
      engine: "ai",
      unsupported: best.numbers.map((p) => p.text),
      voice: best.voice.map((v) => v.phrase),
      errors,
    };
  }

  const text = templateReport(opts.facts);
  const c = check(text);
  return {
    narrative: markUnsupported(c.text, c.numbers),
    model: TEMPLATE_MODEL,
    engine: "template",
    unsupported: c.numbers.map((p) => p.text),
    voice: c.voice.map((v) => v.phrase),
    errors,
  };
}
