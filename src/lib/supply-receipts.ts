/**
 * A photographed receipt: stored always, read when it can be.
 *
 * David, 17 Sep: "if somebody goes into Home Depot and just buys an item off
 * the shelf, they should be able to take a picture of the receipt and upload
 * it to the system. Now, if the system can read the receipt, that'll be great
 * — what supplies were purchased and how many and the date and all that. But
 * if not, at the very minimum it should send an alert to somebody — to be
 * determined — that a receipt was uploaded by so-and-so."
 *
 * THE ORDER OF THOSE TWO SENTENCES IS THE DESIGN. The alert is the product and
 * the parse is the bonus, so everything here works when the model reads
 * nothing: the row exists the moment the picture is stored, the alert fires off
 * the row, and an unreadable receipt is a normal outcome with a normal screen
 * rather than an error.
 *
 * Nothing the model returns is ever committed on its own. A parse becomes a
 * DRAFT; an approver corrects it and approves it, and only then do the lines
 * reach `supply_purchases`, which is the table the Spending report already
 * reads. There is no second place money lives.
 *
 * Mark, 5 Oct: "Need area for crews to upload purchase receipts. It should
 * probably be tied to purchasing, AI to read the items and need to get
 * approved just to add to purchase tracking." The approval is enforced in the
 * database (20261005173000): `approve_supply_receipt` is the only path from a
 * receipt into purchase tracking, it refuses the person who uploaded the
 * receipt, and it refuses anybody who could not already write purchase
 * tracking by hand. What is in this file only mirrors those rules so the
 * screen can say no before the server does.
 */

import { supabase } from "@/integrations/supabase/client";
import { describeDbError } from "@/lib/db-errors";
import { FINANCE_ROLES } from "@/lib/finance";
import type { AppRole } from "@/lib/roles";
import { isMissingSchema } from "@/lib/schema-fallback";
import { roundMoney } from "@/lib/money";
import { TONE } from "@/lib/tone";

export const RECEIPT_REVIEWER_KEY = "supply_receipt_reviewer";

/** One line the model thinks it saw. Every field optional — it is a guess. */
export type ReceiptDraftLine = {
  label: string;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
};

export type ReceiptDraft = {
  supplier: string | null;
  purchasedOn: string | null;
  total: number | null;
  lines: ReceiptDraftLine[];
};

export type SupplyReceipt = {
  id: string;
  location_id: string;
  job_id: string | null;
  /** The supply order this receipt paid for (20260925132000), when it was attached to one. */
  request_id?: string | null;
  uploaded_by: string | null;
  storage_bucket: string;
  storage_path: string;
  parsed: ReceiptDraft | null;
  /** 'uploaded' | 'unreadable' | 'approved' | 'rejected' — see `receiptStage`. */
  status: string;
  note: string | null;
  created_at: string;
  /** Who decided it, and when — approved or rejected alike. */
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  /** 20261005173000. What the uploader is told when it is not approved. */
  rejection_reason?: string | null;
  /** 20261005173000. What the approver confirmed into purchase tracking. */
  approved_lines?: ApprovedReceipt | null;
};

/** The approver's confirmed version, as `approve_supply_receipt` stores it. */
export type ApprovedReceipt = {
  supplier: string;
  purchased_on: string;
  total: number;
  lines: ApprovalLine[];
};

const num = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => {
  const s = typeof v === "string" ? v.trim() : "";
  return s ? s.slice(0, 200) : null;
};

/**
 * An ISO date, or nothing.
 *
 * A receipt prints a date in whatever the till felt like. Anything that does
 * not parse to a real day is dropped rather than guessed — a wrong date on a
 * spending entry is worse than an empty one, because nobody goes back to check
 * a field that looks filled in.
 */
export function receiptDate(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const parsed = Date.parse(`${s}T00:00:00`);
  return Number.isNaN(parsed) ? null : s;
}

/**
 * The model's reply, turned into a draft or into nothing.
 *
 * Untrusted data: parsed for JSON, each field normalised or dropped, and the
 * result never becomes part of another prompt. Mirrors `parseCardModelOutput`
 * deliberately — the two readers should fail the same way.
 */
