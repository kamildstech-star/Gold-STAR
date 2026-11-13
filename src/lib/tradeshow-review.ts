/**
 * The post-show review pass.
 *
 * Mark works a show by talking: card photo, voice note, next person. That is
 * the fast half. This is the other half — sitting down afterwards with a
 * laptop, playing each recording back, reading each card and typing the lead
 * up once. A capture is `needs_review` from the moment it is taken until
 * somebody saves details against it; then it is an ordinary lead.
 *
 * Two rules shape everything here:
 *
 *  - Nothing is ever deleted, and nothing silently disappears. An unreviewed
 *    capture stays in the queue indefinitely and counts on the show's lead
 *    total the whole time, flagged, so a forgotten note is visible rather than
 *    lost. Skipping one moves past it; it does not remove it.
 *  - The database may not have caught up. `tradeshow_lead_captures` is newer
 *    than the rest of the show page, so every read of it falls back to "no
 *    queue available" rather than taking the page down — the leads themselves
 *    are ordinary accounts and do not depend on it.
 *
 * The ordering, progress and next-up logic are pure functions at the bottom of
 * the file so they can be tested without a database or a browser.
 */
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { parseBadgePayload } from "@/lib/badge-payload";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { LeadMedia } from "@/lib/tradeshow-capture";
import type { ShowAccount } from "@/lib/tradeshows";

export type CaptureStateRow = Database["public"]["Tables"]["tradeshow_lead_captures"]["Row"];

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Capture states for one show. `available: false` means the migration has not
 * been applied here — the caller hides the queue and says so, rather than
 * pretending every lead has been reviewed.
 */
export async function fetchCaptureStates(
  tradeshowId: string,
): Promise<{ rows: CaptureStateRow[]; available: boolean }> {
  const { data, error } = await supabase
    .from("tradeshow_lead_captures")
    .select("*")
    .eq("tradeshow_id", tradeshowId)
    .order("captured_at", { ascending: true })
    .limit(2000);
  if (error) {
    if (isMissingSchema(error)) return { rows: [], available: false };
    throw error;
  }
  return { rows: (data ?? []) as CaptureStateRow[], available: true };
}

/**
 * Capture states for a show, as a query. Deliberately not folded into
 * `fetchTradeshowDetail`: this table is newer than the rest of the show page,
 * and a database without it should cost the review queue, not the show.
 */
