/**
 * Reads and writes of referral_commission_rules (migration 20261007224100) —
 * a commission deal with one referring company or one referring person.
 *
 * Mark, 7 Oct: "(in admin we need to be able put the rates for each
 * referral), or use the current commission page in admin settings". So the
 * rules live on Settings › Commissions beside the role and name rates, and
 * this file is the only way the app touches the table. The arithmetic is not
 * here: `src/lib/job-commission.ts` is the one calculation.
 *
 * Until the migration is applied the table does not exist. Every read here
 * answers that with `available: false` rather than an error, so the admin page
 * says "needs a database update" and every job keeps working off the source
 * rates exactly as before.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { ReferralRule, RuleKind } from "@/lib/job-commission";
import { isMissingSchema } from "@/lib/schema-fallback";

const db = () => supabase as unknown as SupabaseClient;

export const REFERRAL_RULES_TABLE = "referral_commission_rules";

/** A rule plus the name of whoever it is with, for the admin list. */
export type ReferralRuleRow = ReferralRule & {
  payee_name: string;
  payee_type: "account" | "contact";
};

export type ReferralRulesRead = { available: boolean; rules: ReferralRuleRow[] };

const RULE_SELECT =
  "id, account_id, contact_id, kind, value, effective_from, effective_to, note, accounts(name), contacts(full_name)";

type RawRule = ReferralRule & {
  accounts?: { name: string | null } | { name: string | null }[] | null;
  contacts?: { full_name: string | null } | { full_name: string | null }[] | null;
};

/** An untyped client may hand a to-one embed back as an array of one. */
const one = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

function toRow(r: RawRule): ReferralRuleRow {
  const isCompany = !!r.account_id;
  return {
    id: r.id,
    account_id: r.account_id,
    contact_id: r.contact_id,
    kind: r.kind === "flat" ? "flat" : "percent",
    value: Number(r.value),
    effective_from: r.effective_from,
    effective_to: r.effective_to,
    note: r.note ?? null,
    payee_type: isCompany ? "account" : "contact",
    payee_name:
      (isCompany ? one(r.accounts)?.name : one(r.contacts)?.full_name) ??
      (isCompany ? "Unnamed company" : "Unnamed person"),
  };
}

/** Every rule this viewer may see, with payee names. */
export async function loadReferralRules(): Promise<ReferralRulesRead> {
  const { data, error } = await db()
    .from(REFERRAL_RULES_TABLE)
    .select(RULE_SELECT)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissingSchema(error)) return { available: false, rules: [] };
    throw error;
  }
  return { available: true, rules: ((data ?? []) as unknown as RawRule[]).map(toRow) };
}

/** The rules for one job's referrer only — what the job's card needs. */
export async function loadRulesForReferrer(ref: {
  accountId: string | null;
  contactId: string | null;
}): Promise<ReferralRulesRead> {
  const ors: string[] = [];
  if (ref.accountId) ors.push(`account_id.eq.${ref.accountId}`);
  if (ref.contactId) ors.push(`contact_id.eq.${ref.contactId}`);
  if (ors.length === 0) return { available: true, rules: [] };
  const { data, error } = await db()
    .from(REFERRAL_RULES_TABLE)
    .select(RULE_SELECT)
    .or(ors.join(","));
  if (error) {
    if (isMissingSchema(error)) return { available: false, rules: [] };
    throw error;
  }
  return { available: true, rules: ((data ?? []) as unknown as RawRule[]).map(toRow) };
}

export type RuleDraft = {
  payee: { type: "account" | "contact"; id: string } | null;
  kind: RuleKind;
  value: number | null;
  effective_from: string | null;
  effective_to: string | null;
  note: string;
};

export const BLANK_RULE_DRAFT: RuleDraft = {
  payee: null,
  kind: "percent",
  value: null,
  effective_from: null,
  effective_to: null,
  note: "",
};

/** What stops a rule being saved, in a sentence, or null. Mirrors the CHECKs. */
export function ruleProblem(draft: RuleDraft): string | null {
  if (!draft.payee) return "Pick the referring company or person.";
  const v = draft.value;
  if (v == null || !Number.isFinite(v) || v < 0) {
    return draft.kind === "flat"
      ? "Give the flat fee in dollars."
      : "Give the rate as a percentage.";
  }
  if (draft.kind === "percent" && v > 100) return "A percentage is between 0 and 100.";
  if (draft.effective_from && draft.effective_to && draft.effective_from > draft.effective_to) {
    return "The rule ends before it starts.";
  }
  return null;
}

/**
 * The guard trigger refuses a second rule for the same payee and dates with
 * 23P01; say that in the admin's words rather than a constraint name.
 */
export function overlapMessage(err: unknown): string | null {
  const e = err as { code?: string; message?: string } | null;
  if (e?.code === "23P01" || /already has a commission rule/i.test(e?.message ?? "")) {
    return "There is already a rule for them covering those dates. Give the old one an end date first, or edit it instead.";
  }
  return null;
}

export async function insertReferralRule(draft: RuleDraft): Promise<ReferralRuleRow> {
  const problem = ruleProblem(draft);
  if (problem) throw new Error(problem);
  const { data, error } = await db()
    .from(REFERRAL_RULES_TABLE)
    .insert({
      account_id: draft.payee!.type === "account" ? draft.payee!.id : null,
      contact_id: draft.payee!.type === "contact" ? draft.payee!.id : null,
      kind: draft.kind,
      value: draft.value,
      effective_from: draft.effective_from || null,
      effective_to: draft.effective_to || null,
      note: draft.note.trim() || null,
    })
    .select(RULE_SELECT)
    .single();
  if (error) throw error;
  return toRow(data as unknown as RawRule);
}

export type RulePatch = Partial<
  Pick<ReferralRule, "kind" | "value" | "effective_from" | "effective_to" | "note">
>;

export async function updateReferralRule(id: string, patch: RulePatch): Promise<void> {
  const { data, error } = await db()
    .from(REFERRAL_RULES_TABLE)
    .update(patch)
    .eq("id", id)
    .select("id");
  if (error) throw error;
  // RLS answers a write it refuses with zero rows, not an error.
  if ((data ?? []).length === 0) throw new Error("Only an admin can change commission rules.");
}

export async function deleteReferralRule(id: string): Promise<void> {
  const { data, error } = await db().from(REFERRAL_RULES_TABLE).delete().eq("id", id).select("id");
  if (error) throw error;
  if ((data ?? []).length === 0) throw new Error("Only an admin can remove commission rules.");
}
