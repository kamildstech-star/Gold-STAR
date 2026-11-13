/**
 * BILLING & COSTS › CLIENT AGREEMENTS (prompt 4) — what regular (non-T&M)
 * work is charged at.
 *
 *   STANDARD RATES: what every client without an agreement pays — a company
 *   default per catalog item and, where an office differs, that office's own
 *   price (money_values book client_agreements, measure unit_price, item_key
 *   = the catalog code). Seeded from the catalog default and the old branch
 *   price lists (20261101120000).
 *
 *   CLIENT AGREEMENTS: the price lists, now a list of EXCEPTIONS only. A line
 *   the agreement names overrides Standard; silence inherits Standard, live —
 *   when Standard moves, every inherited line follows. One agreement applies
 *   to one or many clients (dated links; one primary per client).
 *
 * Resolution is the database's regular_price_book (job line → agreement →
 * office Standard → state list → company Standard → none); this file loads,
 * shapes and saves. Owner and admin change it; everyone reads it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { resolveOfficeValue, type MoneyBook, type MoneyValueRow } from "@/lib/office-values";
import { isMissingSchema } from "@/lib/schema-fallback";
import { parseMoney, type Office } from "@/lib/tm-rates";

export type StandardLens = { book: MoneyBook; measure: string };
export const STANDARD_LENS: StandardLens = { book: "client_agreements", measure: "unit_price" };

export type RegularItem = {
  id: string;
  /** The line's key: the catalog code (T&M: also EQ:<type>). */
  code: string;
  /** What the screen shows as the code, when it is not the key. */
  label?: string;
  name: string;
  uom: string;
  active: boolean;
  sort_order: number;
  /**
   * The job-type header the item sits under on the invoice picker (Sewage,
   * Bio, Fire & Smoke, Mold, Water …) — 6 Nov, David and Athar: the rate
   * book is organised as tabs per job type. Null = under no header.
   */
  header_id?: string | null;
};

/** A job-type header (estimate_headers): a tab on the General Rates book. */
export type RateHeader = { id: string; code: string; name: string; sort_order: number };

export type AgreementClient = {
  assignmentId: string;
  accountId: string;
  accountName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  primary: boolean;
};

export type Agreement = {
  id: string;
  name: string;
  kind: "agreement" | "office" | "state";
  effectiveFrom: string | null;
  archived: boolean;
  fullCopy: boolean;
  /** code → the agreed price: the exceptions. */
  lines: Map<string, number>;
  clients: AgreementClient[];
  /** State lists: the state; office lists: the offices they were for. */
  scopes: string[];
};

export type AgreementsData = {
  /** False until migration 20261101120000 (T&M: 20261107120000). */
  available: boolean;
  /** Which money values are "Standard": regular unit prices, or T&M bill rates. */
  lens?: StandardLens;
  items: RegularItem[];
  /** The job-type tabs, in order; absent on the T&M lens. */
  headers?: RateHeader[];
  standard: MoneyValueRow[];
  offices: Office[];
  agreements: Agreement[];
};

// ----------------------------------------------------------------- shaping

/** A client's link is in force on a day. */
export const linkLive = (c: AgreementClient, on: string) =>
  c.effectiveFrom <= on && (!c.effectiveTo || c.effectiveTo >= on);

/** The Standard price of an item at an office (null = company default) on a day. */
export function standardPrice(
  rows: readonly MoneyValueRow[],
  code: string,
  office: string | null,
  on: string,
  lens: StandardLens = STANDARD_LENS,
): { value: number; source: "office" | "default" } | null {
  const r = resolveOfficeValue(rows, { ...lens, item_key: code }, office, on);
  return r ? { value: r.value, source: r.source } : null;
}

/** "3 items overridden · all others follow Standard". */
export function overrideSummary(
  a: Pick<Agreement, "lines">,
  items: readonly RegularItem[],
  standard = "Standard",
): string {
  const n = items.filter((i) => a.lines.has(i.code)).length;
  return `${n} item${n === 1 ? "" : "s"} overridden · all others follow ${standard}`;
}

