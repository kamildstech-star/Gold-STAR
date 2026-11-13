import { supabase } from "@/integrations/supabase/client";
import type { GiftCampaignStatus, GiftDeliveryStatus, GiftOccasion } from "@/lib/lifecycle";

/**
 * Gifts are a farming motion, not a module. Everything here is shared by the
 * Farming → Campaigns view, the account record and the admin catalog, so the
 * gift-policy guard has exactly one implementation.
 */

import { fetchGiftPolicies, type GiftPolicy } from "@/lib/gift-policy";
export type { GiftPolicy };

export type CatalogItem = {
  id: string;
  name: string;
  description: string | null;
  unit_cost_cents: number;
  active: boolean;
};

export type Campaign = {
  id: string;
  name: string;
  occasion: GiftOccasion;
  status: GiftCampaignStatus;
  target_month: number | null;
  target_year: number | null;
  notes: string | null;
  catalog_item_id: string | null;
  location_id: string | null;
  created_at: string;
};

export type GiftSendRow = {
  id: string;
  sent_at: string;
  cost_cents: number;
  delivery_status: GiftDeliveryStatus;
  tracking_ref: string | null;
  campaign_id: string | null;
  account: { id: string; name: string } | null;
  contact: { id: string; full_name: string } | null;
};

/** A candidate for a campaign, already judged against the contact's policy. */
export type Candidate = {
  contactId: string;
  contactName: string;
  accountId: string;
  accountName: string;
  policy: GiftPolicy;
  birthdayMonth: number | null;
  birthdayDay: number | null;
  /** Eligible to send. False when the policy forbids it. */
  eligible: boolean;
  /** Needs a written pre-approval before the send goes out. */
  needsApproval: boolean;
  /** Plain-English reason shown to the user when not eligible. */
  excludedReason: string | null;
};

export function birthdayLabel(month: number | null, day: number | null): string | null {
  if (!month) return null;
  const m = new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "short" });
  return day ? `${m} ${day}` : m;
}

export async function listCatalog(includeInactive = true): Promise<CatalogItem[]> {
  let q = supabase
    .from("gift_catalog")
    .select("id, name, description, unit_cost_cents, active")
    .order("name");
  if (!includeInactive) q = q.eq("active", true);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as CatalogItem[];
}

