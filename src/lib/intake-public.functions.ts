/**
 * Public intake form — the tokenized sync-back.
 *
 * The recipient (insured or public adjuster) is not a user of the system, so
 * these two functions are deliberately unauthenticated. The token is the only
 * credential and it is checked on every call: unknown, revoked, expired or
 * already-submitted tokens return nothing. What comes back is the minimum
 * needed to fill the form — no financials, no internal notes, no staff data.
 *
 * A submission never touches the job. It lands as a pending row a staff member
 * reviews, so a recipient can never overwrite what the office already knows.
 *
 * A request may have NO job. That is the standalone lead form: nothing is
 * pre-filled because nothing is known, and the office decides at triage whether
 * the answers become a new job or join an existing one.
 *
 * A request may also have NO office (and no show). That is the general link —
 * the one behind a button on the website. It is multi-use, and each submission
 * is routed to the closest office to the property (see intake-routing.ts),
 * falling back to the office configured in app_settings. A STANDING link
 * (20260925120000) is one person's own general link, handed out by the
 * database; it also closes when its owner is no longer an active employee.
 */
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Json } from "@/integrations/supabase/types";

import type { AddressSearchResult, AddressSuggestion, GeoPoint } from "./address.functions";
import { cleanGeoPoint } from "./geo-point";

import {
  INTAKE_PHOTO_BUCKET,
  INTAKE_PHOTO_MAX_BYTES,
  INTAKE_PHOTO_MAX_COUNT,
  INTAKE_PHOTO_MIMES,
  photoExtension,
  sanitizeIntakePhotos,
  standaloneFormProblem,
  type IntakePhoto,
} from "./intake-form";
import {
  INTAKE_GENERAL_SETTINGS_KEY,
  INTAKE_OFFICE_RULES_TABLE,
  matchLocationForFields,
  rulesFromRows,
  type RoutableLocation,
  type RoutingMatch,
} from "./intake-routing";
import { isMissingSchema } from "./schema-fallback";

type Answer = { text?: string | null; bool?: boolean | null; date?: string | null };

export type PublicIntakeQuestion = {
  id: string;
  prompt: string;
  help_text: string | null;
  answer_type: string;
  choices: string[];
  sort_order: number;
  prefill: Answer | null;
};

export type PublicIntakeLossType = { id: string; label: string };

export type PublicIntakePayload = {
  ok: boolean;
  reason?: "not_found" | "revoked" | "expired" | "submitted" | "error";
  /** No job behind this link — the form asks rather than confirms. */
  standalone?: boolean;
  /** Minted for a trade show: the short booth form, open to many submissions. */
  booth?: boolean;
  tradeshowName?: string | null;
  jobNumber?: string;
  officeName?: string | null;
  entityName?: string | null;
  entityPhone?: string | null;
  recipientName?: string | null;
  note?: string | null;
  known?: {
    site_address: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    loss_date: string | null;
    insurance_carrier: string | null;
    claim_number: string | null;
    policy_number: string | null;
    loss_type_id: string | null;
  };
  questions?: PublicIntakeQuestion[];
  lossTypes?: PublicIntakeLossType[];
  /** The managed list could not be read — say so instead of showing no options. */
  lossTypesUnavailable?: boolean;
};

const EMPTY_KNOWN = {
  site_address: null,
  customer_name: null,
  customer_phone: null,
  customer_email: null,
  loss_date: null,
  insurance_carrier: null,
  claim_number: null,
  policy_number: null,
  loss_type_id: null,
} satisfies NonNullable<PublicIntakePayload["known"]>;

async function adminClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

type AdminDb = Awaited<ReturnType<typeof adminClient>>;
/** For a table the generated types do not know yet (an unapplied migration). */
type UntypedDb = SupabaseClient;

/**
 * Save the submission and consume a one-time link in ONE transaction
 * (`submit_public_intake_atomic`, migration 20260908012100). These were two
 * calls: insert, then stamp `submitted_at`. Two submits racing on the same
 * one-time link both got past the "already submitted" check and both landed,
 * and an insert that failed after a stamp (or a stamp that failed after an
 * insert) left the link and the inbox disagreeing. The function locks the
 * request row, re-checks it, inserts and consumes together.
 *
 * There is no fallback to the two calls. A missing function or a refusal
 * loses nothing that was not already lost: the customer is told the form did
 * not go through and can send it again while the link is still open.
 */