export function parseReceiptModelOutput(raw: string): ReceiptDraft | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const rawLines = Array.isArray(o.lines) ? o.lines : [];
  const lines: ReceiptDraftLine[] = rawLines
    .map((entry) => {
      const l = (entry ?? {}) as Record<string, unknown>;
      return {
        label: str(l.label) ?? "",
        quantity: num(l.quantity),
        unitPrice: num(l.unit_price ?? l.unitPrice),
        total: num(l.total),
      };
    })
    // A line with no name is not a line. The model pads when it is unsure.
    .filter((l) => l.label.length > 0)
    .slice(0, 60);

  const draft: ReceiptDraft = {
    supplier: str(o.supplier),
    purchasedOn: receiptDate(o.purchased_on ?? o.purchasedOn),
    total: num(o.total),
    lines,
  };

  // Nothing readable at all is not a draft. Saying so lets the screen show the
  // honest "we could not read this" instead of an empty form that looks broken.
  const empty = !draft.supplier && !draft.purchasedOn && draft.total == null && lines.length === 0;
  return empty ? null : draft;
}

/** What the total should be, when the model gave lines but no total. */
export function receiptTotal(draft: ReceiptDraft): number | null {
  if (draft.total != null) return draft.total;
  const summable = draft.lines.map((l) => l.total ?? null).filter((n): n is number => n != null);
  if (summable.length === 0) return null;
  return roundMoney(summable.reduce((a, b) => a + b, 0));
}

/** One line for the alert: who, and what little we know. */
export function receiptAlertBody(input: {
  uploaderName: string;
  draft: ReceiptDraft | null;
}): string {
  const total = input.draft ? receiptTotal(input.draft) : null;
  const bits: string[] = [];
  if (input.draft?.supplier) bits.push(input.draft.supplier);
  if (total != null) bits.push(`$${total.toFixed(2)}`);
  return bits.length > 0
    ? `${input.uploaderName} uploaded a receipt — ${bits.join(", ")}. Check it and approve it.`
    : `${input.uploaderName} uploaded a receipt. It could not be read automatically — open it, enter what was bought and approve it.`;
}

/* ------------------------------------------------------------------ */
/* Approval                                                            */
/* ------------------------------------------------------------------ */

/**
 * Where a receipt is, in the words the uploader cares about.
 *
 * `uploaded` and `unreadable` are both "waiting for an approver" — the
 * difference is only whether the AI managed a draft. `reviewed` is the word
 * the first version used for a receipt confirmed into spending; the migration
 * renames those rows to `approved`, and a database that has not had it yet
 * still says `reviewed`, so it reads as approved here rather than as pending.
 */
export type ReceiptStage = "pending" | "approved" | "rejected";

export function receiptStage(status: string | null | undefined): ReceiptStage {
  if (status === "approved" || status === "reviewed") return "approved";
  if (status === "rejected") return "rejected";
  return "pending";
}

export const RECEIPT_STAGE_LABEL: Record<ReceiptStage, string> = {
  pending: "Awaiting approval",
  approved: "Approved",
  rejected: "Not approved",
};

/** Same tints as an expense request, so a status reads the same everywhere. */
export const RECEIPT_STAGE_TONE: Record<ReceiptStage, string> = {
  pending: TONE.warning,
  approved: TONE.success,
  rejected: TONE.danger,
};

/**
 * The roles that can approve a receipt somewhere: can_view_finance's list
 * plus the managing roles can_manage_location accepts. Only decides whether
 * the "To approve" tab is worth showing — which receipts a person may approve
 * is the database's answer, see `receiptDecision`.
 */
export const RECEIPT_APPROVER_ROLES: readonly AppRole[] = [
  ...FINANCE_ROLES,
  "office",
  "location_manager",
  "sales_manager",
  "regional",
];

export function isReceiptApprover(roles: readonly string[] | undefined): boolean {
  return (roles ?? []).some((r) => (RECEIPT_APPROVER_ROLES as readonly string[]).includes(r));
}

