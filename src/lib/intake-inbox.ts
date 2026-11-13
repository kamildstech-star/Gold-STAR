/**
 * Completed intake forms that are not a job yet.
 *
 * A standalone intake link is sent to someone who is not in the CRM, so what
 * comes back is a lead, not an update: it waits here until the office either
 * attaches it to a job that already exists or turns it into a new one. Nothing
 * in this file writes a job on its own — a submission is a claim by a stranger
 * until a staff member decides what it is.
 *
 * The columns that make a request standalone (`location_id`, `label`) ship in a
 * migration that is written but not applied, so every read here degrades: the
 * inbox reports itself unavailable rather than rendering an empty list, because
 * an empty inbox that is really a failed query is a lead that vanished.
 */
import { browserAppOrigin } from "@/lib/app-origin";
import { supabase } from "@/integrations/supabase/client";
import { formLinkDefaults } from "./form-links";
import { parseIntakePhotos, type IntakePhoto } from "./intake-form";
import { isMissingSchema } from "./schema-fallback";

export type IntakeAnswerValue = {
  text?: string | null;
  bool?: boolean | null;
  date?: string | null;
};

export type IntakeInboxRequest = {
  id: string;
  recipient_name: string | null;
  recipient_email: string | null;
  label: string | null;
  location_id: string | null;
  /** Set when the link was minted for a trade show — the lead is that show's. */
  tradeshow_id: string | null;
};

export type IntakeInboxRow = {
  id: string;
  created_at: string;
  submitted_by_name: string | null;
  submitted_by_email: string | null;
  fields: Record<string, string | null>;
  answers: Record<string, IntakeAnswerValue>;
  /** Office this submission belongs to. Set by address routing on a general link. */
  location_id: string | null;
  /** True when the office was chosen from the address, not by a person. */
  location_auto_assigned: boolean;
  /**
   * Why the address chose it — a rule or the map (20261006170000). Null on a
   * row routed before that, which the badge reads as plain "from address".
   */
  location_route_reason: string | null;
  /** The state or ZIP prefix a rule matched on. */
  location_route_detail: string | null;
  /**
   * Who picked the office by hand on the intake card, and when
   * (20261006171000). Set, the office is a person's choice: the badge says
   * so and a rule change never moves it.
   */
  location_set_by: string | null;
  location_set_at: string | null;
  /** Their name, looked up after the read; null when it could not be. */
  location_set_by_name: string | null;
  /** Photos the customer attached on the public form (20260903224000). */
  photos: IntakePhoto[];
  request: IntakeInboxRequest | null;
};

/** Labels for the free-form payload the public form posts back. */
export const INTAKE_FIELD_LABEL: Record<string, string> = {
  site_address: "Property address",
  site_unit: "Apt / Unit / Suite",
  customer_name: "Name",
  customer_phone: "Phone",
  customer_email: "Email",
  loss_type_id: "Type of loss",
  loss_type_other: "Type of loss (described)",
  loss_date: "Date of loss",
  insurance_carrier: "Insurance carrier",
  claim_number: "Claim number",
  policy_number: "Policy number",
  company: "Company",
  notes: "Notes",
};

/** The subset that maps straight onto job columns. Address stays advisory —
 *  a job address is parsed into six columns and one typed line is not that. */
export const INTAKE_FIELD_COLUMN: Record<string, string> = {
  customer_name: "customer_name",
  loss_type_id: "loss_type_id",
  loss_date: "loss_date",
  insurance_carrier: "insurance_carrier",
  claim_number: "claim_number",
  policy_number: "policy_number",
  notes: "initial_loss_description",
};

const SUBMISSION_COLUMNS =
  "id, created_at, submitted_by_name, submitted_by_email, fields, answers, request_id";
/** Plus the routing columns from 20260903223000 (general links). */
const SUBMISSION_COLUMNS_ROUTED = `${SUBMISSION_COLUMNS}, location_id, location_auto_assigned`;
/** Plus why the address chose the office (20261006170000, intake office rules). */
const SUBMISSION_COLUMNS_REASONED = `${SUBMISSION_COLUMNS_ROUTED}, location_route_reason, location_route_detail`;
/** Plus who chose it by hand (20261006171000, the card's quick switch). */
const SUBMISSION_COLUMNS_CHOSEN = `${SUBMISSION_COLUMNS_REASONED}, location_set_by, location_set_at`;

