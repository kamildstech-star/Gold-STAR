/**
 * AI job reports.
 *
 * This is the highest-risk feature in the app: a fabricated figure in a
 * document sent to a carrier is a liability, not a bug. Three defences, all
 * enforced here rather than left to the prompt alone:
 *
 *  1. The model only ever sees `gatherJobSnapshot()` output — real rows read
 *     under the caller's own RLS.
 *  2. The prompt forbids any number, date or event not present in that
 *     snapshot, and requires missing data to be stated as missing.
 *  3. The result is stored as a DRAFT with the snapshot it was built from.
 *     Nothing is sent anywhere until a human approves it.
 *
 * A fourth was added after the client read one of these out loud: "That's
 * pulling random information... I don't need all this information in here...
 * we should have a report section here that's blank. And you manually have to
 * choose what updates you want to put in." The report is now assembled, not
 * collected — `sections` arrives with the request, the snapshot is cut down to
 * what was ticked BEFORE the model sees it, and an empty selection is refused
 * rather than turned into a page of filler.
 *
 * A fifth, 13 Oct (Mark: "make these reports much smarter and better, use a
 * better ai engine"): the model is handed a clean brief rather than the raw
 * snapshot (job-report-draft.ts), drafts on the strongest model the server can
 * reach (reportModelPlan in ai-provider.server.ts — Claude Opus 5.5 when an
 * Anthropic key is set), and every figure in the draft is checked against
 * that brief (report-provenance.ts). A figure the brief does not hold is
 * marked `[[check: …]]` and blocks approval until a person resolves it. With
 * no model reachable, the same brief is written out by a plain template.
 */
import {
  normalizeReportDates,
  reportPeriodInstruction,
  scopeSnapshotToDays,
} from "./job-report-dates";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { reportSectionsForAudience } from "@/lib/document-audience";
import {
  REPORT_SECTION_KEYS,
  emptyReportReason,
  narrowSnapshot,
  normalizeSections,
  sectionBrief,
} from "@/lib/job-report-sections";

const generateInput = z.object({
  job_id: z.string().uuid(),
  /**
   * Which days the report covers (22 Oct): one day's field form, chosen days,
   * or the full job (the default — what every report was before).
   */
  dates: z.unknown().optional(),
  report_type: z.enum(["carrier_submission", "internal_review"]),
  language: z.enum(["en", "es"]).default("en"),
  /*
   * Every section defaults to false and the whole object defaults to {}, so a
   * caller that sends nothing gets nothing — the refusal below, not a report
   * about everything. That is the client's requirement expressed as a schema:
   * there is no request shape that means "include it all".
   */
  sections: z
    .object(
      Object.fromEntries(REPORT_SECTION_KEYS.map((k) => [k, z.boolean().default(false)])) as Record<
        string,
        z.ZodDefault<z.ZodBoolean>
      >,
    )
    .partial()
    .default({}),
  /** The pictures chosen by hand on the Pictures tab or in the panel's picker. */
  photo_ids: z.array(z.string()).max(200).default([]),
});