export async function submitIntakeAtomically(
  db: AdminDb,
  token: string,
  requestId: string,
  submission: Record<string, Json>,
): Promise<{ id: string }> {
  const { data, error } = await db.rpc("submit_public_intake_atomic", {
    _token: token,
    _request_id: requestId,
    _submission: submission,
  });
  if (error || typeof data !== "string" || !data) {
    if (error) console.error("[intake] submit_public_intake_atomic refused:", error);
    throw new Error(
      "This form could not be submitted. It may already have been sent, or the link may have expired. If the link still opens, please try again or call the office.",
    );
  }
  return { id: data };
}

const REQUEST_COLUMNS = "id, job_id, recipient_name, note, expires_at, revoked_at, submitted_at";

type IntakeRequestRow = {
  id: string;
  job_id: string | null;
  recipient_name: string | null;
  note: string | null;
  expires_at: string;
  revoked_at: string | null;
  submitted_at: string | null;
  location_id?: string | null;
  /** Trade show link (20260903220000): attributed, and open to many submissions. */
  tradeshow_id?: string | null;
  multi_use?: boolean;
  label?: string | null;
  created_by?: string | null;
  /** One person's reusable link (20260925120000). */
  standing?: boolean;
  /** Set by readRequest: a standing link whose owner is no longer active. */
  ownerGone?: boolean;
};

/*
 * Column sets newest first. Each ships in its own migration, written here but
 * applied by hand, so the database may hold any prefix of them and the read
 * steps back one tier on a missing-column error. A database that has not
 * caught up still serves every older link exactly as before.
 */
const REQUEST_SELECTS = [
  `${REQUEST_COLUMNS}, location_id, tradeshow_id, multi_use, label, created_by, standing`,
  `${REQUEST_COLUMNS}, location_id, tradeshow_id, multi_use, label, created_by`,
  `${REQUEST_COLUMNS}, location_id`,
  REQUEST_COLUMNS,
] as const;

async function readRequest(
  db: AdminDb,
  token: string,
): Promise<{ row: IntakeRequestRow | null; failed: boolean }> {
  for (let i = 0; i < REQUEST_SELECTS.length; i++) {
    const res = await db
      .from("intake_requests")
      .select(REQUEST_SELECTS[i]!)
      .eq("token", token)
      .maybeSingle();
    if (!res.error) {
      const row = (res.data as IntakeRequestRow | null) ?? null;
      if (row?.standing) {
        const owner = await standingOwnerActive(db, row.created_by ?? null);
        if (owner === null) return { row: null, failed: true };
        row.ownerGone = !owner;
      }
      return { row, failed: false };
    }
    const last = i === REQUEST_SELECTS.length - 1;
    if (last || !isMissingSchema(res.error)) {
      logLoadFailure("intake_requests", res.error);
      return { row: null, failed: true };
    }
  }
  return { row: null, failed: true };
}

/**
 * A standing link lives in somebody's phone notes for years. When that person
 * leaves, the link has to stop with them — nobody remembers to revoke it at
 * offboarding, and a departed tech's copy would otherwise keep filing leads.
 * Same test the database's is_employee uses for "active". `null` = the read
 * failed, which the caller treats as a failed read, never as a gone owner.
 */
async function standingOwnerActive(db: AdminDb, userId: string | null): Promise<boolean | null> {
  if (!userId) return false;
  const { data, error } = await db
    .from("profiles")
    .select("is_active, approval_status")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return null;
  return data?.is_active === true && data?.approval_status === "approved";
}

/** Loss type is a managed option list resolved by row id, never typed text. */
async function readLossTypes(
  db: AdminDb,
  locationId: string | null,
): Promise<{ list: PublicIntakeLossType[]; failed: boolean }> {
  const { data, error } = await db
    .from("option_list_values")
    .select("id, label, active, location_id, option_lists!inner(key)")
    .eq("option_lists.key", "loss_type")
    .eq("active", true)
    .order("sort_order");
  if (error) return { list: [], failed: true };

  const rows = (data ?? []) as unknown as {
    id: string;
    label: string;
    location_id: string | null;
  }[];
  return {
    list: rows
      // A location-scoped option belongs to that office only.
      .filter((r) => !r.location_id || r.location_id === locationId)
      .map((r) => ({ id: r.id, label: r.label })),
    failed: false,
  };
}

