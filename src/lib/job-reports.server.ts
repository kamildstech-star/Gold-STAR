/**
 * Job report snapshot.
 *
 * The single most important property of this file: the snapshot is the ONLY
 * thing the model ever sees. Every figure in a generated report has to be
 * traceable to a row here, and where a row does not exist the snapshot says so
 * explicitly (`null` plus a `missing` entry) so the report can state the
 * absence rather than invent a plausible filler.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  fieldFormEquipment,
  ticketEquipmentLeft,
  ticketStatusPhrase,
} from "@/lib/job-report-field-forms";
import {
  LABOUR_SOURCE_LABEL,
  labourSourceNote,
  loadJobLabourRollup,
  manHours,
} from "@/lib/job-labour-rollup";
import type { Database } from "@/integrations/supabase/types";
import type { MoisturePoint, MoistureReading } from "@/lib/drying-materials";
import { dryingRoomLabel, summarizeDrying, type DryingSummary } from "@/lib/job-report-drying";

import { equipmentDaysOnSite } from "./equipment";

type DB = SupabaseClient<Database>;

export type JobSnapshot = Awaited<ReturnType<typeof gatherJobSnapshot>>;

/**
 * The drying summary, or null when nothing could be read. The moisture tables
 * postdate the generated types, so they go through an untyped client and a
 * missing table reads as "not set up", the same rule drying-materials-data.ts
 * follows.
 */
async function gatherDrying(
  supabase: DB,
  jobId: string,
  /** Readings through this day only ("YYYY-MM-DD"), for a report on chosen days. */
  throughDay: string | null = null,
): Promise<DryingSummary | null> {
  try {
    const raw = supabase as unknown as SupabaseClient;
    const [rooms, air, points, readings] = await Promise.all([
      supabase.from("job_rooms").select("id, unit, name, affected_materials").eq("job_id", jobId),
      supabase
        .from("job_drying_readings")
        .select("point, reading_date, grains_per_pound, source, room_id")
        .eq("job_id", jobId)
        .neq("source", "weather")
        .order("reading_date", { ascending: true }),
      raw
        .from("job_moisture_points")
        .select("id, job_id, room_id, material, location, dry_standard, removed_at, created_at")
        .eq("job_id", jobId),
      raw
        .from("job_moisture_readings")
        .select("id, point_id, job_id, reading_date, moisture_pct, captured_at")
        .eq("job_id", jobId),
    ]);
    const roomRows = (rooms.data ?? []) as {
      id: string;
      unit: string | null;
      name: string;
      affected_materials: string[] | null;
    }[];
    const roomNames = new Map(roomRows.map((r) => [r.id, dryingRoomLabel(r)]));
    const moistureMissing = points.error || readings.error;
    const num = (v: unknown) => (v == null ? null : Number(v));
    return summarizeDrying({
      moisture: moistureMissing
        ? null
        : {
            points: (points.data ?? []).map((p) => ({
              ...p,
              dry_standard: num(p.dry_standard),
            })) as MoisturePoint[],
            readings: (readings.data ?? [])
              .filter((r) => !throughDay || String(r.reading_date).slice(0, 10) <= throughDay)
              .map((r) => ({
                ...r,
                moisture_pct: Number(r.moisture_pct),
              })) as MoistureReading[],
          },
      airReadings: (air.data ?? [])
        .filter((r) => !throughDay || String(r.reading_date).slice(0, 10) <= throughDay)
        .map((r) => ({
          ...r,
          grains_per_pound: num(r.grains_per_pound),
        })),
      roomNames,
      rooms: roomRows.map((r) => ({
        label: dryingRoomLabel(r),
        affected_materials: r.affected_materials,
      })),
    });
  } catch {
    return null;
  }
}

const days = (a: string | null, b: string | null) => {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
};