const SHARED_RULES = `
ABSOLUTE RULES — these override every other instruction:
- Write ONE fresh, summarized report of the job's current state. It replaces any earlier version; it does not extend one. Merge repeated visits into a single account and never restate the same work twice.
- You may only state figures, dates, names and events that appear in the JOB DATA JSON.
- Never estimate, extrapolate, round differently, or infer a value that is not present.
- If something is absent, say so plainly in the report, e.g. "No equipment was placed on this
  job." Do not say it was "not recorded" — that describes paperwork, not the property.
  The JOB DATA has a "missing" array listing known gaps — reflect every relevant one.
- The "missing" array is the ONLY list of absences to report. Do not go looking for other
  empty fields to announce: a null, an empty array or a false flag elsewhere in the JOB DATA
  is not a finding, and "not recorded" must not be written about anything the array does not
  name. Optional data nobody filled in is simply left unsaid.
- Never print a raw boolean, and never write that something is "false". Where there is a
  written status, use its words instead.
- A job that is not finished is IN PROGRESS, not failed. Work still to do is "still pending"
  or "outstanding"; never "not completed", "incomplete", or "the form indicates work is not
  completed" — and never attribute it to a form at all.
- Never describe work, conversations, inspections or approvals that are not evidenced by a row.
- EVERY NUMBER IS CHECKED AGAINST THE JOB DATA. Each figure, date and clock time you write is
  looked up in the JOB DATA after you finish, and anything not found there is flagged to the
  reviewer. So never calculate a sum, difference, duration, average or percentage, never
  convert units or time zones, and never round. Use each figure exactly as given, or leave it
  out. Never invent a cause, a material, a measurement or a conclusion.
- Crew notes in the JOB DATA have already been tidied into sentences. Write them as part of the
  day's work in your own professional words, keeping every time, unit number and quantity
  exactly as given. Never paste shorthand.
- The JOB DATA holds no outside weather. Never describe outside conditions, and never describe
  any reading as anything other than the crew's own measurement it is given as.
- Cover ONLY the subjects listed under "COVER ONLY THESE SUBJECTS", in the order of the REPORT
  OUTLINE. The sender chose them; everything else about this job is withheld deliberately and
  is not yours to volunteer.
- Hours in "labor" are MAN-HOURS: crew size multiplied by hours on site. A crew of two on
  site for one hour is two hours. Never divide them back out or restate them per person.
- NEVER NAME WHERE ANY FIGURE CAME FROM. David, 17 Sep: "I wanted it to look good and
  professional and not that it's being pulled from somewhere else. 'The field form recorded'
  — I don't want to reference stuff like that... I want it to look like somebody actually
  went and wrote a report using that information." So: no field forms, no daily forms, no
  time clock, no records or "recorded", no systems, no logs or "logged", no "the data
  shows", no "according to". State the fact as a person who was there would state it — The
  crew spent 16 man-hours on site — not where you read it. "crew.source_note" is for your understanding only and must never
  appear, in whole or in paraphrase.
- WRITE FIGURES INTO SENTENCES, NEVER QUOTE THEM. David, 22 Sep: "I don't want it to phrase
  and quote — 'the job was recorded 16 hours, 16 total hours'... write it out as a report."
  Never put a figure, status or phrase in quotation marks or brackets. Never write "a total
  of", "totaling", "total hours", "hours recorded", "on record" or "as recorded". State each
  figure ONCE, as part of what happened — A crew of two worked 16 man-hours over two days —
  and never restate the same number under another name (total, approved, per day).
- Never add "superseded_time_clock_hours" to any other figure. Those hours are the same work
  already counted for that day; they are in the data only so nothing looks dropped, and they
  are never written about.
- Do not add a signature block, disclaimers, or invented contact details.
- Write in plain prose with short section headings. No markdown tables, no code fences.
- This is a DRAFT for human review. Do not claim it has been reviewed or approved.
`;

/*
 * Voice and audience only. What the report covers used to be baked in here as
 * a fixed running order — "loss date... crew... photo documentation summary by
 * folder... the itemised financial chain" — which is precisely why every
 * report read the same and carried the same figures whether or not they were
 * anybody's business. The subjects come from `sectionBrief()`, built from what
 * the sender ticked, and the order from `reportOutline()` — the carrier-ready
 * running order Mark asked for, limited to the subjects that were ticked.
 */
const PROMPTS: Record<string, string> = {
  carrier_submission: `You write restoration loss reports for insurance adjusters, as a senior
restoration project manager who was on the job. The report must be one a carrier can rely on:
precise, chronological and factual, in clear professional prose, with no filler, no
marketing and no speculation. Open with the summary of loss, then follow the REPORT OUTLINE.
${SHARED_RULES}`,

  internal_review: `You write an internal post-job review for a branch manager, as a senior
restoration project manager. Open by identifying the job, then follow the REPORT OUTLINE.
Clear, plain prose. Be blunt about what the data does not show. ${SHARED_RULES}`,
};

