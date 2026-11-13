/**
 * Suggested job fields, one row per value a recipient gave us.
 *
 * A pending `intake_submissions` row — from the secure intake form or read out
 * of an emailed reply (info-reply.server.ts) — is a set of PROPOSALS. This
 * module turns one into the rows the review panel shows: what the job holds
 * now, what was proposed, and where Apply would write it:
 *
 *   - `job`:     a job column, written through updateJobFields (job-update.ts)
 *                — the same path as the job's Edit all forms, so field
 *                permissions, the offline queue and the field-change history
 *                trigger all apply exactly as they do to a typed edit;
 *   - `answer`:  an intake question, through saveJobIntakeAnswers;
 *   - `contact`: a phone or email added to the job's Phones & emails list
 *                (job-contact-methods.ts) — added, never replacing one;
 *   - `advisory`: shown for reference with Dismiss only (the property address
 *                as the customer typed it, a described loss type).
 *
 * A value the job already holds is not a suggestion and gets no row. Pure: no
 * database, no React, so the panel and the tests read the same rows.
 */
import { isIntakeGeoField } from "@/lib/intake-form";
import { JOB_FIELD_BY_KEY, coerceJobValue, type JobFieldDef } from "@/lib/job-fields";
import { fmtDate, fmtMoney } from "@/lib/jobs";
import { CONTACT_FIELD_KIND } from "@/lib/info-reply";

export type SubmissionAnswer = {
  text?: string | null;
  bool?: boolean | null;
  date?: string | null;
};

export type FieldDecision = { status: "applied" | "dismissed"; value?: string | null };

export type SuggestionSubmission = {
  id: string;
  submitted_by_name: string | null;
  submitted_by_email: string | null;
  created_at: string;
  fields: Record<string, string | null>;
  answers: Record<string, SubmissionAnswer>;
  status: string;
  /** 'form' | 'email_reply'. Absent before migration 20261013121500. */
  source?: string | null;
  source_subject?: string | null;
  source_excerpt?: string | null;
  source_received_at?: string | null;
  field_review?: Record<string, FieldDecision> | null;
};

export type SuggestionQuestion = {
  id: string;
  prompt: string;
  answer_type: string;
  choices?: string[] | null;
};

export type ExistingAnswer = {
  answer_text: string | null;
  answer_bool: boolean | null;
  answer_date: string | null;
};

export type SuggestionTarget =
  | { type: "job"; column: string; def: Pick<JobFieldDef, "kind" | "label"> }
  | { type: "answer"; questionId: string; answerType: string; choices: string[] }
  | { type: "contact"; kind: "phone" | "email" }
  | { type: "advisory" };

export type SuggestionRow = {
  /** `<submission id>:<field id>` — unique across the panel. */
  id: string;
  submissionId: string;
  /** `f:<field key>` or `a:<question id>` — the key in `field_review`. */
  fieldId: string;
  label: string;
  target: SuggestionTarget;
  /** The stored proposal: ISO date, "true"/"false", digits, text. */
  proposed: string;
  proposedText: string;
  currentText: string;
  /** Apply would replace a value the job already has. */
  overwrites: boolean;
  status: "pending" | "applied" | "dismissed";
};

export type SuggestionContext = {
  job: Record<string, unknown> | null;
  answers: Record<string, ExistingAnswer | undefined>;
  questions: SuggestionQuestion[];
  /** Phones/emails already on the job: its own list plus the main contact's. */
  contactValues: { phone: string[]; email: string[] };
  lossTypeLabel: (id: string) => string;
  /** Field permissions (useJobFieldAccess). A hidden field gets no row. */
  canSee: (column: string) => boolean;
};

const FIELD_LABEL: Record<string, string> = {
  site_address: "Property address",
  customer_name: "Insured name",
  customer_phone: "Phone",
  customer_email: "Email",
  loss_type_id: "Type of loss",
  loss_type_other: "Type of loss (described)",
  loss_date: "Date of loss",
  insurance_carrier: "Insurance carrier",
};

/** Kept for reference only: no single job column takes these as typed. */
const ADVISORY = new Set(["site_address", "loss_type_other"]);

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

function display(kind: string, value: unknown): string {
  if (value == null || value === "") return "—";
  switch (kind) {
    case "date":
      return fmtDate(String(value));
    case "bool":
      return value === true || value === "true" ? "Yes" : "No";
    case "money":
      return fmtMoney(Number(value));
    case "time":
      return String(value).slice(0, 5);
    default:
      return String(value);
  }
}