/**
 * Office for a submission from a general link. Reads every office and the
 * configured fallback with the admin client — the public caller has no rows of
 * its own to read.
 */
async function routeGeneralSubmission(
  db: AdminDb,
  fields: Record<string, string | null>,
): Promise<RoutingMatch> {
  const [{ data: locations }, { data: setting }, rules] = await Promise.all([
    db.from("locations").select("id, code, name, region, locality, lat, lon, active"),
    db.from("app_settings").select("value").eq("key", INTAKE_GENERAL_SETTINGS_KEY).maybeSingle(),
    /* The Territory page's state / ZIP rules (20261006170000). Not applied
       yet, or unreadable for any reason: route by the address alone, exactly
       as before — a form is never refused over a missing rule. */
    (db as unknown as UntypedDb)
      .from(INTAKE_OFFICE_RULES_TABLE)
      .select("match_kind, match_value, location_id")
      .then(({ data, error }) => (error ? [] : rulesFromRows(data))),
  ]);
  const fallback =
    (setting?.value as { fallback_location_id?: string | null } | null)?.fallback_location_id ??
    null;
  return matchLocationForFields(fields, (locations ?? []) as RoutableLocation[], fallback, rules);
}

/**
 * Only the questions the office has opted onto the public form
 * (intake_questions.ask_on_public_form, 20260903224000). The form itself is
 * the four required fields, photos and notes; anything more is the office's
 * choice, made on the admin screen. A database without the flag asks none.
 */
async function readPublicQuestions(db: AdminDb) {
  const { data, error } = await db
    .from("intake_questions")
    .select("id, prompt, help_text, answer_type, choices, sort_order")
    .eq("active", true)
    .eq("ask_on_public_form", true)
    .order("sort_order");
  if (error) return [];
  return data ?? [];
}

/** Validity of a link for a write — shared by submit and the photo upload. */
function linkProblem(req: IntakeRequestRow | null, failed: boolean): string | null {
  if (failed) return "We could not reach our system. Please try again in a moment.";
  if (!req) return "This link is no longer valid.";
  if (req.revoked_at || req.ownerGone) return "This link was withdrawn by the office.";
  if (req.submitted_at && !req.multi_use) return "This form was already submitted. Thank you.";
  if (new Date(req.expires_at).getTime() < Date.now()) return "This link has expired.";
  return null;
}

/**
 * Why a link failed to load, in the server log. Nothing here returned the
 * cause before, so "This form could not be loaded" on staging (27 Oct) left
 * nothing to read. Never logs the token.
 */
function logLoadFailure(what: string, error: { code?: string; message?: string } | null) {
  console.error(
    `[intake] load failed reading ${what}: ${error?.code ?? ""} ${error?.message ?? ""}`,
  );
}

/** A real token is 48 hex characters; anything short or odd is simply not a link. */
export function isWellFormedIntakeToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(token);
}

