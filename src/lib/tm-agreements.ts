/**
 * BILLING & COSTS › T&M RATES › CLIENT AGREEMENTS (BC-TM-AGR-1) — what a
 * client's T&M jobs bill at when it has its own deal.
 *
 * Same shape as the regular Client Agreements (src/lib/agreements.ts): a list
 * of EXCEPTIONS over T&M Rates (money_values book tm_rates, measure
 * bill_rate). A line it names overrides the rate; silence follows the
 * office's T&M rate. Lines are keyed like T&M Rates — the catalog code, or
 * EQ:<type> for an equipment type. One agreement applies to one or many
 * clients (dated links, one primary per client).
 *
 * A new T&M job takes its client's primary agreement and freezes it into its
 * sheet; the office can switch a job's agreement (repriced, rates typed for
 * the job kept). The database resolves (tm_bill_rates); migration
 * 20261107120000. Owner and admin change agreements; everyone reads them.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Agreement, AgreementsData, RegularItem } from "@/lib/agreements";
import { isMissingSchema } from "@/lib/schema-fallback";
import { RATE_LENS, loadTmRates, type RateItem } from "@/lib/tm-rates";

const db = () => supabase as unknown as SupabaseClient;

/** The T&M Rates items an agreement can price: one per key, live ones first by sheet order. */
export function tmAgreementItems(items: readonly RateItem[]): RegularItem[] {
  const seen = new Set<string>();
  const out: RegularItem[] = [];
  for (const i of items) {
    if (seen.has(i.key)) continue;
    seen.add(i.key);
    out.push({
      id: i.key,
      code: i.key,
      label: i.code !== i.key ? i.code : undefined,
      name: i.name,
      uom: i.unitLabel?.replace(/^per /, "") ?? "",
      active: i.active && !i.archived,
      sort_order: out.length,
    });
  }
  return out;
}

type AgreementRow = {
  id: string;
  name: string;
  effective_from: string;
  archived_at: string | null;
};
type LineRow = { agreement_id: string; item_key: string; rate: number | string };
type ClientRow = {
  id: string;
  agreement_id: string;
  account_id: string;
  effective_from: string;
  effective_to: string | null;
  is_primary: boolean;
};

export async function loadTmAgreements(client: SupabaseClient = db()): Promise<AgreementsData> {
  const empty: AgreementsData = {
    available: false,
    items: [],
    standard: [],
    offices: [],
    agreements: [],
    lens: RATE_LENS,
  };
  const [rates, listsQ, linesQ, clientsQ] = await Promise.all([
    loadTmRates({ lens: RATE_LENS, seeCosts: false }, client),
    client.from("tm_agreements").select("id, name, effective_from, archived_at").order("name"),
    client.from("tm_agreement_lines").select("agreement_id, item_key, rate"),
    client
      .from("tm_agreement_clients")
      .select("id, agreement_id, account_id, effective_from, effective_to, is_primary"),
  ]);
  for (const e of [listsQ.error, linesQ.error, clientsQ.error]) {
    if (e && isMissingSchema(e)) return empty;
    if (e) throw e;
  }
  if (!rates.available) return empty;
  const links = (clientsQ.data ?? []) as ClientRow[];
  const accountIds = [...new Set(links.map((l) => l.account_id))];
  const names = accountIds.length
    ? await client.from("accounts").select("id, name").in("id", accountIds)
    : { data: [] as { id: string; name: string }[] };
  const nameOf = new Map(
    ((names.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]),
  );
  const linesBy = new Map<string, Map<string, number>>();
  for (const l of (linesQ.data ?? []) as LineRow[]) {
    const m = linesBy.get(l.agreement_id) ?? new Map<string, number>();
    m.set(l.item_key, Number(l.rate));
    linesBy.set(l.agreement_id, m);
  }
  return {
    available: true,
    lens: RATE_LENS,
    items: tmAgreementItems(rates.items),
    standard: rates.rows,
    offices: rates.offices,
    agreements: ((listsQ.data ?? []) as AgreementRow[]).map((a): Agreement => ({
      id: a.id,
      name: a.name,
      kind: "agreement",
      effectiveFrom: a.effective_from,
      archived: !!a.archived_at,
      fullCopy: false,
      lines: linesBy.get(a.id) ?? new Map(),
      clients: links
        .filter((l) => l.agreement_id === a.id)
        .map((l) => ({
          assignmentId: l.id,
          accountId: l.account_id,
          accountName: nameOf.get(l.account_id) ?? "Client",
          effectiveFrom: l.effective_from,
          effectiveTo: l.effective_to,
          primary: l.is_primary,
        })),
      scopes: [],
    })),
  };
}