/** The first few exceptions, for the card ("Labor $60.00/HR"). */
export function keyRates(
  a: Pick<Agreement, "lines">,
  items: readonly RegularItem[],
  max = 3,
): { code: string; name: string; uom: string; price: number }[] {
  return [...items]
    .sort((x, y) => x.sort_order - y.sort_order)
    .filter((i) => a.lines.has(i.code))
    .slice(0, max)
    .map((i) => ({ code: i.code, name: i.name, uom: i.uom, price: a.lines.get(i.code)! }));
}

/** Agreements under the name of the client they are grouped by (first live link), then unlinked. */
export function groupByClient(
  agreements: readonly Agreement[],
  on: string,
): { client: string; agreements: Agreement[] }[] {
  const groups = new Map<string, Agreement[]>();
  for (const a of agreements) {
    const live = a.clients
      .filter((c) => linkLive(c, on))
      .sort((x, y) => Number(y.primary) - Number(x.primary));
    const key = live[0]?.accountName ?? "";
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([client, list]) => ({
      client: client || "Not linked to a client yet",
      agreements: list.sort((x, y) => x.name.localeCompare(y.name)),
    }));
}

/** Most of a client's jobs are T&M: the attach-time note (regular agreements). */
export function mostlyTm(mix: { jobs: number; tm_jobs: number } | undefined): boolean {
  return !!mix && mix.jobs > 0 && mix.tm_jobs / mix.jobs > 0.5;
}

/** Most of a client's jobs are regular: the attach-time note (T&M agreements). */
export function mostlyRegular(mix: { jobs: number; tm_jobs: number } | undefined): boolean {
  return !!mix && mix.jobs > 0 && (mix.jobs - mix.tm_jobs) / mix.jobs > 0.5;
}

// ------------------------------------------------------------------ drafts

/** Standard: a typed price per item × scope ("" = cleared), or an office reset. */
export type StandardDraft = Readonly<Record<string, { value: string } | { reset: true }>>;
export const standardKey = (code: string, office: string | null) =>
  `${code}|${office ?? "default"}`;

export function standardProblems(draft: StandardDraft): Map<string, string> {
  const p = new Map<string, string>();
  for (const [k, e] of Object.entries(draft)) {
    if (!("value" in e)) continue;
    const v = parseMoney(e.value);
    if (Number.isNaN(v)) p.set(k, "Dollars and cents, 0 or more.");
    else if (v == null && k.endsWith("|default")) p.set(k, "The company Standard needs a price.");
    else if (v == null) p.set(k, "Enter a price, or reset to the company Standard.");
  }
  return p;
}

export function standardDraftToChanges(draft: StandardDraft): Record<string, unknown>[] {
  return Object.keys(draft)
    .sort()
    .map((id) => {
      const e = draft[id]!;
      const at = id.lastIndexOf("|");
      const scope = id.slice(at + 1);
      return {
        code: id.slice(0, at),
        office_id: scope === "default" ? null : scope,
        value: "reset" in e ? null : parseMoney(e.value),
      };
    });
}

/** One agreement's pending edit, as agreements_save changes. */
export type AgreementDraft = {
  /** code → typed price; "" = drop the exception (back to Standard). */
  lines: Readonly<Record<string, string>>;
  link: readonly { accountId: string; primary: boolean }[];
  unlink: readonly string[];
  rename?: string;
};
export const EMPTY_AGREEMENT_DRAFT: AgreementDraft = { lines: {}, link: [], unlink: [] };

export function agreementProblems(d: AgreementDraft): Map<string, string> {
  const p = new Map<string, string>();
  for (const [code, raw] of Object.entries(d.lines)) {
    if (raw.trim() === "") continue;
    if (Number.isNaN(parseMoney(raw))) p.set(code, "Dollars and cents, 0 or more.");
  }
  if (d.rename !== undefined && !d.rename.trim()) p.set("name", "An agreement needs a name.");
  return p;
}