export async function gatherJobSnapshot(
  supabase: DB,
  jobId: string,
  /**
   * The chosen days (job-report-dates.ts), oldest first. Field forms are read
   * for exactly those days — not the newest 30, which could miss a day picked
   * from three weeks ago — and drying readings run through the last of them.
   * The rest of the narrowing is scopeSnapshotToDays, after this returns.
   */
  opts: { days?: string[] } = {},
) {
  const pickedDays = opts.days?.length ? opts.days : null;
  const { data: job, error } = await supabase.from("jobs").select("*").eq("id", jobId).single();
  if (error || !job) throw new Error(error?.message ?? "Job not found");

  const [
    history,
    assignments,
    labour,
    placements,
    notes,
    docs,
    quotes,
    invoices,
    account,
    location,
  ] = await Promise.all([
    supabase
      .from("job_status_history")
      .select("from_status, to_status, changed_at")
      .eq("job_id", jobId)
      .order("changed_at"),
    supabase
      .from("job_assignments")
      .select("user_id, role, start_date, end_date")
      .eq("job_id", jobId),
    // Labour comes from the daily field forms first and the time clock second,
    // through the one shared rollup — see src/lib/job-labour-rollup.ts. Reading
    // time_entries alone here is what reported a fully documented job as zero
    // hours, zero crew-days and zero people.
    loadJobLabourRollup(supabase, jobId),
    supabase
      .from("equipment_placements")
      // `notes` is the note somebody wrote when the machine was placed or
      // collected — "full left on site", "second dehu on the landing". It was
      // never selected, so it could not reach the report however the section
      // was worded (David, 16 Sep).
      .select(
        "placed_at, retrieved_at, expected_retrieval_date, notes, equipment:equipment_id(asset_tag, equipment_type, make, model)",
      )
      .eq("job_id", jobId),
    supabase.from("job_notes").select("body, created_at").eq("job_id", jobId).order("created_at"),
    supabase
      .from("documents")
      .select("doc_type, name, status, created_at, signed_at")
      .eq("job_id", jobId),
    supabase.from("quotes").select("version, status, total, submitted_at").eq("job_id", jobId),
    supabase
      .from("invoices")
      .select(
        "id, invoice_number, status, issue_date, due_date, billed_amount, approved_amount, collected_amount, carrier_shortfall",
      )
      .eq("job_id", jobId),
    job.account_id
      ? supabase.from("accounts").select("name").eq("id", job.account_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("locations").select("code, name").eq("id", job.location_id).maybeSingle(),
  ]);

  // Photos live on projects, which are linked to a job by address/account in
  // this build; count only what is genuinely attached.
  const { data: projects } = await supabase.from("projects").select("id, name").eq("job_id", jobId);
  const projectIds = (projects ?? []).map((p) => p.id);
  let photoCount = 0;
  let folders: { name: string; photos: number }[] = [];
  if (projectIds.length > 0) {
    /*
     * Counted by the database. This read the photo rows back and took their
     * length, and PostgREST returns at most 1000 rows — so a job past 1000
     * photos went into the report as exactly 1000, with the folder tally cut
     * off at the same row. A head count and per-folder embedded counts stay
     * exact at any size and cost two small queries.
     */
    const [{ count }, { data: folderRows }] = await Promise.all([
      supabase
        .from("photos")
        .select("id", { count: "exact", head: true })
        .in("project_id", projectIds)
        .is("deleted_at", null),
      supabase
        .from("photo_folders")
        .select("id, name, photos(count)")
        .in("project_id", projectIds)
        .is("photos.deleted_at", null),
    ]);
    photoCount = count ?? 0;
    const tally = new Map<string, number>();
    let filed = 0;
    for (const f of (folderRows ?? []) as unknown as { name: string; photos: unknown }[]) {
      const first = Array.isArray(f.photos) ? f.photos[0] : f.photos;
      const n = (first as { count?: unknown } | null | undefined)?.count;
      if (typeof n !== "number" || n <= 0) continue;
      filed += n;
      tally.set(f.name, (tally.get(f.name) ?? 0) + n);
    }
    // Whatever no visible folder holds — the root, or a folder this reader
    // cannot see — is what the old tally split into "Unfiled (root)" and
    // "Unfiled"; one remainder says the same without a row read per photo.
    if (photoCount > filed) tally.set("Unfiled (root)", photoCount - filed);
    folders = [...tally.entries()].map(([name, n]) => ({ name, photos: n }));
  }

  /*
   * The daily field forms themselves, not just the hours they imply.
   *
   * "The updates from today's field form" is the first thing the client named
   * as something he WOULD want in a report. Until now the forms reached the
   * snapshot only through the labour rollup, as a number of man-hours — so a
   * crew that recorded extraction, containment and a note about the ceiling
   * showed up as "7.3". The content is what makes a field-form update worth
   * sending; the hours are what makes it an internal figure.
   *
   * Read on its own rather than in the Promise.all above so a schema or RLS
   * refusal costs the field-form section and not the whole snapshot.
   */
  let fieldFormsQ = supabase
    .from("field_work_tickets")
    /*
     * The equipment columns matter as much as the scope ones. A crew writes
     * what it LEFT on site on the daily form — one dehumidifier, three air
     * movers — and that is the equipment record for a job whose machines were
     * never asset-tagged into `equipment_placements`. Without these columns the
     * report could only ever describe placements, so a job documented entirely
     * on paper forms read as having no equipment at all.
     */
    .select(
      "work_date, job_types, scope_completed, materials_used, work_notes, trash_disposition, job_completed, more_work_needed, crew_chief_name, captured_at, equip_dehumidifier, equip_air_mover, equip_scrubber, equip_injector, equip_ozone, equip_hydroxyl, equip_generator",
    )
    .eq("job_id", jobId);
  // Chosen days: exactly those forms. Full job: the newest 30, as before.
  if (pickedDays) fieldFormsQ = fieldFormsQ.in("work_date", pickedDays);
  const fieldForms = await fieldFormsQ
    .order("work_date", { ascending: false })
    .limit(pickedDays ? 200 : 30);

  /*
   * Estimates priced in the Job Calculator. They live in their own table and
   * can exist without a quote, so a job priced there read as "no estimate
   * recorded" — an absence stated in the report about a job that had in fact
   * been priced. Read separately so a missing table costs this one fact and
   * not the whole snapshot.
   */
  const calculations = await supabase
    .from("job_calculations")
    .select("id, job_date, job_type, customer_price, updated_at")
    .eq("job_id", jobId)
    .order("updated_at", { ascending: false })
    .limit(20);

  /*
   * Drying progress for the "Drying progress" section: material points against
   * their dry goals, and the crew's air readings. Crew rows only — automatic
   * outside figures stay in the drying report, labelled with their source.
   * Read on its own and never fatal: a missing table costs this section only.
   */
  const drying = await gatherDrying(supabase, jobId, pickedDays?.[pickedDays.length - 1] ?? null);

  const crew = labour.rollup;

  const invoiceRows = invoices.data ?? [];
  const invoiceIdList = invoiceRows.map((i) => i.id);
  const paymentRows =
    invoiceIdList.length > 0
      ? ((
          await supabase
            .from("invoice_payments")
            .select("amount, received_at, method")
            .in("invoice_id", invoiceIdList)
        ).data ?? [])
      : [];

  const money = {
    estimated: job.estimated_amount,
    quoted_total: (quotes.data ?? []).reduce((n, q) => n + Number(q.total ?? 0), 0) || null,
    billed: invoiceRows.reduce((n, i) => n + Number(i.billed_amount ?? 0), 0) || job.billed_amount,
    approved:
      invoiceRows.reduce((n, i) => n + Number(i.approved_amount ?? 0), 0) || job.approved_amount,
    collected:
      invoiceRows.reduce((n, i) => n + Number(i.collected_amount ?? 0), 0) || job.collected_amount,
    shortfall: invoiceRows.reduce((n, i) => n + Number(i.carrier_shortfall ?? 0), 0) || null,
  };

  /*
   * What the job has no record of.
   *
   * Every line here is printed in the report as an absence, so a check that
   * fires while the data DOES exist is worse than no check at all — it tells an
   * adjuster something untrue about the file. David's report showed six of
   * them, and most were this: the fact was recorded somewhere the check did not
   * look. Each one below now asks every place the thing can live.
   */
  const formRows = fieldForms.data ?? [];
  const calculationCount = (calculations.data ?? []).length;
  const photoReportDocs = (docs.data ?? []).filter(
    (d) => d.doc_type === "photo_report" || d.doc_type === "certificate_of_completion",
  ).length;
  const formScope = formRows.some(
    (t) => (t.scope_completed ?? []).length > 0 || (t.job_types ?? []).length > 0,
  );
  const formEquipment = fieldFormEquipment(formRows).forms_with_equipment > 0;
  /* A job still running has not FAILED to be completed or invoiced; it simply
   * is not there yet. Those two only become gaps once the work is finished. */
  const jobIsFinished =
    !!job.completion_date || String(job.status) === "completed" || String(job.status) === "closed";

  const missing: string[] = [];
  if (!job.loss_date) missing.push("No date of loss on the job.");
  // The scope can be on the job, or written by the crew on a daily form.
  if (!job.initial_loss_description && !job.scope && !formScope)
    missing.push("No scope or loss description for this job.");
  if ((history.data ?? []).length === 0) missing.push("No status changes on this job yet.");
  if (crew.totalMinutes === 0) {
    missing.push("No crew hours on this job yet.");
  }
  if (labour.fieldFormsUnavailable) {
    missing.push(
      "Daily field forms could not be read, so any hours they hold are unknown rather than absent.",
    );
  }
  for (const p of crew.problems) {
    missing.push(
      `Daily field form for ${p.workDate} records ${p.headcount} ${p.crewClass === "gsr" ? "GSR" : "temp"} crew but its times cannot be used (${p.problem === "no_times" ? "a time box is blank" : "the end time is not after the start"}), so that day's hours come from the time clock instead.`,
    );
  }
  // Equipment is a placement OR a count written on a daily form. A job whose
  // machines were never asset-tagged still had machines on it.
  if ((placements.data ?? []).length === 0 && !formEquipment)
    missing.push("No equipment placed on this job.");
  if (photoCount === 0 && photoReportDocs === 0) missing.push("No photos attached to this job.");
  // An estimate can be a carrier quote or a Job Calculator sheet attached to
  // this job; `quotes` alone reported a priced job as unpriced.
  if ((quotes.data ?? []).length === 0 && calculationCount === 0)
    missing.push("No estimate for this job yet.");
  if (jobIsFinished && invoiceRows.length === 0)
    missing.push("This job is finished but no invoice has been raised for it.");
  if (jobIsFinished && !job.completion_date) missing.push("No completion date on this job.");

  return {
    generated_at: new Date().toISOString(),
    job: {
      id: job.id,
      job_number: job.job_number,
      job_name: job.job_name,
      status: job.status,
      loss_type: job.loss_type,
      loss_date: job.loss_date,
      call_date: job.call_date,
      first_response_at: job.first_response_at,
      start_date: job.start_date,
      completion_date: job.completion_date,
      address: [job.address, job.locality, job.region, job.postal_code].filter(Boolean).join(", "),
      customer_name: job.customer_name,
      scope: job.scope,
      initial_loss_description: job.initial_loss_description,
      // 11 Nov (point 7): every mitigation report states the IICRC category
      // and class; the drying log has recorded both since September.
      water_category: (job as { water_category?: unknown }).water_category ?? null,
      water_class: (job as { water_class?: unknown }).water_class ?? null,
      carrier: job.insurance_carrier,
      claim_number: job.claim_number,
      adjuster_name: job.adjuster_name,
      deductible: job.deductible,
      account_name: account.data?.name ?? null,
      location: location.data ? `${location.data.code} — ${location.data.name}` : null,
    },
    timeline: {
      status_history: history.data ?? [],
      days_loss_to_response: days(job.loss_date, job.first_response_at),
      days_start_to_completion: days(job.start_date, job.completion_date),
      cycle_time_days: days(job.created_at, job.completion_date ?? null),
    },
    crew: {
      assignments: assignments.data ?? [],

      // Where these numbers came from, for the figures panel and whoever checks
      // the PDF against the right table. The model never sees these three:
      // crewForModel (report-voice.ts) hands it one hours figure and no source.
      source: crew.source,
      source_label: LABOUR_SOURCE_LABEL[crew.source],
      source_note: labourSourceNote(crew),

      // Man-hours: crew size × hours on site, deduped against the time clock.
      total_hours: manHours(crew.totalMinutes),
      approved_hours: manHours(crew.approvedMinutes),
      crew_days: crew.crewDays,
      days_on_site: crew.daysOnSite,
      distinct_people: crew.peopleOnJob,
      named_people: crew.namedPeople,
      peak_crew: crew.peakCrew,

      field_form_hours: manHours(crew.fieldFormMinutes),
      time_clock_hours: manHours(crew.timeClockMinutes),
      // Clock hours a field form already accounts for. Never added on top.
      superseded_time_clock_hours: manHours(crew.supersededMinutes),
      uncosted_hours: manHours(crew.uncostedMinutes),

      entry_count: crew.days.length,
      unresolved_field_form_lines: crew.problems.length,
      by_day: crew.days.map((d) => ({
        date: d.date,
        source: d.source,
        hours: manHours(d.minutes),
        crew_size: d.crewSize,
        from_field_form: d.covered,
      })),
    },
    equipment: (placements.data ?? []).map((p) => {
      const eq = p.equipment as unknown as {
        equipment_type?: string;
        asset_tag?: string;
        make?: string;
        model?: string;
      } | null;
      return {
        name: [eq?.make, eq?.model].filter(Boolean).join(" ") || null,
        type: eq?.equipment_type ?? null,
        asset_tag: eq?.asset_tag ?? null,
        placed_at: p.placed_at,
        retrieved_at: p.retrieved_at,
        expected_retrieval_date: p.expected_retrieval_date,
        // The billing rule (inclusive calendar days), so the report and the
        // invoice never disagree about how long a machine was there.
        days_on_site: equipmentDaysOnSite(p.placed_at, p.retrieved_at),
        still_on_site: !p.retrieved_at,
        // What the crew wrote about this machine, verbatim.
        note: p.notes,
      };
    }),
    /*
     * Equipment as the daily forms recorded it, which for a job whose machines
     * were never asset-tagged is the only record there is. Counted across every
     * form so the report can say what was left on site and when, and kept apart
     * from `equipment` so a reader can tell a scanned placement from a number
     * written on a sheet.
     */
    equipment_from_field_forms: fieldFormEquipment(fieldForms.data ?? []),
    /*
     * Newest first: "today's field form" is the one at the top, and a report
     * that covers only the latest update is the ordinary case.
     */
    field_forms: (fieldForms.data ?? []).map((t) => ({
      work_date: t.work_date,
      captured_at: t.captured_at,
      crew_chief: t.crew_chief_name,
      job_types: t.job_types,
      scope_completed: t.scope_completed,
      materials_used: t.materials_used,
      work_notes: t.work_notes,
      trash: t.trash_disposition,
      job_completed: t.job_completed,
      more_work_needed: t.more_work_needed,
      /*
       * The same two flags said the way the client wants them read.
       *
       * An unticked "Job completed" was reaching the report as a negative — the
       * form "indicates work is not completed" — which reads as a failure when
       * all it means is that the crew is coming back. David, 16 Sep: say the
       * work is still pending instead. The phrase is built here rather than
       * left to the model, because the snapshot is the only thing the model is
       * allowed to state.
       */
      status: ticketStatusPhrase(t.job_completed, t.more_work_needed),
      equipment_left: ticketEquipmentLeft(t),
    })),
    photos: { total: photoCount, by_folder: folders },
    drying,
    notes: (notes.data ?? []).map((n) => ({ created_at: n.created_at, body: n.body })),
    documents: docs.data ?? [],
    money,
    invoices: invoiceRows,
    payments: paymentRows.map((p) => ({
      amount: p.amount,
      received_at: p.received_at,
      method: p.method,
    })),
    estimates: quotes.data ?? [],
    /* Priced in the Job Calculator rather than as a carrier quote. */
    calculator_estimates: (calculations.data ?? []).map((c) => ({
      job_date: c.job_date,
      job_type: c.job_type,
      customer_price: c.customer_price,
      updated_at: c.updated_at,
    })),
    missing,
  };
}