/** Open T&M agreements, for the tab's label; null before the migration. */
export async function countTmAgreements(client: SupabaseClient = db()): Promise<number | null> {
  const { count, error } = await client
    .from("tm_agreements")
    .select("id", { count: "exact", head: true })
    .is("archived_at", null);
  return error ? null : (count ?? 0);
}

/** The T&M agreements tab's one Save (same ops as agreements_save, minus from_job). */
export async function saveTmAgreements(
  changes: readonly Record<string, unknown>[],
  note: string,
  client: SupabaseClient = db(),
): Promise<string | null> {
  const { data, error } = await client.rpc(
    "tm_agreements_save" as never,
    { _changes: changes, _note: note.trim() } as never,
  );
  if (error) throw error;
  return (data as string | null) ?? null;
}

// --------------------------------------------------------------- the job

export type JobTmAgreement = {
  /** False until migration 20261107120000. */
  available: boolean;
  /** The agreement the job bills at; null = T&M Rates. */
  agreementId: string | null;
  agreementName: string | null;
  /** The client's T&M agreements in force today, primary first. */
  options: { id: string; name: string; primary: boolean }[];
};

export async function loadJobTmAgreement(
  job: { id: string; account_id: string | null },
  client: SupabaseClient = db(),
): Promise<JobTmAgreement> {
  const none: JobTmAgreement = {
    available: false,
    agreementId: null,
    agreementName: null,
    options: [],
  };
  const [jobQ, optsQ] = await Promise.all([
    client.from("jobs").select("tm_agreement_id").eq("id", job.id).maybeSingle(),
    job.account_id
      ? client
          .from("tm_agreement_clients")
          .select(
            "agreement_id, is_primary, effective_from, effective_to, tm_agreements(name, archived_at)",
          )
          .eq("account_id", job.account_id)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (jobQ.error) {
    const code = (jobQ.error as { code?: string }).code;
    if (isMissingSchema(jobQ.error) || code === "42703") return none;
    throw jobQ.error;
  }
  if (optsQ.error) {
    if (isMissingSchema(optsQ.error)) return none;
    throw optsQ.error;
  }
  const agreementId =
    ((jobQ.data ?? {}) as { tm_agreement_id?: string | null }).tm_agreement_id ?? null;
  const today = new Date().toLocaleDateString("en-CA");
  const rows = (optsQ.data ?? []) as unknown as {
    agreement_id: string;
    is_primary: boolean;
    effective_from: string;
    effective_to: string | null;
    tm_agreements: { name: string; archived_at: string | null } | null;
  }[];
  const seen = new Set<string>();
  const options = rows
    .filter(
      (o) =>
        o.tm_agreements &&
        !o.tm_agreements.archived_at &&
        o.effective_from <= today &&
        (!o.effective_to || o.effective_to >= today),
    )
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary))
    .filter((o) => !seen.has(o.agreement_id) && seen.add(o.agreement_id))
    .map((o) => ({ id: o.agreement_id, name: o.tm_agreements!.name, primary: o.is_primary }));
  let agreementName = rows.find((r) => r.agreement_id === agreementId)?.tm_agreements?.name ?? null;
  if (agreementId && !agreementName) {
    // An agreement that has since ended for this client: the job still bills at it.
    const { data } = await client
      .from("tm_agreements")
      .select("name")
      .eq("id", agreementId)
      .maybeSingle();
    agreementName = (data as { name: string } | null)?.name ?? null;
  }
  return { available: true, agreementId, agreementName, options };
}

/** The tag a T&M job shows: which T&M rates it bills at. */
export function jobTmAgreementLabel(r: Pick<JobTmAgreement, "agreementId" | "agreementName">) {
  return r.agreementId
    ? `${r.agreementName ?? "Client agreement"} (client agreement)`
    : "T&M Rates";
}

/** Switch a T&M job to an agreement (null = T&M Rates); its sheet is repriced. */
export async function setJobTmAgreement(
  jobId: string,
  agreementId: string | null,
  client: SupabaseClient = db(),
): Promise<void> {
  const { error } = await client.rpc(
    "job_tm_agreement_set" as never,
    { _job_id: jobId, _agreement_id: agreementId, _note: null } as never,
  );
  if (error) throw error;
}