/**
 * May this person approve or reject this receipt?
 *
 * There is no role check here, deliberately. A receipt somebody else
 * uploaded is only visible at all to finance or a manager of its office —
 * that is the supply_receipts SELECT policy, and it is the same predicate
 * `approve_supply_receipt` checks — so being able to see another person's
 * receipt already means you have the authority. What is left is the rule the
 * approval exists for: never your own.
 */
export function receiptDecision(
  receipt: Pick<SupplyReceipt, "status" | "uploaded_by">,
  userId: string | null,
): { allowed: true } | { allowed: false; why: string } {
  const stage = receiptStage(receipt.status);
  if (stage !== "pending") return { allowed: false, why: RECEIPT_STAGE_LABEL[stage] };
  if (!userId) return { allowed: false, why: "Sign in to approve receipts." };
  if (receipt.uploaded_by === userId) {
    return {
      allowed: false,
      why: "You uploaded this receipt, so somebody else has to approve it.",
    };
  }
  return { allowed: true };
}

/** One line on the approver's form. Null is "not filled in yet". */
export type EditableLine = {
  label: string;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
};

export type ApprovalForm = {
  supplier: string;
  purchasedOn: string;
  lines: EditableLine[];
};

/** A line as `approve_supply_receipt` takes it. */
export type ApprovalLine = {
  label: string;
  quantity: number;
  unit_price: number;
  total: number | null;
};

const round2 = roundMoney;

export const BLANK_LINE: EditableLine = { label: "", quantity: 1, unitPrice: null, total: null };

/**
 * The approver's starting point: the AI's draft, filled in where it can be
 * worked out and left empty where it cannot.
 *
 * A till prints "2 @ 19.99 ... 39.98" often enough that a missing unit price
 * is usually the line total over the quantity, so that is offered. A missing
 * quantity is 1, which is what a receipt line without one means. Nothing else
 * is invented — the date falls back to `today` only because a purchase needs
 * one and the approver is looking straight at the photo to correct it.
 */
export function approvalFormFrom(draft: ReceiptDraft | null, today: string): ApprovalForm {
  const lines = (draft?.lines ?? []).map((l): EditableLine => {
    const quantity = l.quantity != null && l.quantity > 0 ? l.quantity : 1;
    const unitPrice = l.unitPrice ?? (l.total != null ? round2(l.total / quantity) : null);
    return { label: l.label, quantity, unitPrice, total: l.total };
  });
  return {
    supplier: draft?.supplier ?? "",
    purchasedOn: draft?.purchasedOn ?? today,
    lines: lines.length > 0 ? lines : [{ ...BLANK_LINE }],
  };
}

/** What a line comes to: its own total, else quantity × unit price. */
export function lineAmount(line: EditableLine): number | null {
  if (line.total != null) return round2(line.total);
  if (line.quantity == null || line.unitPrice == null) return null;
  return round2(line.quantity * line.unitPrice);
}

export function approvalFormTotal(form: ApprovalForm): number {
  return round2(form.lines.reduce((sum, l) => sum + (lineAmount(l) ?? 0), 0));
}

const isBlank = (l: EditableLine) =>
  !l.label.trim() &&
  l.unitPrice == null &&
  l.total == null &&
  (l.quantity == null || l.quantity === 1);

const dayNumber = (iso: string) =>
  Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;

/**
 * The form, checked the way `approve_supply_receipt` will check it, so the
 * approver hears about a missing price here rather than as a database error.
 * The server is still the judge; this only saves a round trip.
 *
 * `today` is passed in, never read from the clock, so a test pinned to a date
 * stays pinned. An untouched spare line is dropped rather than refused — the
 * "Add line" button leaves one behind more often than not.
 */