export const loadIntakeRequest = createServerFn({ method: "GET" })
  .inputValidator((data: { token: string }) => {
    /* A truncated or mangled link used to throw here, which the page could
       only show as a server error. It is an invalid link: say so. */
    return { token: typeof data?.token === "string" ? data.token : "" };
  })
  .handler(async ({ data }): Promise<PublicIntakePayload> => {
    if (!isWellFormedIntakeToken(data.token)) return { ok: false, reason: "not_found" };

    /* Fails OPEN. The 192-bit token is the real gate — guessing one is not on
       the table — and the caller has already proved they hold a valid link, so
       a counter store that is down must not cost the office a lead. */
    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    await guardPublicServerFn("intake:read", RATE_LIMITS.publicTokenRead, "open");

    let db: AdminDb;
    try {
      db = await adminClient();
    } catch (e) {
      // Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY on this deployment.
      console.error(
        `[intake] load failed: server database client unavailable: ${(e as Error).message}`,
      );
      return { ok: false, reason: "error" };
    }
    const { row: req, failed } = await readRequest(db, data.token).catch((e: Error) => {
      logLoadFailure("intake_requests", { message: e.message });
      return { row: null, failed: true };
    });

    /* A read that failed is not a link that is missing. Telling someone their
       link is dead when the database blinked loses the lead outright. */
    if (failed) return { ok: false, reason: "error" };
    if (!req) return { ok: false, reason: "not_found" };
    if (req.revoked_at || req.ownerGone) return { ok: false, reason: "revoked" };
    // A booth link is scanned by everyone who stops; it never closes on one.
    if (req.submitted_at && !req.multi_use) return { ok: false, reason: "submitted" };
    if (new Date(req.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };

    const questions = await readPublicQuestions(db);

    const shape = (prefill: Map<string, Answer>) =>
      (questions ?? []).map((q) => ({
        id: q.id as string,
        prompt: q.prompt as string,
        help_text: (q.help_text as string | null) ?? null,
        answer_type: q.answer_type as string,
        choices: Array.isArray(q.choices) ? (q.choices as string[]) : [],
        sort_order: (q.sort_order as number) ?? 0,
        prefill: prefill.get(q.id as string) ?? null,
      }));

    if (!req.job_id) {
      // Nothing is known yet, so nothing is confirmed — the form only asks.
      const { data: loc } = req.location_id
        ? await db
            .from("locations")
            .select("name, legal_entity_name, office_phone")
            .eq("id", req.location_id)
            .maybeSingle()
        : { data: null };
      const loss = await readLossTypes(db, req.location_id ?? null);
      // A show link: the form is headed by the show and asks only what a
      // booth conversation can answer — no address, no claim, no questionnaire.
      const { data: show } = req.tradeshow_id
        ? await db.from("tradeshows").select("name").eq("id", req.tradeshow_id).maybeSingle()
        : { data: null };
      const booth = !!req.tradeshow_id;
      return {
        ok: true,
        standalone: true,
        booth,
        tradeshowName: (show as { name?: string } | null)?.name ?? null,
        officeName: (loc as { name?: string } | null)?.name ?? null,
        entityName:
          (loc as { legal_entity_name?: string | null; name?: string } | null)?.legal_entity_name ??
          (loc as { name?: string } | null)?.name ??
          null,
        entityPhone: (loc as { office_phone?: string | null } | null)?.office_phone ?? null,
        recipientName: req.recipient_name,
        note: req.note,
        known: { ...EMPTY_KNOWN },
        questions: booth ? [] : shape(new Map()),
        lossTypes: loss.list,
        lossTypesUnavailable: loss.failed,
      };
    }

    const JOB_COLUMNS =
      "job_number, address, address_line2, locality, region, postal_code, customer_name, loss_date, loss_type_id, insurance_carrier, claim_number, policy_number, location_id";
    let { data: job, error: jobError } = await db
      .from("jobs")
      .select(`${JOB_COLUMNS}, billing_location_id`)
      .eq("id", req.job_id)
      .maybeSingle();
    // A database without billing_location_id yet still serves the form.
    if (jobError && isMissingSchema(jobError)) {
      ({ data: job, error: jobError } = (await db
        .from("jobs")
        .select(JOB_COLUMNS)
        .eq("id", req.job_id)
        .maybeSingle()) as unknown as { data: typeof job; error: typeof jobError });
    }
    if (jobError) {
      logLoadFailure("jobs", jobError);
      return { ok: false, reason: "error" };
    }
    if (!job) return { ok: false, reason: "not_found" };

    const { data: contact } = await db
      .from("job_contacts")
      .select("full_name, email, phone")
      .eq("job_id", req.job_id)
      .order("sort_order")
      .limit(1);

    // Customer-facing identity comes from the job's billing entity.
    const brandLocationId = job.billing_location_id ?? job.location_id;
    const { data: loc } = brandLocationId
      ? await db
          .from("locations")
          .select("name, legal_entity_name, office_phone")
          .eq("id", brandLocationId)
          .maybeSingle()
      : { data: null };

    const { data: answers } = await db
      .from("job_intake_answers")
      .select("question_id, answer_text, answer_bool, answer_date")
      .eq("job_id", req.job_id);

    const byQuestion = new Map(
      (answers ?? []).map((a) => [
        a.question_id,
        { text: a.answer_text, bool: a.answer_bool, date: a.answer_date } as Answer,
      ]),
    );

    const site = [
      job.address,
      job.address_line2,
      [job.locality, job.region, job.postal_code].filter(Boolean).join(", "),
    ]
      .filter(Boolean)
      .join(", ");

    const loss = await readLossTypes(db, brandLocationId ?? null);

    return {
      ok: true,
      standalone: false,
      jobNumber: job.job_number,
      officeName: (loc as { name?: string } | null)?.name ?? null,
      entityName:
        (loc as { legal_entity_name?: string | null; name?: string } | null)?.legal_entity_name ??
        (loc as { name?: string } | null)?.name ??
        null,
      entityPhone: (loc as { office_phone?: string | null } | null)?.office_phone ?? null,
      recipientName: req.recipient_name,
      note: req.note,
      known: {
        site_address: site || null,
        customer_name: job.customer_name,
        customer_phone: (contact ?? [])[0]?.phone ?? null,
        customer_email: (contact ?? [])[0]?.email ?? null,
        loss_date: job.loss_date,
        insurance_carrier: job.insurance_carrier,
        claim_number: job.claim_number,
        policy_number: job.policy_number,
        loss_type_id: job.loss_type_id ?? null,
      },
      questions: shape(byQuestion),
      lossTypes: loss.list,
      lossTypesUnavailable: loss.failed,
    };
  });

export type IntakeSubmitInput = {
  token: string;
  submittedByName?: string | null;
  submittedByEmail?: string | null;
  fields: Record<string, string | null>;
  answers: Record<string, Answer>;
  /** Uploaded first through createIntakePhotoUpload; checked against the request on submit. */
  photos?: IntakePhoto[];
};

export const submitIntakeRequest = createServerFn({ method: "POST" })
  .inputValidator((data: IntakeSubmitInput) => {
    if (!data?.token || data.token.length < 16) throw new Error("Invalid link.");
    const clean = (v: unknown) => (typeof v === "string" ? v.slice(0, 2000) : null);
    return {
      token: data.token,
      submittedByName: clean(data.submittedByName),
      submittedByEmail: clean(data.submittedByEmail),
      fields: Object.fromEntries(
        Object.entries(data.fields ?? {}).map(([k, v]) => [k.slice(0, 64), clean(v)]),
      ),
      answers: Object.fromEntries(
        Object.entries(data.answers ?? {}).map(([k, v]) => [
          k.slice(0, 64),
          {
            text: clean(v?.text),
            bool: typeof v?.bool === "boolean" ? v.bool : null,
            date: clean(v?.date),
          },
        ]),
      ),
      photos: Array.isArray(data.photos) ? data.photos.slice(0, INTAKE_PHOTO_MAX_COUNT) : [],
    } satisfies IntakeSubmitInput;
  })
  .handler(async ({ data }) => {
    // Tighter than the read, and fails CLOSED: this writes rows and can
    // trigger office notifications, and with the counter store down the
    // limiter is the only thing in front of an anonymous writer. The insert
    // below needs the same database, so a refusal here costs a retry, not a
    // lead that would otherwise have landed. Loading the form stays open.
    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    await guardPublicServerFn("intake:write", RATE_LIMITS.publicTokenWrite, "closed");

    const db = await adminClient();
    const { row: req, failed } = await readRequest(db, data.token);

    const invalid = linkProblem(req, failed);
    if (invalid || !req) throw new Error(invalid ?? "This link is no longer valid.");

    const { boothSubmissionProblem, fileBoothSubmission } =
      await import("./tradeshow-intake.server");

    /* A standalone submission is the only record of this person, so it has to
       carry the four things the office cannot work without — address, name,
       phone, email (intake-form.ts). A job-linked one already has them on the
       job and must stay submittable as a partial correction. A booth form has
       no address to give — it needs a person and a way to reach them, the
       same rule the tablet capture applies. */
    if (req.tradeshow_id) {
      const problem = boothSubmissionProblem(data.fields);
      if (problem) throw new Error(problem);
    } else if (!req.job_id) {
      const problem = standaloneFormProblem(data.fields);
      if (problem) throw new Error(problem);
    }

    /* Only photos uploaded under THIS request may be attached; a path naming
       another lead's file is dropped, not refused, so a form is never lost
       over a stale upload. */
    const photos = sanitizeIntakePhotos(data.photos, req.id);

    /* A general link (no job, no office, no show) is the website button. The
       office is chosen from the address the customer typed and recorded as a
       guess for triage to confirm. Its columns ship in a migration that is
       written but not applied; until then the row still lands, unrouted. */
    const general = !req.job_id && !req.location_id && !req.tradeshow_id;
    const routing = general ? await routeGeneralSubmission(db, data.fields) : null;

    const submittedAt = new Date().toISOString();
    /* The function inserts exactly these keys. `job_id` is checked against
       the request (a link whose job changed since we read it is refused), and
       `location_id` is used only for a general link, which is the only kind
       `routeGeneralSubmission` ran for. Routing and photos are live columns
       now, so the old "drop the extras on a missing column" retry is gone. */
    const submission: Record<string, Json> = {
      job_id: req.job_id,
      submitted_by_name: data.submittedByName,
      submitted_by_email: data.submittedByEmail,
      fields: data.fields,
      answers: data.answers as Json,
      photos: photos as unknown as Json,
      location_id: routing?.locationId ?? null,
    };
    const inserted = await submitIntakeAtomically(db, data.token, req.id, submission);

    /* WHY the address chose that office (20261006170000) is newer than the
       atomic function, which does not write it. It is triage context, not
       part of what makes the link single-use, so it is added to the saved
       row afterwards; a failure is logged and the submission stands, routed
       but without the explanation. */
    if (routing) {
      const { error: whyError } = await (db as unknown as UntypedDb)
        .from("intake_submissions")
        .update({
          location_route_reason: routing.reason,
          location_route_detail: routing.detail ?? null,
        })
        .eq("id", inserted.id);
      if (whyError) console.error("[intake] routing reason not recorded", whyError);
    }

    /* The booth account is filed on the way in, like a tablet capture. The
       submission is already saved, so a failure here is logged and the lead
       simply waits in the inbox without an account rather than bouncing the
       person at the booth. */
    if (req.tradeshow_id && inserted) {
      try {
        await fileBoothSubmission(db, {
          request: {
            id: req.id,
            tradeshow_id: req.tradeshow_id,
            location_id: req.location_id ?? null,
            created_by: req.created_by ?? null,
            label: req.label ?? null,
          },
          submissionId: inserted.id,
          fields: data.fields,
          submittedAt,
        });
      } catch (e) {
        console.error("[intake] booth submission saved but the account was not created", e);
      }
    }

    return { ok: true };
  });

/**
 * A signed upload URL for one photo on the public form. The token is the only
 * credential, checked exactly as submit checks it, and the object lands under
 * the request's own folder so submit can tell whose photo it is.
 */
export const createIntakePhotoUpload = createServerFn({ method: "POST" })
  .inputValidator((data: { token: string; name: string; mime: string; size: number }) => {
    if (!data?.token || data.token.length < 16) throw new Error("Invalid link.");
    const mime = String(data.mime ?? "").toLowerCase();
    if (!(INTAKE_PHOTO_MIMES as readonly string[]).includes(mime))
      throw new Error("Please choose a photo (JPEG, PNG, WebP, HEIC or GIF).");
    const size = Number(data.size);
    if (!Number.isFinite(size) || size <= 0) throw new Error("That file looks empty.");
    if (size > INTAKE_PHOTO_MAX_BYTES) throw new Error("Each photo must be under 15 MB.");
    return { token: data.token, name: String(data.name ?? "photo").slice(0, 200), mime, size };
  })
  .handler(async ({ data }) => {
    // Fails CLOSED like submit: each call mints a storage upload grant, which
    // is exactly what must not be handed out unmetered while the store is down.
    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    await guardPublicServerFn("intake:write", RATE_LIMITS.publicTokenWrite, "closed");

    const db = await adminClient();
    const { row: req, failed } = await readRequest(db, data.token);
    const invalid = linkProblem(req, failed);
    if (invalid || !req) throw new Error(invalid ?? "This link is no longer valid.");

    const path = `${req.id}/${crypto.randomUUID()}.${photoExtension(data.name, data.mime)}`;
    const { data: signed, error } = await db.storage
      .from(INTAKE_PHOTO_BUCKET)
      .createSignedUploadUrl(path);
    if (error || !signed) {
      throw new Error(
        "Photos cannot be added right now — send the form without them and we will ask for them.",
      );
    }
    return { path, token: signed.token };
  });

/**
 * Address type-ahead for the public intake form.
 *
 * Mark: "on the intake form, have it use our google key for the google maps".
 *
 * The staff lookup (`searchAddresses`) sits behind `requireSupabaseAuth`, and
 * the person filling this form has no Supabase session — the token in the URL
 * is their only credential. So this is the same lookup behind the same door
 * the rest of this file uses: `readRequest` + `linkProblem`, exactly as submit
 * and the photo upload check it, which means an unknown, revoked, expired or
 * already-consumed link gets no Google call at all.
 *
 * Removing the auth middleware from the staff function instead would have put
 * a billed Places endpoint on the open internet with no gate whatsoever.
 *
 * ORDERING, and why there is no per-IP guard in front: the token check is what
 * stands between an anonymous caller and Google's meter, so it goes first and
 * the per-token cap goes behind it, the same way `throttleWebhook` sits behind
 * its HMAC compare. Nothing bills until a real link has been produced. Raw
 * request volume from one address is Cloudflare WAF's job, as the header of
 * rate-limit.server.ts says.
 *
 * FAILS CLOSED, like submitting the form and unlike loading it. Loading fails
 * open because a counter store that is down must not cost the office a lead.
 * This one costs nothing when it refuses: the box is a normal text input and the
 * panel already says "type the address manually below".
 */
export const searchIntakeAddresses = createServerFn({ method: "GET" })
  .inputValidator((data: { token: string; q: string; near?: GeoPoint | null }) => {
    if (!data?.token || data.token.length < 16) throw new Error("Invalid link.");
    return {
      token: data.token,
      q: String(data.q ?? "").slice(0, 160),
      near: cleanGeoPoint(data.near),
    };
  })
  .handler(async ({ data }): Promise<AddressSearchResult> => {
    const q = data.q.trim();
    if (q.length < 3) return { results: [], provider: "none" };

    const db = await adminClient();
    const { row: req, failed } = await readRequest(db, data.token);
    const invalid = linkProblem(req, failed);
    if (invalid || !req) throw new Error(invalid ?? "This link is no longer valid.");

    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const outcome = await consumeLimit(
      "intake:address",
      data.token,
      RATE_LIMITS.publicAddressLookup,
      "closed",
    );
    if (!outcome.allowed) {
      throw new Error(
        "Too many address lookups on this form. Please type the address in yourself.",
      );
    }

    // Lean toward where the customer is (their phone, if they allowed it),
    // else toward the office the form belongs to — never the server's host.
    const near = data.near ?? (await officePoint(db, req.location_id ?? null));
    const { runAddressSearch } = await import("./address-search.server");
    return runAddressSearch(q, near);
  });

/** The office's map pin, for leaning suggestions; null when it has none. */
async function officePoint(db: AdminDb, locationId: string | null): Promise<GeoPoint | null> {
  if (!locationId) return null;
  const { data } = await db.from("locations").select("lat, lon").eq("id", locationId).maybeSingle();
  return cleanGeoPoint(data);
}

/**
 * "Use my location" on the public intake form: the street address where the
 * customer's phone is. Same token gate and per-token cap as the lookup.
 */
export const reverseIntakeAddress = createServerFn({ method: "GET" })
  .inputValidator((data: { token: string; lat: number; lon: number }) => {
    if (!data?.token || data.token.length < 16) throw new Error("Invalid link.");
    const point = cleanGeoPoint(data, 6);
    if (!point) throw new Error("That location could not be read.");
    return { token: data.token, ...point };
  })
  .handler(async ({ data }): Promise<AddressSuggestion | null> => {
    const db = await adminClient();
    const { row: req, failed } = await readRequest(db, data.token);
    const invalid = linkProblem(req, failed);
    if (invalid || !req) throw new Error(invalid ?? "This link is no longer valid.");

    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const outcome = await consumeLimit(
      "intake:address",
      data.token,
      RATE_LIMITS.publicAddressLookup,
      "closed",
    );
    if (!outcome.allowed) return null;

    const { reverseGeocode } = await import("./address-search.server");
    return reverseGeocode({ lat: data.lat, lon: data.lon });
  });

/** The picked prediction's full address; same gate and cap as the lookup. */
export const resolveIntakeAddress = createServerFn({ method: "GET" })
  .inputValidator((data: { token: string; placeId: string }) => {
    if (!data?.token || data.token.length < 16) throw new Error("Invalid link.");
    return { token: data.token, placeId: String(data.placeId ?? "").slice(0, 300) };
  })
  .handler(async ({ data }): Promise<AddressSuggestion | null> => {
    const db = await adminClient();
    const { row: req, failed } = await readRequest(db, data.token);
    const invalid = linkProblem(req, failed);
    if (invalid || !req) throw new Error(invalid ?? "This link is no longer valid.");

    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const outcome = await consumeLimit(
      "intake:address",
      data.token,
      RATE_LIMITS.publicAddressLookup,
      "closed",
    );
    if (!outcome.allowed) return null;

    const { resolveGooglePlace } = await import("./address-search.server");
    return resolveGooglePlace(data.placeId);
  });
