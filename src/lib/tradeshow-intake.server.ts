/**
 * What a booth form submission becomes, server side.
 *
 * A standalone intake form is a claim by a stranger and waits for triage. A
 * form filled in at the booth is different: the person is standing in front
 * of a rep, on the rep's tablet or scanning the rep's QR, and the tablet
 * capture next to it creates the account without asking anyone. So does
 * this — the same rows, the same fields (`tradeshow_id`, the Tradeshow lead
 * source, the show as source detail, a primary contact, a first touchpoint)
 * — with the account remembered on the submission so the inbox and the show
 * page can point at it. The submission itself still lands in the inbox for
 * the office to turn into a job or dismiss.
 *
 * Runs with the admin client because the public form has no user. Nothing
 * here throws past the caller on purpose: the submission is already saved,
 * and a lead that reached the inbox without an account is a lead, not a loss.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { findTradeshowLeadSourceId } from "@/lib/tradeshow-lead-source";

type Db = SupabaseClient<Database>;

export type BoothRequest = {
  id: string;
  tradeshow_id: string;
  location_id: string | null;
  created_by: string | null;
  label: string | null;
};

const trimmed = (v: string | null | undefined) => (v ?? "").trim();

/** A booth form needs someone to call and a way to call them. */
export function boothSubmissionProblem(fields: Record<string, string | null>): string | null {
  const who = trimmed(fields["customer_name"]) || trimmed(fields["company"]);
  const how = trimmed(fields["customer_phone"]) || trimmed(fields["customer_email"]);
  if (!who) return "Please give us your name or your company.";
  if (!how) return "Please give a phone number or an email address so we can reach you.";
  return null;
}

/**
 * Create the show-attributed account for a booth submission. Returns the
 * account id, or null when there was nowhere to file it (no office on the
 * link or the show) — the submission stays in the inbox either way.
 */
export async function fileBoothSubmission(
  db: Db,
  input: {
    request: BoothRequest;
    submissionId: string;
    fields: Record<string, string | null>;
    submittedAt: string;
  },
): Promise<string | null> {
  const { request, fields } = input;
  const { data: show } = await db
    .from("tradeshows")
    .select("name, location_id")
    .eq("id", request.tradeshow_id)
    .maybeSingle();
  if (!show) return null;
  const locationId = request.location_id ?? show.location_id;
  if (!locationId) return null;

  const name = trimmed(fields["customer_name"]);
  const company = trimmed(fields["company"]);
  const phone = trimmed(fields["customer_phone"]) || null;
  const email = trimmed(fields["customer_email"]) || null;
  const notes = trimmed(fields["notes"]);
  const accountName = company || name;
  if (!accountName) return null;

  const { data: sources } = await db
    .from("option_list_values")
    .select("id, key, label, option_lists!inner(key)")
    .eq("option_lists.key", "lead_source")
    .eq("active", true);
  const leadSourceId = findTradeshowLeadSourceId(
    (sources ?? []) as { id: string; key: string; label: string }[],
  );

  const via = `Submitted through the ${request.label || show.name} form`;
  const { data: account, error: accErr } = await db
    .from("accounts")
    .insert({
      name: accountName,
      location_id: locationId,
      tradeshow_id: request.tradeshow_id,
      lead_source_id: leadSourceId,
      lead_source_detail: show.name,
      assigned_rep: request.created_by,
      created_by: request.created_by,
      created_at: input.submittedAt,
      phone,
      email,
      notes: [via, notes].filter(Boolean).join("\n"),
    })
    .select("id")
    .single();
  if (accErr || !account) throw accErr ?? new Error("No account row returned");

  let contactId: string | null = null;
  if (name) {
    const { data: contact } = await db
      .from("contacts")
      .insert({
        account_id: account.id,
        location_id: locationId,
        full_name: name,
        phone,
        email,
        is_primary: true,
        created_by: request.created_by,
        created_at: input.submittedAt,
      })
      .select("id")
      .single();
    contactId = contact?.id ?? null;
  }

  // The booth is the first touchpoint, filed as the person's own words.
  await db.from("touchpoints").insert({
    account_id: account.id,
    contact_id: contactId,
    type: "meeting_in_person",
    direction: "inbound",
    occurred_at: input.submittedAt,
    meeting_held: true,
    is_self_reported: true,
    capture_source: "manual",
    // The client filled the form in themselves: that is the proof a hand-
    // logged touch needs to count (20261110190000), and only the server may
    // say so.
    proof_kind: "form",
    notes: [`Filled in the ${show.name} form`, notes].filter(Boolean).join("\n"),
    created_by: request.created_by,
  });

  await db
    .from("intake_submissions")
    .update({ account_id: account.id })
    .eq("id", input.submissionId);

  return account.id;
}