export async function listCampaigns(): Promise<Campaign[]> {
  const { data, error } = await supabase
    .from("gift_campaigns")
    .select(
      "id, name, occasion, status, target_month, target_year, notes, catalog_item_id, location_id, created_at",
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as Campaign[];
}

export async function listSends(campaignId?: string): Promise<GiftSendRow[]> {
  let q = supabase
    .from("gift_sends")
    .select(
      "id, sent_at, cost_cents, delivery_status, tracking_ref, campaign_id, account:account_id(id, name), contact:contact_id(id, full_name)",
    )
    .order("sent_at", { ascending: false })
    .limit(300);
  if (campaignId) q = q.eq("campaign_id", campaignId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as GiftSendRow[];
}

/**
 * Build the recipient list for a batch.
 *
 * The exclusion is the point of the feature: a contact whose employer forbids
 * gifts is never a recipient, and the reason is carried through so the list
 * shows who was dropped and why rather than silently shrinking. People have
 * been fired for accepting a vendor gift.
 */
export async function buildCandidates(opts: {
  /** Birthday month to batch on. Null = every contact on farmed accounts. */
  month: number | null;
  locationId: string | null;
}): Promise<Candidate[]> {
  let accountQ = supabase.from("accounts").select("id, name, location_id").is("archived_at", null);
  if (opts.locationId) accountQ = accountQ.eq("location_id", opts.locationId);
  const { data: accounts, error: accErr } = await accountQ.limit(2000);
  if (accErr) throw accErr;
  const accById = new Map((accounts ?? []).map((a) => [a.id as string, a.name as string]));
  if (accById.size === 0) return [];

  let contactQ = supabase
    .from("contacts")
    .select("id, full_name, account_id, birthday_month, birthday_day")
    .in("account_id", [...accById.keys()])
    .is("archived_at", null)
    .order("full_name");
  if (opts.month) contactQ = contactQ.eq("birthday_month", opts.month);
  const { data: contacts, error: cErr } = await contactQ.limit(4000);
  if (cErr) throw cErr;

  const policies = await fetchGiftPolicies((contacts ?? []).map((c) => c.id as string));

  return (contacts ?? []).map((c) => {
    const policy = policies.get(c.id as string) ?? "unknown";
    const prohibited = policy === "prohibited";
    return {
      contactId: c.id as string,
      contactName: c.full_name as string,
      accountId: c.account_id as string,
      accountName: accById.get(c.account_id as string) ?? "—",
      policy,
      birthdayMonth: c.birthday_month,
      birthdayDay: c.birthday_day,
      eligible: !prohibited,
      needsApproval: policy === "approval_required",
      excludedReason: prohibited ? "Employer prohibits gifts — tagged NO GIFTS" : null,
    } satisfies Candidate;
  });
}

/**
 * Persist a campaign's recipient list. Excluded contacts are written too, with
 * their reason, so the campaign keeps an auditable record of who was dropped.
 */
export async function saveRecipients(campaignId: string, candidates: Candidate[]) {
  const { error: delErr } = await supabase
    .from("gift_campaign_recipients")
    .delete()
    .eq("campaign_id", campaignId);
  if (delErr) throw delErr;
  if (candidates.length === 0) return;
  const { error } = await supabase.from("gift_campaign_recipients").insert(
    candidates.map((c) => ({
      campaign_id: campaignId,
      account_id: c.accountId,
      contact_id: c.contactId,
      approved: c.eligible && !c.needsApproval,
      excluded_reason: c.excludedReason,
    })),
  );
  if (error) throw error;
}

export type StoredRecipient = {
  id: string;
  account_id: string;
  contact_id: string;
  approved: boolean;
  excluded_reason: string | null;
  account: { name: string } | null;
  contact: { full_name: string } | null;
};

export async function listRecipients(campaignId: string): Promise<StoredRecipient[]> {
  const { data, error } = await supabase
    .from("gift_campaign_recipients")
    .select(
      "id, account_id, contact_id, approved, excluded_reason, account:account_id(name), contact:contact_id(full_name)",
    )
    .eq("campaign_id", campaignId)
    .limit(2000);
  if (error) throw error;
  return (data ?? []) as unknown as StoredRecipient[];
}

/**
 * Record a gift going out. Every send also writes a touchpoint so the gift
 * counts toward the quarterly cadence — that link is why gifts belong in
 * Farming rather than in a module of their own.
 */
export async function recordSend(opts: {
  accountId: string;
  contactId: string | null;
  campaignId: string | null;
  catalogItemId: string | null;
  costCents: number;
  userId: string | null;
  occasion?: GiftOccasion;
  notes?: string | null;
}) {
  const { error } = await supabase.from("gift_sends").insert({
    account_id: opts.accountId,
    contact_id: opts.contactId,
    campaign_id: opts.campaignId,
    catalog_item_id: opts.catalogItemId,
    cost_cents: opts.costCents,
    created_by: opts.userId,
    notes: opts.notes ?? null,
    delivery_status: "sent",
  });
  if (error) throw error;

  const { error: tErr } = await supabase.from("touchpoints").insert({
    account_id: opts.accountId,
    contact_id: opts.contactId,
    type: opts.occasion === "seasonal" ? "seasonal_send" : "gift",
    notes: opts.notes ?? null,
    created_by: opts.userId,
    capture_source: "gift_engine",
    direction: "outbound",
  });
  if (tErr) throw tErr;
}

/** Send every eligible recipient of a campaign and mark the campaign sent. */
export async function sendCampaign(campaign: Campaign, userId: string | null) {
  const recipients = await listRecipients(campaign.id);
  // Both gates, not just one: the campaign screen shows unapproved recipients
  // as "Hold for approval", and sending to them anyway is how someone's
  // champion gets a gift their employer forbids.
  const eligible = recipients.filter((r) => !r.excluded_reason && r.approved);
  let unitCost = 0;
  if (campaign.catalog_item_id) {
    const { data } = await supabase
      .from("gift_catalog")
      .select("unit_cost_cents")
      .eq("id", campaign.catalog_item_id)
      .maybeSingle();
    unitCost = data?.unit_cost_cents ?? 0;
  }
  for (const r of eligible) {
    await recordSend({
      accountId: r.account_id,
      contactId: r.contact_id,
      campaignId: campaign.id,
      catalogItemId: campaign.catalog_item_id,
      costCents: unitCost,
      userId,
      occasion: campaign.occasion,
      notes: `Campaign: ${campaign.name}`,
    });
  }
  const { error } = await supabase
    .from("gift_campaigns")
    .update({ status: "sent" })
    .eq("id", campaign.id);
  if (error) throw error;
  return eligible.length;
}

/** Year-to-date relationship upkeep spend on one account, in cents. */
export async function ytdUpkeepCents(accountId: string): Promise<number> {
  const jan1 = new Date(new Date().getFullYear(), 0, 1).toISOString();
  const { data, error } = await supabase
    .from("gift_sends")
    .select("cost_cents")
    .eq("account_id", accountId)
    .gte("sent_at", jan1)
    .limit(1000);
  if (error) throw error;
  return (data ?? []).reduce((sum, r) => sum + (r.cost_cents ?? 0), 0);
}