export function agreementDraftToChanges(
  agreementId: string,
  d: AgreementDraft,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (d.rename !== undefined)
    out.push({ op: "rename", agreement_id: agreementId, name: d.rename.trim() });
  for (const code of Object.keys(d.lines).sort()) {
    const raw = d.lines[code]!;
    out.push({
      op: "line",
      agreement_id: agreementId,
      code,
      value: raw.trim() === "" ? null : parseMoney(raw),
    });
  }
  for (const l of d.link) {
    out.push({
      op: "link",
      agreement_id: agreementId,
      account_id: l.accountId,
      primary: l.primary,
    });
  }
  for (const id of d.unlink) out.push({ op: "unlink", assignment_id: id });
  return out;
}

export const agreementDraftSize = (d: AgreementDraft) =>
  Object.keys(d.lines).length + d.link.length + d.unlink.length + (d.rename !== undefined ? 1 : 0);

// ----------------------------------------------------------------- loaders

const db = () => supabase as unknown as SupabaseClient;

type ListRow = {
  id: string;
  name: string;
  kind: Agreement["kind"];
  effective_from: string | null;
  archived_at: string | null;
  is_active: boolean;
  full_copy: boolean;
};
type AssignRow = {
  id: string;
  price_list_id: string;
  account_id: string | null;
  location_id: string | null;
  state_code: string | null;
  effective_from: string;
  effective_to: string | null;
  is_primary: boolean;
};

export async function loadAgreements(client: SupabaseClient = db()): Promise<AgreementsData> {
  const empty: AgreementsData = {
    available: false,
    items: [],
    standard: [],
    offices: [],
    agreements: [],
  };
  const [itemsQ, stdQ, listsQ, linesQ, assignQ, officesQ, headersQ] = await Promise.all([
    client
      .from("estimate_catalog_items")
      .select("id, code, name, uom, is_active, sort_order, header_id")
      .order("sort_order"),
    client
      .from("money_values")
      .select("book, item_key, measure, office_id, effective_from, value")
      .eq("book", "client_agreements")
      .eq("measure", "unit_price"),
    client
      .from("price_lists")
      .select("id, name, kind, effective_from, archived_at, is_active, full_copy")
      .order("name"),
    client.from("price_list_items").select("price_list_id, catalog_item_id, unit_price"),
    client
      .from("price_list_assignments")
      .select(
        "id, price_list_id, account_id, location_id, state_code, effective_from, effective_to, is_primary",
      ),
    client.from("locations").select("id, name, code, active").order("name"),
    client
      .from("estimate_headers")
      .select("id, code, name, sort_order")
      .eq("is_active", true)
      .order("sort_order"),
  ]);
  for (const e of [listsQ.error, assignQ.error]) {
    // kind / is_primary arrive with 20261101120000.
    if (e && (isMissingSchema(e) || (e as { code?: string }).code === "42703")) return empty;
    if (e) throw e;
  }
  if (itemsQ.error) throw itemsQ.error;
  if (stdQ.error) throw stdQ.error;
  if (linesQ.error) throw linesQ.error;
  const items = (
    (itemsQ.data ?? []) as (Omit<RegularItem, "active"> & { is_active: boolean })[]
  ).map((i) => ({
    id: i.id,
    code: i.code,
    name: i.name,
    uom: i.uom,
    active: i.is_active,
    sort_order: i.sort_order,
    header_id: i.header_id ?? null,
  }));
  const codeOf = new Map(items.map((i) => [i.id, i.code]));
  // The job-type tabs. An older database without the table simply has none.
  const headers = (headersQ.error ? [] : ((headersQ.data ?? []) as RateHeader[])).map((h) => ({
    id: h.id,
    code: h.code,
    name: h.name,
    sort_order: h.sort_order,
  }));
  const assigns = (assignQ.data ?? []) as AssignRow[];
  const accountIds = [...new Set(assigns.map((a) => a.account_id).filter((v): v is string => !!v))];
  const names = accountIds.length
    ? await client.from("accounts").select("id, name").in("id", accountIds)
    : { data: [] as { id: string; name: string }[] };
  const nameOf = new Map(
    ((names.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]),
  );
  const offices = ((officesQ.data ?? []) as (Office & { active: boolean })[])
    .filter((o) => o.active)
    .map(({ id, name, code }) => ({ id, name, code }));
  const officeName = new Map(offices.map((o) => [o.id, o.name]));
  const linesBy = new Map<string, Map<string, number>>();
  for (const l of (linesQ.data ?? []) as {
    price_list_id: string;
    catalog_item_id: string;
    unit_price: number | string;
  }[]) {
    const code = codeOf.get(l.catalog_item_id);
    if (!code) continue;
    const m = linesBy.get(l.price_list_id) ?? new Map<string, number>();
    m.set(code, Number(l.unit_price));
    linesBy.set(l.price_list_id, m);
  }
  return {
    available: true,
    items,
    headers,
    standard: ((stdQ.data ?? []) as (MoneyValueRow & { value: number | string | null })[]).map(
      (r) => ({
        ...r,
        value: r.value == null ? null : Number(r.value),
      }),
    ),
    offices,
    agreements: ((listsQ.data ?? []) as ListRow[]).map((l) => {
      const mine = assigns.filter((a) => a.price_list_id === l.id);
      return {
        id: l.id,
        name: l.name,
        kind: l.kind,
        effectiveFrom: l.effective_from,
        archived: !!l.archived_at || !l.is_active,
        fullCopy: l.full_copy,
        lines: linesBy.get(l.id) ?? new Map(),
        clients: mine
          .filter((a) => a.account_id)
          .map((a) => ({
            assignmentId: a.id,
            accountId: a.account_id!,
            accountName: nameOf.get(a.account_id!) ?? "Client",
            effectiveFrom: a.effective_from,
            effectiveTo: a.effective_to,
            primary: a.is_primary,
          })),
        scopes: [
          ...mine.filter((a) => a.state_code).map((a) => a.state_code!),
          ...mine
            .filter((a) => a.location_id)
            .map((a) => officeName.get(a.location_id!) ?? "Office"),
        ],
      };
    }),
  };
}