function same(kind: string, a: unknown, b: unknown): boolean {
  if (a == null || a === "") return b == null || b === "";
  if (kind === "bool")
    return String(a === true || a === "true") === String(b === true || b === "true");
  if (kind === "money") return Number(a) === Number(b);
  if (kind === "date") return String(a).slice(0, 10) === String(b ?? "").slice(0, 10);
  return (
    String(a).trim().toLowerCase() ===
    String(b ?? "")
      .trim()
      .toLowerCase()
  );
}

export function answerText(type: string, a: SubmissionAnswer): string {
  if (a.bool != null) return a.bool ? "Yes" : "No";
  if (type === "date" || a.date) return a.date ? fmtDate(a.date) : "";
  return (a.text ?? "").toString();
}

/** What a question's proposal is stored as, raw: "true"/"false", ISO date, text. */
function answerRaw(a: SubmissionAnswer): string {
  if (a.bool != null) return a.bool ? "true" : "false";
  return (a.date || a.text || "").toString().trim();
}

/** The review rows for one submission, in a stable order. */
export function buildSuggestionRows(
  sub: SuggestionSubmission,
  ctx: SuggestionContext,
): SuggestionRow[] {
  const rows: SuggestionRow[] = [];
  const review = sub.field_review ?? {};
  const statusOf = (fieldId: string) => review[fieldId]?.status ?? "pending";

  for (const [field, rawValue] of Object.entries(sub.fields ?? {})) {
    const value = rawValue == null ? "" : String(rawValue).trim();
    if (!value) continue;
    /* The coordinates and address parts a Google pick carries ride along with
       the address line and never get a row of their own. */
    if (isIntakeGeoField(field)) continue;
    const fieldId = `f:${field}`;
    const base = { id: `${sub.id}:${fieldId}`, submissionId: sub.id, fieldId };

    const contactKind = CONTACT_FIELD_KIND[field];
    if (contactKind) {
      const have = ctx.contactValues[contactKind];
      const dup =
        contactKind === "phone"
          ? have.some((h) => digits(h) === digits(value) && digits(value).length >= 7)
          : have.some((h) => h.trim().toLowerCase() === value.toLowerCase());
      if (dup) continue;
      rows.push({
        ...base,
        label: contactKind === "phone" ? "Phone (add to job)" : "Email (add to job)",
        target: { type: "contact", kind: contactKind },
        proposed: value,
        proposedText: value,
        currentText: have.length ? have.join(", ") : "—",
        overwrites: false,
        status: statusOf(fieldId),
      });
      continue;
    }

    if (ADVISORY.has(field)) {
      rows.push({
        ...base,
        label: FIELD_LABEL[field] ?? field,
        target: { type: "advisory" },
        proposed: value,
        proposedText: value,
        currentText: field === "site_address" ? String(ctx.job?.["address"] ?? "—") || "—" : "—",
        overwrites: false,
        status: statusOf(fieldId),
      });
      continue;
    }

    if (field === "loss_type_id") {
      if (!ctx.canSee("loss_type")) continue;
      const current = ctx.job?.["loss_type_id"] as string | null | undefined;
      if (current && current === value) continue;
      rows.push({
        ...base,
        label: FIELD_LABEL[field]!,
        target: {
          type: "job",
          column: "loss_type_id",
          def: { kind: "option", label: "Type of loss" },
        },
        proposed: value,
        proposedText: ctx.lossTypeLabel(value),
        currentText: current ? ctx.lossTypeLabel(current) : "—",
        overwrites: Boolean(current),
        status: statusOf(fieldId),
      });
      continue;
    }

    const def = JOB_FIELD_BY_KEY[field];
    // An unknown key, a field behind a confirmation (job number), or one this
    // person may not see is not offered as a one-click write.
    if (!def || def.warn || !ctx.canSee(field)) continue;
    const current = ctx.job?.[field];
    if (same(def.kind, current, value)) continue;
    rows.push({
      ...base,
      label: FIELD_LABEL[field] ?? def.label,
      target: { type: "job", column: field, def: { kind: def.kind, label: def.label } },
      proposed: value,
      proposedText: display(def.kind, value),
      currentText: display(def.kind, current),
      overwrites: current != null && current !== "",
      status: statusOf(fieldId),
    });
  }

  for (const [qid, a] of Object.entries(sub.answers ?? {})) {
    const q = ctx.questions.find((x) => x.id === qid);
    const type = q?.answer_type ?? "text";
    const proposed = answerRaw(a ?? {});
    if (!proposed) continue;
    const existing = ctx.answers[qid];
    const currentRaw = existing
      ? existing.answer_bool != null
        ? existing.answer_bool
          ? "true"
          : "false"
        : (existing.answer_date ?? existing.answer_text ?? "").toString().trim()
      : "";
    if (currentRaw && currentRaw.toLowerCase() === proposed.toLowerCase()) continue;
    const fieldId = `a:${qid}`;
    rows.push({
      id: `${sub.id}:${fieldId}`,
      submissionId: sub.id,
      fieldId,
      label: q?.prompt ?? "Question",
      target: q
        ? {
            type: "answer",
            questionId: qid,
            answerType: type,
            choices: (q.choices ?? []).filter(Boolean),
          }
        : { type: "advisory" },
      proposed,
      proposedText: answerText(type, a ?? {}),
      currentText: currentRaw
        ? answerText(type, {
            bool: existing?.answer_bool ?? null,
            date: existing?.answer_date ?? null,
            text: existing?.answer_text ?? null,
          })
        : "—",
      overwrites: Boolean(currentRaw),
      status: statusOf(fieldId),
    });
  }
  return rows;
}

