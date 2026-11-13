import { supabase } from "@/integrations/supabase/client";

/**
 * Gift policy now lives in the tag system rather than a column on the contact.
 * The exclusion behaviour is unchanged and non-negotiable: a contact tagged
 * NO GIFTS or OFF LIMITS is never a campaign recipient, and the reason is
 * carried through so the list shows who was dropped and why.
 */
export type GiftPolicy = "unknown" | "open" | "approval_required" | "prohibited";

export const NO_GIFTS_TAG = "NO GIFTS";
export const OFF_LIMITS_TAG = "OFF LIMITS";
export const GIFTS_OK_TAG = "GIFTS OK";
export const LEGAL_REVIEW_TAG = "LEGAL REVIEW";

/** Every tag this module owns — used when swapping one policy for another. */
export const GIFT_POLICY_TAGS = [NO_GIFTS_TAG, OFF_LIMITS_TAG, GIFTS_OK_TAG, LEGAL_REVIEW_TAG];

export const GIFT_POLICIES: GiftPolicy[] = ["unknown", "open", "approval_required", "prohibited"];

export const GIFT_POLICY_LABEL: Record<GiftPolicy, string> = {
  unknown: "Policy unknown",
  open: "Gifts allowed",
  approval_required: "Pre-approval required",
  prohibited: "Gifts prohibited",
};

export function policyFromTagNames(names: string[]): GiftPolicy {
  if (names.includes(NO_GIFTS_TAG) || names.includes(OFF_LIMITS_TAG)) return "prohibited";
  if (names.includes(LEGAL_REVIEW_TAG)) return "approval_required";
  if (names.includes(GIFTS_OK_TAG)) return "open";
  return "unknown";
}

function tagForPolicy(policy: GiftPolicy): string | null {
  if (policy === "prohibited") return NO_GIFTS_TAG;
  if (policy === "approval_required") return LEGAL_REVIEW_TAG;
  if (policy === "open") return GIFTS_OK_TAG;
  return null;
}

/** Resolve the effective gift policy for a batch of contacts, from their tags. */
export async function fetchGiftPolicies(contactIds: string[]): Promise<Map<string, GiftPolicy>> {
  const out = new Map<string, GiftPolicy>();
  if (contactIds.length === 0) return out;
  const { data, error } = await supabase
    .from("contact_tags")
    .select("contact_id, tag:tag_id(name)")
    .in("contact_id", contactIds);
  if (error) throw error;
  const names = new Map<string, string[]>();
  for (const row of (data ?? []) as Array<{
    contact_id: string;
    tag: { name: string } | null;
  }>) {
    if (!row.tag?.name) continue;
    const list = names.get(row.contact_id) ?? [];
    list.push(row.tag.name);
    names.set(row.contact_id, list);
  }
  for (const id of contactIds) out.set(id, policyFromTagNames(names.get(id) ?? []));
  return out;
}

export async function fetchGiftPolicy(contactId: string): Promise<GiftPolicy> {
  const map = await fetchGiftPolicies([contactId]);
  return map.get(contactId) ?? "unknown";
}

/** Apply a policy by swapping the contact's gift tags. */
export async function setGiftPolicyTag(contactId: string, policy: GiftPolicy) {
  const { data: tags, error: tagErr } = await supabase
    .from("tags")
    .select("id, name")
    .in("name", GIFT_POLICY_TAGS);
  if (tagErr) throw tagErr;
  const byName = new Map((tags ?? []).map((t) => [t.name as string, t.id as string]));
  const ids = [...byName.values()];
  if (ids.length) {
    const { error: delErr } = await supabase
      .from("contact_tags")
      .delete()
      .eq("contact_id", contactId)
      .in("tag_id", ids);
    if (delErr) throw delErr;
  }
  const wanted = tagForPolicy(policy);
  const tagId = wanted ? byName.get(wanted) : null;
  if (!tagId) return;
  const { error } = await supabase
    .from("contact_tags")
    .insert({ contact_id: contactId, tag_id: tagId });
  if (error) throw error;
}