/** Jobs and T&M jobs per client (owner/admin; [] for anyone else). */
export async function loadJobMix(
  accountIds: readonly string[],
  client: SupabaseClient = db(),
): Promise<Map<string, { jobs: number; tm_jobs: number }>> {
  if (!accountIds.length) return new Map();
  const { data, error } = await client.rpc(
    "account_job_mix" as never,
    { _account_ids: [...new Set(accountIds)] } as never,
  );
  if (error) return new Map();
  return new Map(
    ((data ?? []) as { account_id: string; jobs: number; tm_jobs: number }[]).map((r) => [
      r.account_id,
      { jobs: r.jobs, tm_jobs: r.tm_jobs },
    ]),
  );
}

export async function saveStandard(
  changes: readonly Record<string, unknown>[],
  note: string,
  client: SupabaseClient = db(),
): Promise<number> {
  const { data, error } = await client.rpc(
    "standard_save" as never,
    { _changes: changes, _note: note.trim() || null } as never,
  );
  if (error) throw error;
  return Number(data ?? 0);
}

export async function saveAgreements(
  changes: readonly Record<string, unknown>[],
  note: string,
  client: SupabaseClient = db(),
): Promise<string | null> {
  const { data, error } = await client.rpc(
    "agreements_save" as never,
    { _changes: changes, _note: note.trim() } as never,
  );
  if (error) throw error;
  return (data as string | null) ?? null;
}

// --------------------------------------------------------------- job source