export const generateJobReport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => generateInput.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { gatherJobSnapshot } = await import("./job-reports.server");
    const { complete } = await import("./ai.server");

    const requested = normalizeSections(data.sections);
    /*
     * Refused here as well as in the panel. The button that is off is a
     * courtesy; this is the guarantee, and it is what stops an empty
     * selection becoming a draft row with a page of generated filler on it.
     */
    const nothingChosen = emptyReportReason(requested, data.photo_ids);
    if (nothingChosen) throw new Error(nothingChosen);

    const { resolveAssistantScope, logAssistantEvent, untrusted, UNTRUSTED_PREAMBLE } =
      await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(supabase, userId);

    // Generating a report writes a draft row, so View As cannot do it.
    if (!scope.caps.canWrite) {
      await logAssistantEvent(scope, {
        feature: "job_report",
        outcome: "denied",
        scopeSummary: { job_id: data.job_id, report_type: data.report_type },
        responsePreview: "Writes disabled while View As is active.",
      });
      throw new Error("Writes are disabled while View As is active.");
    }

    // An internal review is a margin/cost document by definition.
    if (data.report_type === "internal_review" && !scope.caps.financials) {
      await logAssistantEvent(scope, {
        feature: "job_report",
        outcome: "denied",
        scopeSummary: { job_id: data.job_id, report_type: data.report_type },
        responsePreview: "Role may not generate internal review reports.",
      });
      throw new Error(
        "Your role cannot generate an internal review — it contains cost and margin figures.",
      );
    }

    // Read under the caller's own RLS, then strip fields their role may not
    // see BEFORE the model is given anything.
    const dates = normalizeReportDates(data.dates);
    const rawSnapshot = await gatherJobSnapshot(supabase, data.job_id, {
      days: dates.mode === "days" ? dates.days : undefined,
    });
    const redactions: string[] = [];
    // The chosen days first, so nothing from another day reaches anything below.
    let snapshot: Record<string, unknown> = scopeSnapshotToDays({ ...rawSnapshot }, dates);

    /*
     * A requester who may not see cost and margin is treated as a customer
     * copy, which is the same rule `filtersForAudience` applies to an estimate
     * — see src/lib/document-audience.ts. It only ever turns sections off, and
     * the field-level deletions below still run underneath it.
     */
    const sections = scope.caps.financials
      ? requested
      : reportSectionsForAudience(requested, "customer");

    if (!scope.caps.financials) {
      delete snapshot.money;
      delete snapshot.invoices;
      delete snapshot.payments;
      delete snapshot.estimates;
      snapshot.financials_note =
        "Financial figures are not available to the requester's role and must not appear in this report.";
      redactions.push("money", "invoices", "payments", "estimates");
    }
    if (!scope.caps.labourCost) {
      snapshot.crew = {
        // The day-scoped crew, not the raw one, or the chosen days would be lost.
        ...(snapshot.crew as typeof rawSnapshot.crew),
        // Hours stay; who worked them and any per-person cost does not.
        assignments: rawSnapshot.crew.assignments.map((a) => ({
          role: a.role,
          start_date: a.start_date,
          end_date: a.end_date,
        })),
      };
      redactions.push("crew_person_identifiers");
    }

    /*
     * Last, and the point of the whole change: the model is handed only the
     * parts of the snapshot the ticked sections unlock. An unticked section is
     * not an instruction to stay quiet about something — the data is simply
     * not in the prompt, so there is nothing to leak, paraphrase or round.
     */
    const before = Object.keys(snapshot);
    const period = snapshot.report_period;
    snapshot = narrowSnapshot(snapshot, sections);
    redactions.push(...before.filter((k) => !(k in snapshot)).map((k) => `not_selected:${k}`));

    const languageLine =
      data.language === "es"
        ? "\nWrite the entire report in clear, professional Latin-American Spanish."
        : "";

    /*
     * What the model reads: the narrowed snapshot turned into a clean brief
     * (buildReportFacts — dates in words, crew notes as sentences, the crew
     * block as one hours figure via crewForModel), while the stored snapshot
     * keeps every figure for the panel. draftJobReport then runs the model
     * plan — strongest first — and checks the draft twice over: for quoted
     * figures and named sources (report-voice.ts) and for any figure the brief
     * does not hold (report-provenance.ts). One rewrite names the exact
     * problems; whatever survives it is marked [[check: …]] so the reviewer
     * has to resolve it before approving. No model reachable, or every call
     * failing, writes the same brief out as a plain template instead.
     */
    const { buildReportFacts, draftJobReport, outlineInstruction, reportOutline } =
      await import("./job-report-draft");
    const { REPORT_EFFORT, reportModelPlan } = await import("./ai-provider.server");
    const facts = buildReportFacts(snapshot, {
      photosAttached: sections.photos && data.photo_ids.length > 0,
    });
    const periodLine = reportPeriodInstruction(dates);
    const system = `${PROMPTS[data.report_type]}${languageLine}\n\n${sectionBrief(sections)}\n\n${periodLine ? `${periodLine}\n\n` : ""}${outlineInstruction(reportOutline(facts))}\n\n${UNTRUSTED_PREAMBLE}`;
    const user = `JOB DATA (the only permitted source of fact):\n${untrusted(facts)}`;
    const draft = await draftJobReport({
      facts,
      system,
      user,
      plan: reportModelPlan(),
      complete: (sys, usr, attempt) =>
        complete(sys, usr, false, "general", {
          provider: attempt.provider,
          model: attempt.model,
          effort: REPORT_EFFORT,
          feature: "job_report",
        }),
    });
    const narrative = draft.narrative;
    if (draft.errors.length > 0) console.warn("[job-report] model attempts failed:", draft.errors);
    if (draft.voice.length > 0) {
      console.warn("[job-report] draft still quotes figures after a rewrite:", draft.voice);
    }

    if (!narrative) throw new Error("The report came back empty. Try again.");

    const { data: existing } = await supabase
      .from("job_reports")
      .select("version")
      .eq("job_id", data.job_id)
      .eq("report_type", data.report_type)
      .eq("language", data.language)
      .order("version", { ascending: false })
      .limit(1);
    const version = (existing?.[0]?.version ?? 0) + 1;

    const { data: job } = await supabase
      .from("jobs")
      .select("location_id")
      .eq("id", data.job_id)
      .single();

    const { data: row, error } = await supabase
      .from("job_reports")
      .insert({
        job_id: data.job_id,
        location_id: job?.location_id ?? null,
        report_type: data.report_type,
        language: data.language,
        version,
        status: "draft",
        narrative,
        // The period rides with the report, so its list and its PDF can say
        // which days it covers.
        snapshot: JSON.parse(JSON.stringify({ ...snapshot, report_period: period })),
        // What was ticked, stored on the report itself. The panel reads the
        // newest report's selection back as the starting point for the next
        // one, so the office is not re-ticking the same six boxes daily.
        sections: sections as unknown as Record<string, boolean>,
        photo_ids: sections.photos && data.photo_ids.length > 0 ? data.photo_ids : null,
        model: draft.model,
        generated_by: userId,
      })
      .select()
      .single();
    if (error) throw new Error(error.message);

    await logAssistantEvent(scope, {
      feature: "job_report",
      scopeSummary: {
        job_id: data.job_id,
        report_type: data.report_type,
        language: data.language,
        report_id: row?.id ?? null,
        version,
        sections: Object.keys(sections).filter((k) => sections[k as keyof typeof sections]),
        photo_count: sections.photos ? data.photo_ids.length : 0,
      },
      retrieved: {
        job_number: rawSnapshot.job.job_number,
        notes: rawSnapshot.notes.length,
        photos: rawSnapshot.photos.total,
        invoices: rawSnapshot.invoices.length,
        labour_days: rawSnapshot.crew.entry_count,
        labour_source: rawSnapshot.crew.source,
      },
      redactions,
      responsePreview: narrative,
      model: draft.model,
    });

    return {
      report: row,
      missing: rawSnapshot.missing,
      engine: draft.engine,
      model: draft.model,
      unsupported: draft.unsupported,
      // Why the template wrote it: each model's refusal, short. Until 12 Nov
      // these only reached the server log, so the screen said "template" and
      // nobody could tell a wrong model name from a key with no credit.
      aiErrors:
        draft.engine === "template" ? draft.errors.slice(0, 3).map((e) => e.slice(0, 200)) : [],
    };
  });