export function validateApprovalForm(
  form: ApprovalForm,
  today: string,
):
  | { ok: true; supplier: string; purchasedOn: string; lines: ApprovalLine[] }
  | { ok: false; error: string } {
  const supplier = form.supplier.trim();
  if (!supplier) return { ok: false, error: "Say which supplier this receipt is from." };

  const purchasedOn = receiptDate(form.purchasedOn);
  if (!purchasedOn) return { ok: false, error: "Say what day this was bought." };
  const age = dayNumber(today) - dayNumber(purchasedOn);
  if (age < -1 || age > 730) {
    return { ok: false, error: `The purchase date ${purchasedOn} does not look right.` };
  }

  const kept = form.lines.filter((l) => !isBlank(l));
  if (kept.length === 0) {
    return { ok: false, error: "A receipt needs at least one line to approve." };
  }
  if (kept.length > 60) return { ok: false, error: "A receipt can carry at most 60 lines." };

  const lines: ApprovalLine[] = [];
  for (const l of kept) {
    const label = l.label.trim();
    if (!label) return { ok: false, error: "Every line needs a description." };
    if (l.quantity == null || l.unitPrice == null) {
      return { ok: false, error: `"${label}" needs a quantity and a unit price.` };
    }
    if (l.quantity <= 0 || l.unitPrice < 0 || (l.total != null && l.total < 0)) {
      return { ok: false, error: `"${label}" has a quantity or price that is not possible.` };
    }
    lines.push({
      label: label.slice(0, 200),
      quantity: round2(l.quantity),
      unit_price: round2(l.unitPrice),
      total: l.total == null ? null : round2(l.total),
    });
  }
  return { ok: true, supplier, purchasedOn, lines };
}

/** What the approve button says until 20261005173000 is applied. */
export const RECEIPT_APPROVAL_PENDING =
  "Approving receipts switches on once the database update for receipt approval is applied. The receipt is saved and waiting.";

/**
 * The approval functions raise sentences written for the person at the
 * screen ("You uploaded this receipt, so somebody else has to approve it"),
 * so those are shown as they are. Anything else gets the generic treatment.
 */
export function receiptDecisionErrorText(err: unknown, action: string): string {
  const e = err as { code?: string; message?: string } | null;
  if (e?.message && ["42501", "55000", "22023", "P0002"].includes(e.code ?? "")) {
    return e.message;
  }
  if (err instanceof Error && !("code" in err)) return err.message;
  return describeDbError(err, { action });
}

/* ------------------------------------------------------------------ */
/* Reads and writes                                                    */
/* ------------------------------------------------------------------ */

/** Who to alert. Null means "nobody named yet" — the caller falls back. */
export async function receiptReviewerId(): Promise<string | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", RECEIPT_REVIEWER_KEY)
    .maybeSingle();
  if (error) return null;
  const v = (data?.value ?? {}) as { user_id?: string | null };
  return v.user_id?.trim() || null;
}

export async function setReceiptReviewer(userId: string | null): Promise<void> {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: RECEIPT_REVIEWER_KEY, value: { user_id: userId } }, { onConflict: "key" });
  if (error) throw error;
}

const RECEIPT_COLUMNS =
  "id, location_id, job_id, uploaded_by, storage_bucket, storage_path, parsed, status, note, created_at, reviewed_by, reviewed_at";
/*
 * Columns newer than the table, oldest first: `request_id` arrives with
 * 20260925132000 and the approval columns with 20261005173000, each applied by
 * hand after merge. PostgREST fails a whole read on an unknown column, so the
 * read steps down a tier and stays down for the session rather than emptying
 * the Receipts card — a crew member's list of their own receipts keeps working
 * on a database that has not caught up.
 */
const RECEIPT_COLUMN_TIERS = [
  `${RECEIPT_COLUMNS}, request_id, rejection_reason, approved_lines`,
  `${RECEIPT_COLUMNS}, request_id`,
  RECEIPT_COLUMNS,
] as const;
let receiptTier = 0;
const receiptsHaveRequest = () => receiptTier < 2;

/**
 * Receipts, newest first. RLS decides whose: your own, plus — for finance or a
 * manager — everybody's in the offices you approve for.
 *
 *   locationId   one office's (null for every office you can see)
 *   requestIds   the ones attached to these orders
 *   uploadedBy   one person's — "My receipts"
 *   pending      only the ones still waiting for an approver
 */