/*
 * Shapes of the same read, newest first. Each column set ships in its own
 * migration and the database may have taken any prefix of them, so the read
 * tries the richest and steps back on a missing-column error. Only the last
 * shape means the standalone migration itself is missing.
 */
const REQUEST_EMBED_SHOW =
  "intake_requests(id, recipient_name, recipient_email, label, location_id, tradeshow_id)";
const REQUEST_EMBED = "intake_requests(id, recipient_name, recipient_email, label, location_id)";
const REQUEST_EMBED_LEGACY = "intake_requests(id, recipient_name, recipient_email)";
const SELECT_SHAPES = [
  `${SUBMISSION_COLUMNS_CHOSEN}, photos, ${REQUEST_EMBED_SHOW}`,
  `${SUBMISSION_COLUMNS_REASONED}, photos, ${REQUEST_EMBED_SHOW}`,
  `${SUBMISSION_COLUMNS_ROUTED}, photos, ${REQUEST_EMBED_SHOW}`,
  `${SUBMISSION_COLUMNS_ROUTED}, ${REQUEST_EMBED_SHOW}`,
  `${SUBMISSION_COLUMNS}, ${REQUEST_EMBED_SHOW}`,
  `${SUBMISSION_COLUMNS}, ${REQUEST_EMBED}`,
  `${SUBMISSION_COLUMNS}, ${REQUEST_EMBED_LEGACY}`,
] as const;
const LEGACY_SHAPE = SELECT_SHAPES[SELECT_SHAPES.length - 1];

type RawRow = Omit<
  IntakeInboxRow,
  | "request"
  | "location_id"
  | "location_auto_assigned"
  | "location_route_reason"
  | "location_route_detail"
  | "location_set_by"
  | "location_set_at"
  | "location_set_by_name"
  | "photos"
> & {
  location_id?: string | null;
  location_auto_assigned?: boolean | null;
  location_route_reason?: string | null;
  location_route_detail?: string | null;
  location_set_by?: string | null;
  location_set_at?: string | null;
  photos?: unknown;
  intake_requests: Partial<IntakeInboxRequest> | Partial<IntakeInboxRequest>[] | null;
};

function shape(rows: RawRow[]): IntakeInboxRow[] {
  return rows.map((r) => {
    const embedded = Array.isArray(r.intake_requests) ? r.intake_requests[0] : r.intake_requests;
    return {
      id: r.id,
      created_at: r.created_at,
      submitted_by_name: r.submitted_by_name,
      submitted_by_email: r.submitted_by_email,
      fields: (r.fields ?? {}) as Record<string, string | null>,
      answers: (r.answers ?? {}) as Record<string, IntakeAnswerValue>,
      location_id: r.location_id ?? null,
      location_auto_assigned: r.location_auto_assigned === true,
      location_route_reason: r.location_route_reason ?? null,
      location_route_detail: r.location_route_detail ?? null,
      location_set_by: r.location_set_by ?? null,
      location_set_at: r.location_set_at ?? null,
      location_set_by_name: null,
      photos: parseIntakePhotos(r.photos),
      request: embedded
        ? {
            id: embedded.id as string,
            recipient_name: embedded.recipient_name ?? null,
            recipient_email: embedded.recipient_email ?? null,
            label: embedded.label ?? null,
            location_id: embedded.location_id ?? null,
            tradeshow_id: embedded.tradeshow_id ?? null,
          }
        : null,
    };
  });
}

/**
 * Fill in the name of whoever set each office by hand. A name is a nicety on
 * the badge, not the record: if it cannot be read the badge says "set by
 * hand" and the list still loads.
 */
async function withSetterNames(rows: IntakeInboxRow[]): Promise<IntakeInboxRow[]> {
  const ids = [...new Set(rows.map((r) => r.location_set_by).filter((x): x is string => !!x))];
  if (!ids.length) return rows;
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", ids);
  if (error) return rows;
  const name = new Map((data ?? []).map((p) => [p.user_id as string, p.full_name ?? null]));
  return rows.map((r) =>
    r.location_set_by ? { ...r, location_set_by_name: name.get(r.location_set_by) ?? null } : r,
  );
}