/** The value Apply writes to a job column. */
export function jobPatchValue(
  target: Extract<SuggestionTarget, { type: "job" }>,
  value: string,
): unknown {
  if (target.column === "loss_type_id") return value.trim() || null;
  return coerceJobValue(
    { key: target.column, label: target.def.label, group: "identity", kind: target.def.kind },
    value,
  );
}

/** The answer Apply writes to an intake question. */
export function answerPatch(answerType: string, value: string) {
  const v = value.trim();
  if (answerType === "yes_no") {
    return {
      answer_text: null,
      answer_bool: v === "true" || v.toLowerCase() === "yes",
      answer_date: null,
    };
  }
  if (answerType === "date")
    return { answer_text: null, answer_bool: null, answer_date: v || null };
  return { answer_text: v || null, answer_bool: null, answer_date: null };
}

/**
 * Fields in a submission this person is not shown but somebody else could
 * act on — a job field they may not see — and that nobody has decided yet.
 *
 * David, 13 Oct: approving one item of a reply must leave the others alive.
 * The panel only builds rows this viewer may see, so without this a reviewer
 * who decided every row THEY could see closed the whole reply, and the items
 * hidden from them vanished with it.
 *
 * A field the job already holds, an unknown key, or one behind a confirmation
 * (job number) is not counted: no one is ever offered those as a write.
 */
export function heldBackFieldIds(
  sub: Pick<SuggestionSubmission, "fields" | "field_review">,
  ctx: Pick<SuggestionContext, "canSee" | "job">,
): string[] {
  const review = sub.field_review ?? {};
  const out: string[] = [];
  for (const [field, rawValue] of Object.entries(sub.fields ?? {})) {
    const value = rawValue == null ? "" : String(rawValue).trim();
    if (!value || isIntakeGeoField(field) || CONTACT_FIELD_KIND[field] || ADVISORY.has(field)) {
      continue;
    }
    const fieldId = `f:${field}`;
    if (review[fieldId]) continue;
    const seeKey = field === "loss_type_id" ? "loss_type" : field;
    const def =
      field === "loss_type_id" ? { kind: "option", warn: false } : JOB_FIELD_BY_KEY[field];
    if (!def || def.warn || ctx.canSee(seeKey)) continue;
    const current = ctx.job?.[field];
    if (current != null && String(current).trim() === value) continue;
    out.push(fieldId);
  }
  return out;
}

/**
 * After a decision: still pending while any row is — or while any field held
 * back from this viewer is undecided (`heldBackFieldIds`) — else applied if
 * anything was.
 */
export function submissionStatusAfter(
  rows: Pick<SuggestionRow, "status">[],
  heldBack: readonly string[] = [],
): "pending" | "applied" | "dismissed" {
  if (heldBack.length > 0) return "pending";
  if (rows.some((r) => r.status === "pending")) return "pending";
  return rows.some((r) => r.status === "applied") ? "applied" : "dismissed";
}

export const senderOf = (
  sub: Pick<SuggestionSubmission, "submitted_by_name" | "submitted_by_email">,
) => sub.submitted_by_name?.trim() || sub.submitted_by_email?.trim() || "the recipient";

/** "New info from Jane Smith — 4 fields to review". */
export function bubbleText(
  subs: Pick<SuggestionSubmission, "submitted_by_name" | "submitted_by_email">[],
  pending: number,
): string {
  const senders = [...new Set(subs.map(senderOf))];
  const who = senders.length === 1 ? senders[0] : `${senders[0]} and ${senders.length - 1} more`;
  return `New info from ${who} — ${pending} field${pending === 1 ? "" : "s"} to review`;
}