export async function listSupplyReceipts(
  locationId: string | null,
  opts: { requestIds?: readonly string[]; uploadedBy?: string; pending?: boolean } = {},
): Promise<SupplyReceipt[]> {
  if (opts.requestIds && opts.requestIds.length === 0) return [];
  const run = () => {
    let q = supabase
      .from("supply_receipts" as never)
      .select(RECEIPT_COLUMN_TIERS[receiptTier])
      .order("created_at", { ascending: false })
      .limit(200);
    if (locationId) q = q.eq("location_id", locationId);
    if (opts.requestIds) q = q.in("request_id", [...opts.requestIds]);
    if (opts.uploadedBy) q = q.eq("uploaded_by", opts.uploadedBy);
    if (opts.pending) q = q.in("status", ["uploaded", "unreadable"]);
    return q;
  };
  let { data, error } = await run();
  while (error && receiptTier < RECEIPT_COLUMN_TIERS.length - 1 && isMissingSchema(error)) {
    receiptTier += 1;
    // Nothing can be attached to an order before the column exists.
    if (opts.requestIds && !receiptsHaveRequest()) return [];
    ({ data, error } = await run());
  }
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []) as unknown as SupplyReceipt[];
}

/**
 * Has 20261005173000 been applied here? Asked once by the approval screens so
 * they can say "approvals switch on after the update" up front, instead of
 * letting an approver correct six lines and then fail on the button.
 */
export async function receiptApprovalAvailable(): Promise<boolean> {
  const { error } = await supabase
    .from("supply_receipts" as never)
    .select("rejection_reason")
    .limit(1);
  return !(error && isMissingSchema(error));
}

/**
 * Approve a receipt into purchase tracking, with the lines the APPROVER
 * confirmed. One call, one transaction, entirely the database's decision —
 * see approve_supply_receipt in 20261005173000. There is deliberately no
 * fallback to writing supply_purchases from here: that direct write was the
 * hole this closes, and a database without the function gets a sentence
 * saying so rather than the old ungated path.
 */
export async function approveReceipt(input: {
  receiptId: string;
  supplier: string;
  purchasedOn: string;
  lines: ApprovalLine[];
}): Promise<number> {
  const { data, error } = await supabase.rpc(
    "approve_supply_receipt" as never,
    {
      _receipt_id: input.receiptId,
      _supplier: input.supplier,
      _purchased_on: input.purchasedOn,
      _lines: input.lines,
    } as never,
  );
  if (error) {
    if (isMissingSchema(error)) throw new Error(RECEIPT_APPROVAL_PENDING);
    throw error;
  }
  return Number(data ?? 0);
}