export function useCaptureStates(tradeshowId: string) {
  return useQuery({
    queryKey: ["tradeshow-capture-states", tradeshowId],
    queryFn: () => fetchCaptureStates(tradeshowId),
  });
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export type ReviewFields = {
  name: string;
  company: string;
  phone: string;
  email: string;
  notes: string;
  /** An option-list value id, or null to leave the source as captured. */
  leadSourceId: string | null;
};

export const EMPTY_REVIEW_FIELDS: ReviewFields = {
  name: "",
  company: "",
  phone: "",
  email: "",
  notes: "",
  leadSourceId: null,
};

/**
 * What the review pass needs before it will save: somebody to call the lead.
 *
 * Deliberately looser than the booth form's rule, which also demands a phone
 * or an email. A voice note that says "Mark from Falcon Marketing, does trade
 * show booths, no card" is worth keeping under that name; refusing it would
 * either lose the lead or teach him to type a fake number.
 */
export function validateReviewFields(f: ReviewFields): string | null {
  if (!f.name.trim() && !f.company.trim()) return "Add a name or a company.";
  const email = f.email.trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That email does not look right.";
  return null;
}

/**
 * Write a reviewed capture up: the account gets its real name and contact
 * details, a contact row is created or updated when a person was named, and
 * the capture stops being unreviewed.
 *
 * The account update goes through ordinary RLS — the capturing rep is the
 * assigned rep, and a manager over the office can do it too — so no privileged
 * function is needed for the review half.
 */
export async function saveReviewedCapture(input: {
  accountId: string;
  locationId: string;
  userId: string;
  fields: ReviewFields;
  /** Existing contact on the account, when there is one to update. */
  contactId?: string | null;
}): Promise<void> {
  const f = input.fields;
  const name = f.company.trim() || f.name.trim();
  const phone = f.phone.trim() || null;
  const email = f.email.trim() || null;

  const patch: Record<string, unknown> = {
    name,
    phone,
    email,
    notes: f.notes.trim() || null,
  };
  if (f.leadSourceId) patch.lead_source_id = f.leadSourceId;

  const { error: accErr } = await supabase
    .from("accounts")
    .update(patch as never)
    .eq("id", input.accountId);
  if (accErr) throw accErr;

  if (f.name.trim()) {
    const row = {
      id: input.contactId ?? crypto.randomUUID(),
      account_id: input.accountId,
      location_id: input.locationId,
      full_name: f.name.trim(),
      phone,
      email,
      is_primary: true,
      created_by: input.userId,
    };
    const { error } = await supabase.from("contacts").upsert(row as never, { onConflict: "id" });
    if (error) throw error;
  }

  // Last, so a failure above leaves the capture in the queue rather than
  // marking it done with nothing written.
  const { error: capErr } = await supabase
    .from("tradeshow_lead_captures")
    .update({
      needs_review: false,
      reviewed_at: new Date().toISOString(),
      reviewed_by: input.userId,
    } as never)
    .eq("account_id", input.accountId);
  if (capErr && !isMissingSchema(capErr)) throw capErr;
}

/* ------------------------------------------------------------------ */
/* Pure: building the queue, ordering it, and counting it              */
/* ------------------------------------------------------------------ */

export type ReviewEntry = {
  accountId: string;
  accountName: string;
  /** True while nobody has written this capture up. */
  needsReview: boolean;
  capturedAt: string;
  badgeRaw: string | null;
  audio: LeadMedia | null;
  photo: LeadMedia | null;
  badgePhoto: LeadMedia | null;
  /** Existing primary contact, updated rather than duplicated on save. */
  contactId: string | null;
  /** Whatever is on the account already, so review starts from it. */
  prefill: { name: string; company: string; phone: string; email: string; notes: string };
};

type MediaBucket = { photo: LeadMedia | null; audio: LeadMedia | null; badge: LeadMedia | null };

/**
 * Every capture on this show that still needs writing up, oldest first —
 * which is the order he met them in, and the order the notes make sense in.
 *
 * An account with a capture row but no recording still belongs here: the row
 * says a person was met and nothing was typed, and that is exactly the thing
 * that must not vanish.
 */
export function buildReviewQueue(input: {
  accounts: ShowAccount[];
  states: CaptureStateRow[];
  media: Map<string, MediaBucket>;
  contactNames?: Map<string, string>;
}): ReviewEntry[] {
  const byAccount = new Map(input.states.map((s) => [s.account_id, s]));
  const out: ReviewEntry[] = [];
  for (const a of input.accounts) {
    const state = byAccount.get(a.id);
    if (!state) continue;
    const bucket = input.media.get(a.id);
    // A badge that decoded to a contact card fills whatever the account is
    // still missing, so the reviewer confirms rather than retypes. An opaque
    // badge fills nothing: an attendee id is not a name.
    const badge = parseBadgePayload(state.badge_raw ?? "").fields;
    const contactName = input.contactNames?.get(a.id) ?? a.contact_name ?? "";
    const company = isPlaceholderName(a.name) || a.name.trim() === contactName.trim() ? "" : a.name;
    out.push({
      accountId: a.id,
      accountName: a.name,
      needsReview: state.needs_review,
      capturedAt: state.captured_at || a.created_at,
      badgeRaw: state.badge_raw?.trim() ? state.badge_raw.trim() : null,
      audio: bucket?.audio ?? null,
      photo: bucket?.photo ?? null,
      badgePhoto: bucket?.badge ?? null,
      contactId: a.contact_id,
      // A placeholder name is not a company; it is the absence of one. Nor
      // is the person's own name: a booth capture typed with "Dana" and no
      // company is an account called Dana, and offering that back as the
      // company would have the reviewer file her under herself.
      prefill: {
        name: contactName || badge?.name || "",
        company: company || badge?.company || "",
        phone: a.phone || badge?.phone || "",
        email: a.email || badge?.email || "",
        notes: "",
      },
    });
  }
  return out.sort(byCapturedAtThenId);
}

/** Oldest first; the account id breaks a tie so the order never wobbles. */
function byCapturedAtThenId(a: ReviewEntry, b: ReviewEntry): number {
  const ta = Date.parse(a.capturedAt);
  const tb = Date.parse(b.capturedAt);
  if (Number.isNaN(ta) && Number.isNaN(tb)) return a.accountId.localeCompare(b.accountId);
  if (Number.isNaN(ta)) return 1;
  if (Number.isNaN(tb)) return -1;
  if (ta !== tb) return ta - tb;
  return a.accountId.localeCompare(b.accountId);
}

/** Mirrors `capturePlaceholderName` in the capture module; kept pure and local. */
function isPlaceholderName(name: string): boolean {
  return /^(Voice note|Card photo)(\s·|$)/.test(name.trim());
}

export type ReviewProgress = {
  reviewed: number;
  total: number;
  remaining: number;
  /** "7 of 23 reviewed" — the sentence, so the caller does not rebuild it. */
  label: string;
};

export function reviewProgress(entries: ReviewEntry[]): ReviewProgress {
  const total = entries.length;
  const reviewed = entries.filter((e) => !e.needsReview).length;
  return {
    reviewed,
    total,
    remaining: total - reviewed,
    label: total === 0 ? "Nothing captured yet" : `${reviewed} of ${total} reviewed`,
  };
}

/**
 * The one to open next: the first unreviewed capture that has not been skipped
 * this sitting, starting after the one just finished. When everything left has
 * been skipped, it comes back round to the skipped ones rather than declaring
 * the queue empty — the whole point is that a skipped note is not a lost one.
 * Returns null only when nothing is unreviewed at all.
 */
export function pickNextForReview(
  entries: ReviewEntry[],
  opts: { after?: string | null; skipped?: ReadonlySet<string> } = {},
): ReviewEntry | null {
  const pending = entries.filter((e) => e.needsReview);
  if (pending.length === 0) return null;
  const skipped = opts.skipped ?? new Set<string>();

  const startAt = opts.after ? entries.findIndex((e) => e.accountId === opts.after) : -1;
  const ordered =
    startAt >= 0 ? [...entries.slice(startAt + 1), ...entries.slice(0, startAt + 1)] : entries;

  const fresh = ordered.find((e) => e.needsReview && !skipped.has(e.accountId));
  if (fresh) return fresh;
  // Everything left has been skipped once; offer the oldest of them again.
  return ordered.find((e) => e.needsReview) ?? null;
}

/** Ids of accounts still awaiting review, for flagging rows elsewhere on the page. */
export function unreviewedAccountIds(states: CaptureStateRow[]): Set<string> {
  return new Set(states.filter((s) => s.needs_review).map((s) => s.account_id));
}