/**
 * Pending submissions with no job. `migrated` is false when the database has
 * not taken the standalone migration yet — the caller must say so rather than
 * show the (necessarily empty) list as if it were the truth.
 */
export async function listUnassignedIntakes(): Promise<{
  rows: IntakeInboxRow[];
  migrated: boolean;
}> {
  const run = (select: string) =>
    supabase
      .from("intake_submissions")
      .select(select)
      .is("job_id", null)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

  for (const select of SELECT_SHAPES) {
    const res = await run(select);
    if (!res.error) {
      return {
        rows: await withSetterNames(shape((res.data ?? []) as unknown as RawRow[])),
        migrated: select !== LEGACY_SHAPE,
      };
    }
    if (!isMissingSchema(res.error) || select === LEGACY_SHAPE) throw res.error;
  }
  return { rows: [], migrated: false };
}

/**
 * Count for the sidebar badge. A badge is a hint, not a result: it stays dark
 * when the count cannot be read, and the inbox itself reports the failure.
 */
export async function countUnassignedIntakes(): Promise<number> {
  const { count, error } = await supabase
    .from("intake_submissions")
    .select("id", { count: "exact", head: true })
    .is("job_id", null)
    .eq("status", "pending");
  if (error) return 0;
  return count ?? 0;
}

export async function loadIntakeSubmission(id: string): Promise<IntakeInboxRow | null> {
  const run = (select: string) =>
    supabase.from("intake_submissions").select(select).eq("id", id).maybeSingle();

  for (const select of SELECT_SHAPES) {
    const res = await run(select);
    if (!res.error) return res.data ? shape([res.data as unknown as RawRow])[0]! : null;
    if (!isMissingSchema(res.error) || select === LEGACY_SHAPE) throw res.error;
  }
  return null;
}

const trimmed = (v: string | null | undefined) => (v ?? "").trim();

/**
 * Attach a lead to a job that already exists.
 *
 * Fills only what the job is missing and answers only the questions it has not
 * answered. Nothing a staff member typed is overwritten by a stranger's form —
 * anything that disagrees stays on the submission, which now belongs to the
 * job, and surfaces in the job's own recipient-review card for a human to
 * accept value by value.
 */
export async function attachIntakeToJob(input: {
  submission: IntakeInboxRow;
  jobId: string;
  userId: string | null;
  /** The carrier a reviewer confirmed for the typed name, if they confirmed one. */
  carrierAccountId?: string | null;
}): Promise<void> {
  const { submission, jobId, userId } = input;

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select(
      "customer_name, loss_type_id, loss_date, insurance_carrier, insurance_carrier_account_id, claim_number, policy_number, initial_loss_description",
    )
    .eq("id", jobId)
    .maybeSingle();
  if (jobError) throw jobError;
  if (!job) throw new Error("That job could not be read, so nothing was attached.");

  const current = job as unknown as Record<string, string | null>;
  const patch: Record<string, string> = {};
  for (const [key, value] of Object.entries(submission.fields ?? {})) {
    const column = INTAKE_FIELD_COLUMN[key];
    if (!column || trimmed(current[column])) continue;
    if (trimmed(value)) patch[column] = trimmed(value);
  }
  /* The carrier account is never inferred here — it is only ever the one a
     reviewer confirmed, and only onto a job that has none. */
  if (input.carrierAccountId && !trimmed(current["insurance_carrier_account_id"])) {
    patch["insurance_carrier_account_id"] = input.carrierAccountId;
  }
  if (Object.keys(patch).length) {
    const { error } = await supabase
      .from("jobs")
      .update(patch as never)
      .eq("id", jobId);
    if (error) throw error;
  }

  const { data: existing, error: answerError } = await supabase
    .from("job_intake_answers")
    .select("question_id")
    .eq("job_id", jobId);
  if (answerError) throw answerError;
  const answered = new Set((existing ?? []).map((a) => a.question_id as string));

  const rows = Object.entries(submission.answers ?? {})
    .filter(([questionId, a]) => {
      if (answered.has(questionId)) return false;
      return trimmed(a.text) !== "" || a.bool != null || trimmed(a.date) !== "";
    })
    .map(([question_id, a]) => ({
      job_id: jobId,
      question_id,
      answer_text: trimmed(a.text) || null,
      answer_bool: a.bool ?? null,
      answer_date: trimmed(a.date) || null,
      source: "recipient",
    }));
  if (rows.length) {
    const { error } = await supabase
      .from("job_intake_answers")
      .upsert(rows as never, { onConflict: "job_id,question_id" });
    if (error) throw error;
  }

  await claimSubmission(submission, jobId, userId, "pending");
}