export type JobRates = {
  available: boolean;
  source: "agreement" | "standard" | "custom" | null;
  agreementId: string | null;
  /** The client's agreements in force today, primary first. */
  options: { id: string; name: string; primary: boolean }[];
  /** The job's own sheet: code → price and where it came from. */
  sheet: { catalogItemId: string; code: string; name: string; price: number; source: string }[];
};

export async function loadJobRates(
  job: { id: string; account_id: string | null },
  client: SupabaseClient = db(),
): Promise<JobRates> {
  const [jobQ, sheetQ, optsQ] = await Promise.all([
    client.from("jobs").select("rate_source, rate_agreement_id").eq("id", job.id).maybeSingle(),
    client
      .from("job_regular_rates")
      .select("catalog_item_id, unit_price, source, estimate_catalog_items(code, name)")
      .eq("job_id", job.id),
    job.account_id
      ? client
          .from("price_list_assignments")
          .select(
            "price_list_id, is_primary, effective_from, effective_to, price_lists(name, kind, archived_at)",
          )
          .eq("account_id", job.account_id)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (jobQ.error) {
    const code = (jobQ.error as { code?: string }).code;
    if (isMissingSchema(jobQ.error) || code === "42703")
      return { available: false, source: null, agreementId: null, options: [], sheet: [] };
    throw jobQ.error;
  }
  const today = new Date().toLocaleDateString("en-CA");
  const opts = (
    (optsQ.data ?? []) as unknown as {
      price_list_id: string;
      is_primary: boolean;
      effective_from: string;
      effective_to: string | null;
      price_lists: { name: string; kind: string; archived_at: string | null } | null;
    }[]
  )
    .filter(
      (o) =>
        o.price_lists?.kind === "agreement" &&
        !o.price_lists.archived_at &&
        o.effective_from <= today &&
        (!o.effective_to || o.effective_to >= today),
    )
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary));
  const seen = new Set<string>();
  const j = (jobQ.data ?? {}) as {
    rate_source: JobRates["source"];
    rate_agreement_id: string | null;
  };
  return {
    available: true,
    source: j.rate_source ?? null,
    agreementId: j.rate_agreement_id ?? null,
    options: opts
      .filter((o) => !seen.has(o.price_list_id) && seen.add(o.price_list_id))
      .map((o) => ({ id: o.price_list_id, name: o.price_lists!.name, primary: o.is_primary })),
    sheet: (
      (sheetQ.data ?? []) as unknown as {
        catalog_item_id: string;
        unit_price: number | string;
        source: string;
        estimate_catalog_items: { code: string; name: string } | null;
      }[]
    )
      .map((r) => ({
        catalogItemId: r.catalog_item_id,
        code: r.estimate_catalog_items?.code ?? "",
        name: r.estimate_catalog_items?.name ?? "",
        price: Number(r.unit_price),
        source: r.source,
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };
}

/** The tag a document shows: which rates this job is on. */
export function jobRatesLabel(r: Pick<JobRates, "source" | "agreementId" | "options">): string {
  if (r.source === "standard") return "Standard";
  if (r.source === "custom") return "Custom for this job";
  const chosen = r.options.find((o) => o.id === r.agreementId) ?? r.options[0];
  return chosen ? `${chosen.name} (client agreement)` : "Standard";
}

export async function setJobRateSource(
  jobId: string,
  source: "agreement" | "standard" | "custom",
  agreementId: string | null,
  client: SupabaseClient = db(),
): Promise<void> {
  const { error } = await client.rpc(
    "job_rate_source_set" as never,
    { _job_id: jobId, _source: source, _agreement_id: agreementId, _note: null } as never,
  );
  if (error) throw error;
}

export async function setJobRateLine(
  jobId: string,
  catalogItemId: string,
  price: number | null,
  client: SupabaseClient = db(),
): Promise<void> {
  const { error } = await client.rpc(
    "job_rate_line_set" as never,
    { _job_id: jobId, _catalog_item_id: catalogItemId, _price: price, _note: null } as never,
  );
  if (error) throw error;
}