/** Say no, and why. The uploader sees the reason on their receipt. */
export async function rejectReceipt(receiptId: string, reason: string): Promise<void> {
  const { error } = await supabase.rpc(
    "reject_supply_receipt" as never,
    {
      _receipt_id: receiptId,
      _reason: reason,
    } as never,
  );
  if (error) {
    if (isMissingSchema(error)) throw new Error(RECEIPT_APPROVAL_PENDING);
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

/**
 * Store the picture, record the receipt, and tell somebody — in that order.
 *
 * The ORDER is the whole point of David's ask: "at the very minimum it should
 * send an alert to somebody... that a receipt was uploaded by so-and-so." So
 * the alert does not wait on, and is not conditional on, the model reading a
 * word. By the time any parsing is attempted the picture is in storage, the
 * row exists, and the reviewer has been told.
 *
 * The alert is best effort in the same sense every other notification here is:
 * a failed ping never costs the receipt.
 */
export async function uploadSupplyReceipt(input: {
  file: Blob;
  locationId: string;
  jobId: string | null;
  /** The order this receipt is for, when it is attached from the order itself. */
  requestId?: string | null;
  userId: string;
  uploaderName: string;
  note?: string | null;
}): Promise<SupplyReceipt> {
  const { resizeToWebp } = await import("@/lib/photos");
  const { DOCUMENT_BUCKET } = await import("@/lib/documents");

  // Downscaled before it leaves the phone: a till receipt is long and thin and
  // a 12-megapixel photograph of one is all paper texture.
  const variant = await resizeToWebp(input.file, RECEIPT_MAX_EDGE, RECEIPT_QUALITY);
  const path = `supply-receipts/${input.locationId}/${crypto.randomUUID()}.webp`;

  const up = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(path, variant.blob, { contentType: "image/webp", upsert: false });
  if (up.error) throw up.error;

  const { data, error } = await supabase
    .from("supply_receipts" as never)
    .insert({
      location_id: input.locationId,
      job_id: input.jobId,
      uploaded_by: input.userId,
      storage_bucket: DOCUMENT_BUCKET,
      storage_path: path,
      status: "uploaded",
      note: input.note?.trim() || null,
      // Only sent when there is an order, so a plain Spending upload works on a
      // database that has not had 20260925132000 yet.
      ...(input.requestId ? { request_id: input.requestId } : {}),
    } as never)
    .select(input.requestId ? `${RECEIPT_COLUMNS}, request_id` : RECEIPT_COLUMNS)
    .single();
  if (error) {
    if (input.requestId && isMissingSchema(error)) {
      throw new Error(
        "Receipts cannot be attached to an order until the database update is applied. Upload it under Spending for now.",
      );
    }
    throw error;
  }

  await alertReceiptReviewer({
    receiptId: (data as unknown as SupplyReceipt).id,
    locationId: input.locationId,
    uploaderId: input.userId,
    uploaderName: input.uploaderName,
    draft: null,
  });

  return data as unknown as SupplyReceipt;
}

/** 1600px keeps the small print legible without carrying the paper grain. */
export const RECEIPT_MAX_EDGE = 1600;
export const RECEIPT_QUALITY = 0.82;

/**
 * Tell the named reviewer, or the office's managers when nobody is named.
 *
 * David said the recipient was "to be determined", so it is a setting. An
 * unset setting must not mean silence — the alert is the minimum he asked for
 * — so it falls back to the people who already approve supply orders.
 */
export async function alertReceiptReviewer(input: {
  receiptId: string;
  locationId: string;
  uploaderId: string;
  uploaderName: string;
  draft: ReceiptDraft | null;
}): Promise<void> {
  try {
    const { notifyUsers } = await import("@/lib/notifications.functions");
    const named = await receiptReviewerId();
    let userIds = named ? [named] : [];

    if (userIds.length === 0) {
      const { data } = await supabase
        .from("location_members")
        .select("user_id")
        .eq("location_id", input.locationId)
        .eq("role", "manager");
      userIds = (data ?? []).map((m) => m.user_id);
    }
    userIds = userIds.filter((id) => id !== input.uploaderId);
    if (userIds.length === 0) return;

    await notifyUsers({
      data: {
        userIds,
        /*
         * Reuses the supplies notification type rather than adding an enum
         * value. A new one cannot be used in the transaction that adds it —
         * the reason the payment receipt template went a month unseeded — and
         * a receipt is supplies money either way.
         */
        type: "supply_status",
        title: "Receipt uploaded",
        body: receiptAlertBody({ uploaderName: input.uploaderName, draft: input.draft }),
        entityType: "supply_receipt",
        entityId: input.receiptId,
        // The approval queue, not the Spending tab — the receipt is waiting on
        // a decision, and /receipts is where decisions are made.
        href: "/receipts",
      },
    });
  } catch (err) {
    console.error("[supplies] receipt alert failed", err);
  }
}

/**
 * Store what the model made of it, for an approver to correct.
 *
 * Through `save_supply_receipt_draft`, because the uploader's phone does the
 * read and the uploader has no UPDATE on the table. Before 20261005173000 the
 * only update policy was the managers' one, so a crew member's draft matched
 * no row and vanished without an error — their receipt then sat with no lines
 * for anybody to confirm. The direct update is kept only as the fallback for a
 * database without the function, where it still works for a manager.
 */
export async function saveReceiptDraft(id: string, draft: ReceiptDraft | null): Promise<void> {
  const { error } = await supabase.rpc(
    "save_supply_receipt_draft" as never,
    {
      _receipt_id: id,
      _parsed: draft,
    } as never,
  );
  if (!error) return;
  if (!isMissingSchema(error)) throw error;
  const legacy = await supabase
    .from("supply_receipts" as never)
    .update({ parsed: draft, status: draft ? "uploaded" : "unreadable" } as never)
    .eq("id", id);
  if (legacy.error && !isMissingSchema(legacy.error)) throw legacy.error;
}