/** Called once a job has been created from a submission — the link that says
 *  which lead became which job, so the same form is never worked twice. */
export async function linkIntakeToCreatedJob(
  submission: IntakeInboxRow,
  jobId: string,
  userId: string | null,
): Promise<void> {
  await claimSubmission(submission, jobId, userId, "applied");
}

async function claimSubmission(
  submission: IntakeInboxRow,
  jobId: string,
  userId: string | null,
  status: "pending" | "applied",
): Promise<void> {
  const { error } = await supabase
    .from("intake_submissions")
    .update({
      job_id: jobId,
      status,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", submission.id);
  if (error) throw error;

  if (submission.request?.id) {
    const { error: requestError } = await supabase
      .from("intake_requests")
      .update({ job_id: jobId })
      .eq("id", submission.request.id);
    if (requestError) throw requestError;
  }
}

/**
 * Move a waiting form to another office — the quick switch on the intake card.
 *
 * The choice is recorded as a person's: `location_auto_assigned` false (so a
 * rule change never moves it back), and `location_set_by` asked for, which
 * the database stamps with the caller's own id and the time (20261006171000).
 * Who may move what is intake_submissions_write; a move it refuses updates no
 * row, and that is said rather than shown as a success.
 *
 * Before 20261006171000 is applied the "who" columns do not exist: the office
 * is still moved and still marked as not the address's guess, so the switch
 * works and only the name on the badge is missing.
 */
export async function setIntakeOffice(input: {
  submissionId: string;
  locationId: string;
  userId: string | null;
}): Promise<void> {
  const base = { location_id: input.locationId, location_auto_assigned: false };
  const run = (patch: Record<string, unknown>) =>
    supabase
      .from("intake_submissions")
      .update(patch as never)
      .eq("id", input.submissionId)
      .is("job_id", null)
      .select("id");
  let res = await run({ ...base, location_set_by: input.userId });
  if (res.error && isMissingSchema(res.error)) res = await run(base);
  if (res.error) throw res.error;
  if (!res.data?.length) {
    throw new Error(
      "That form could not be moved. It may already be a job, or you do not manage one of the two offices.",
    );
  }
}

export async function dismissIntake(id: string, userId: string | null): Promise<void> {
  const { error } = await supabase
    .from("intake_submissions")
    .update({ status: "dismissed", reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export function intakeLinkUrl(token: string): string {
  const origin = browserAppOrigin();
  return `${origin}/intake/${token}`;
}

/** How long a general (website) link lives. It is a fixture, not a one-off. */
const GENERAL_LINK_YEARS = 10;

/**
 * Mint a link that belongs to an office rather than to a job. Expiry follows
 * the same admin setting every other public link in the app uses.
 *
 * With `locationId: null` this is the GENERAL link: multi-use (the same flag
 * a trade-show link uses), long-lived, and routed by address on every
 * submission. Only privileged users can mint one — the request RLS says so —
 * and the dialog offers it only to them.
 */
export async function createStandaloneIntakeLink(input: {
  locationId: string | null;
  label: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  userId: string | null;
}): Promise<string> {
  const general = input.locationId === null;
  const defaults = await formLinkDefaults();
  const expiresAt = general
    ? new Date(Date.now() + GENERAL_LINK_YEARS * 365 * 86400_000)
    : new Date(Date.now() + defaults.expires_in_days * 86400_000);
  const { data, error } = await supabase
    .from("intake_requests")
    .insert({
      job_id: null,
      location_id: input.locationId,
      multi_use: general,
      label: input.label?.trim() || (general ? "Website" : null),
      recipient_name: input.recipientName?.trim() || null,
      recipient_email: input.recipientEmail?.trim() || null,
      expires_at: expiresAt.toISOString(),
      created_by: input.userId,
    })
    .select("token")
    .single();
  if (error) throw error;
  return intakeLinkUrl(data.token as string);
}
