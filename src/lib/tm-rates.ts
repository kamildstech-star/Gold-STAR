/**
 * BILLING & COSTS › T&M RATES — what each item bills at on a T&M job,
 * company default plus per-office overrides, effective-dated (prompt 2).
 *
 * Items are never created here. They are listed from where they live:
 * Labor / General Consumables / PPE / Vehicle lines from Catalogs; equipment
 * types from the Equipment module (with the T&M sheet's equipment codes
 * mapped onto them); the supply list's General Charges from the T&M rate
 * codes. Every rate is a money_values row (book tm_rates, measure
 * bill_rate) and resolves by src/lib/office-values.ts — the same rule the
 * bill's resolver (tm_bill_rates) applies in SQL.
 *
 * Pure apart from the loaders and the save at the bottom.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { CATALOG_UNIT_LABEL, loadCatalog, type CatalogItem, type CatalogUnit } from "@/lib/catalog";
import {
  resolveOfficeValue,
  type MoneyBook,
  type MoneyValueRow,
  type ResolvedValue,
} from "@/lib/office-values";
import { isMissingSchema } from "@/lib/schema-fallback";

export const TM_RATE_CATEGORIES = [
  "labor",
  "consumable",
  "ppe",
  "vehicle",
  "equipment",
  "general",
] as const;
export type TmRateCategory = (typeof TM_RATE_CATEGORIES)[number];

export const TM_RATE_CATEGORY_LABEL: Readonly<Record<TmRateCategory, string>> = {
  labor: "Labor",
  consumable: "General Consumables",
  ppe: "PPE",
  vehicle: "Vehicle lines",
  equipment: "Equipment",
  general: "Supply-list charges",
};

/** General codes priced by a General rules charge, not a rate. */
export const RULE_PRICED_CODES = new Set(["GEN-SMALLTOOLS", "GEN-PERDIEM", "GEN-OP"]);

export type RateItem = {
  /** money_values item_key: the code, or EQ:<type> for an equipment type. */
  key: string;
  /** What the screen shows as the code. */
  code: string;
  name: string;
  category: TmRateCategory;
  /** "per hour", "per day", "per unit-day"… */
  unitLabel: string | null;
  active: boolean;
  archived: boolean;
  /** Labor only: whether Small Tools is charged on this title. */
  smallTools?: boolean;
  /** Labor only: field = cost computed by the overhead engine; management = typed. */
  laborClass?: "field" | "management";
  /** Equipment: a type, or a sheet code (mapped to a type, or flagged). */
  equipment?: { kind: "type" } | { kind: "code"; type: string | null; review: string | null };
  /** "How it bills", for the tooltip. */
  note?: string | null;
};

export type Office = { id: string; name: string; code: string | null };

/** Which values a grid edits: T&M Rates' bill rates or the Cost tab's costs. */
export type MoneyLens = { book: MoneyBook; measure: string };
export const RATE_LENS: MoneyLens = { book: "tm_rates", measure: "bill_rate" };
export const COST_LENS: MoneyLens = { book: "cost", measure: "cost_rate" };

/** null = company default. */
export type Scope = string | null;

export const cellKey = (key: string, office: Scope) => `${key}|${office ?? "default"}`;

// ----------------------------------------------------------------- the draft

/** A pending change to one cell: a value typed ("" = cleared), or reset to default. */
export type CellEdit = { value: string } | { reset: true };
export type RatesDraft = {
  cells: Readonly<Record<string, CellEdit>>;
  smallTools: Readonly<Record<string, boolean>>;
};
export const EMPTY_RATES_DRAFT: RatesDraft = { cells: {}, smallTools: {} };

export function ratesDraftSize(d: RatesDraft): number {
  return Object.keys(d.cells).length + Object.keys(d.smallTools).length;
}

export function parseMoney(raw: string, decimals = 2): number | null {
  const t = raw.replace(/[$,\s]/g, "");
  if (t === "") return null;
  const v = Number(t);
  const f = 10 ** decimals;
  return Number.isFinite(v) && v >= 0 && Math.round(v * f) / f === v ? v : NaN;
}

/** An equipment type's day cost may carry fractions of a cent (P4 answer 4). */
export const decimalsFor = (key: string, lens: MoneyLens = RATE_LENS) =>
  lens.book === "cost" && key.startsWith("EQ:") ? 4 : 2;

export type Cell = {
  value: number | null;
  /** office = this office's own rate; default = inherited; none = no rate at all. */
  source: "office" | "default" | "none";
  /** An office row that is in force (an override), even if its value matches the default. */
  overridden: boolean;
  /** The value came from the draft. */
  edited: boolean;
  /** The office override is older than the current default (hint, never a block). */
  olderThanDefault?: boolean;
};

/**
 * One cell as it will be after Save: the draft first, then the saved rows.
 * For the company default, `source` is "default" or "none".
 */
export function cellFor(
  rows: readonly MoneyValueRow[],
  draft: RatesDraft,
  key: string,
  office: Scope,
  on: string,
  lens: MoneyLens = RATE_LENS,
): Cell {
  const ref = { ...lens, item_key: key };
  const defaultEdit = draft.cells[cellKey(key, null)];
  const defaultValue = (): ResolvedValue | null => {
    if (defaultEdit && "value" in defaultEdit) {
      const v = parseMoney(defaultEdit.value, decimalsFor(key, lens));
      return v == null || Number.isNaN(v)
        ? null
        : { value: v, source: "default", effective_from: on };
    }
    return resolveOfficeValue(rows, ref, null, on);
  };
  if (office === null) {
    const d = defaultValue();
    return {
      value: d?.value ?? null,
      source: d ? "default" : "none",
      overridden: false,
      edited: !!defaultEdit,
    };
  }
  const edit = draft.cells[cellKey(key, office)];
  if (edit && "value" in edit) {
    const v = parseMoney(edit.value, decimalsFor(key, lens));
    if (v != null && !Number.isNaN(v))
      return { value: v, source: "office", overridden: true, edited: true };
  }
  if (!(edit && "reset" in edit)) {
    const own = resolveOfficeValue(rows, ref, office, on);
    if (own?.source === "office") {
      const dflt = resolveOfficeValue(rows, ref, null, on);
      return {
        value: own.value,
        source: "office",
        overridden: true,
        edited: false,
        olderThanDefault: !!dflt && dflt.effective_from > own.effective_from,
      };
    }
  }
  const d = defaultValue();
  return {
    value: d?.value ?? null,
    source: d ? "default" : "none",
    overridden: false,
    edited: !!edit,
  };
}

export type RateProblems = ReadonlyMap<string, string>;

export function validateRatesDraft(draft: RatesDraft, lens: MoneyLens = RATE_LENS): RateProblems {
  const p = new Map<string, string>();
  for (const [k, e] of Object.entries(draft.cells)) {
    if (!("value" in e)) continue;
    const d = decimalsFor(k.slice(0, k.lastIndexOf("|")), lens);
    const v = parseMoney(e.value, d);
    if (Number.isNaN(v))
      p.set(
        k,
        d > 2
          ? "A per-day figure, 0 or more, up to 4 decimals — like 3.3333."
          : "Dollars and cents, 0 or more — like 88 or 108.48.",
      );
    else if (v == null && k.endsWith("|default"))
      p.set(k, "The company default needs a rate. Leave it as it was to keep it.");
    else if (v == null) p.set(k, "Enter a rate, or use Reset to go back to the default.");
  }
  return p;
}

// --------------------------------------------------------------- completeness

export type Completeness = {
  /** Live (active, not archived) items that bill at a rate. */
  priced: number;
  total: number;
  missing: string[];
  byCategory: Record<TmRateCategory, { total: number; missing: number }>;
  overrides: number;
};

/** Live items with no rate at an office (null = the company default itself). */
export function completeness(
  items: readonly RateItem[],
  rows: readonly MoneyValueRow[],
  draft: RatesDraft,
  office: Scope,
  on: string,
  lens: MoneyLens = RATE_LENS,
): Completeness {
  const byCategory = Object.fromEntries(
    TM_RATE_CATEGORIES.map((c) => [c, { total: 0, missing: 0 }]),
  ) as Completeness["byCategory"];
  const missing: string[] = [];
  let overrides = 0;
  const live = items.filter((i) => i.active && !i.archived);
  for (const i of live) {
    const c = cellFor(rows, draft, i.key, office, on, lens);
    byCategory[i.category].total++;
    if (c.value == null) {
      byCategory[i.category].missing++;
      missing.push(i.key);
    }
    if (c.overridden) overrides++;
  }
  return {
    priced: live.length - missing.length,
    total: live.length,
    missing,
    byCategory,
    overrides,
  };
}

// --------------------------------------------------------------------- save

/**
 * The draft as tm_rates_save's changes. `alsoOffices` copies each office-level
 * edit to more offices; `resetOverrides` (company-default edits) also resets
 * every office that overrides that item.
 */
export function ratesDraftToChanges(
  draft: RatesDraft,
  rows: readonly MoneyValueRow[],
  opts: {
    /** "" = the server's today. */
    effectiveFrom: string;
    /** The day overrides are looked up on (default: effectiveFrom). */
    asOf?: string;
    alsoOffices?: readonly string[];
    resetOverrides?: boolean;
    /** Default: the T&M rates (op "rate"); the Cost tab sends op "cost". */
    lens?: MoneyLens;
  },
): Record<string, unknown>[] {
  const lens = opts.lens ?? RATE_LENS;
  const op = lens.book === "cost" ? "cost" : "rate";
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const push = (key: string, office: Scope, value: number | null) => {
    const id = cellKey(key, office);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      op,
      item_key: key,
      office_id: office,
      value,
      effective_from: opts.effectiveFrom,
    });
  };
  for (const id of Object.keys(draft.cells).sort()) {
    const e = draft.cells[id]!;
    const [key, scope] = [id.slice(0, id.lastIndexOf("|")), id.slice(id.lastIndexOf("|") + 1)];
    const office = scope === "default" ? null : scope;
    const value = "reset" in e ? null : parseMoney(e.value, decimalsFor(key, lens));
    push(key, office, value);
    if (office) for (const o of opts.alsoOffices ?? []) if (o !== office) push(key, o, value);
    if (!office && opts.resetOverrides) {
      for (const o of officesOverriding(rows, key, opts.asOf ?? opts.effectiveFrom, lens))
        push(key, o, null);
    }
  }
  for (const code of Object.keys(draft.smallTools).sort()) {
    out.push({ op: "small_tools", code, on: draft.smallTools[code] });
  }
  return out;
}

/** Offices whose own rate for an item is in force on a date. */
export function officesOverriding(
  rows: readonly MoneyValueRow[],
  key: string,
  on: string,
  lens: MoneyLens = RATE_LENS,
): string[] {
  const offices = new Set(
    rows.filter((r) => r.item_key === key && r.office_id).map((r) => r.office_id!),
  );
  return [...offices].filter(
    (o) => resolveOfficeValue(rows, { ...lens, item_key: key }, o, on)?.source === "office",
  );
}

/** (rate − cost) / rate, as a percent to one decimal; null when either is missing or rate is 0. */
export function marginPercent(rate: number | null, cost: number | null | undefined): number | null {
  if (rate == null || cost == null || !(rate > 0)) return null;
  return Math.round(((rate - cost) / rate) * 1000) / 10;
}

// --------------------------------------------------------------- the loaders

const db = () => supabase as unknown as SupabaseClient;

type TmCodeRow = {
  code: string;
  label: string;
  section: string;
  unit_note: string | null;
  sort_order: number;
  active: boolean;
  unit: string | null;
  small_tools: boolean | null;
  equipment_type?: string | null;
  equipment_type_review?: string | null;
};

export type TmRatesData = {
  /** False until the lens's migration (20261030120000 rates, 20261031120000 costs). */
  available: boolean;
  items: RateItem[];
  /** The lens's own values. */
  rows: MoneyValueRow[];
  /**
   * The other side, read only: costs beside the rates, rates beside the
   * costs. null when the caller may not see costs.
   */
  otherRows: MoneyValueRow[] | null;
  offices: Office[];
  lastChange: string | null;
  /**
   * Cost lens: whether the overhead engine has ever written a labor cost.
   * Until it has, field labor shows the carried-over values (P4 answer 1).
   */
  enginePublished?: boolean;
};

/** The other side's value for one item at an office, for the read-only column and margin. */
export function otherValue(
  data: Pick<TmRatesData, "otherRows">,
  lens: MoneyLens,
  key: string,
  office: Scope,
  on: string,
): number | null | undefined {
  if (!data.otherRows) return undefined;
  const other = lens.book === "cost" ? RATE_LENS : COST_LENS;
  return resolveOfficeValue(data.otherRows, { ...other, item_key: key }, office, on)?.value ?? null;
}

const TM_UNIT_LABEL: Record<string, string> = {
  hr: "per hour",
  day: "per day",
  each: "per unit",
  pct: "% of labor",
  person_day: "per person-day",
};

export function buildRateItems(
  catalog: readonly CatalogItem[],
  codes: readonly TmCodeRow[],
  types: readonly { key: string; label: string; active: boolean; sort_order: number }[],
): RateItem[] {
  const out: RateItem[] = [];
  const byCode = new Map(codes.map((c) => [c.code, c]));
  for (const i of [...catalog].sort((a, b) => a.sort_order - b.sort_order)) {
    // Regular-only items (prompt 4) are not on the T&M sheet.
    if (i.in_tm === false || !(TM_RATE_CATEGORIES as readonly string[]).includes(i.category))
      continue;
    const t = byCode.get(i.code);
    out.push({
      key: i.code,
      code: i.code,
      name: i.name,
      category: i.category as TmRateCategory,
      unitLabel: i.unit ? CATALOG_UNIT_LABEL[i.unit as CatalogUnit] : null,
      active: i.active,
      archived: i.archived_at != null,
      smallTools: i.category === "labor" ? t?.small_tools !== false : undefined,
      laborClass:
        i.category === "labor"
          ? (i.labor_class ?? (t?.small_tools === false ? "management" : "field"))
          : undefined,
      note: i.note ?? null,
    });
  }
  for (const t of [...types].sort((a, b) => a.sort_order - b.sort_order)) {
    out.push({
      key: `EQ:${t.key}`,
      code: t.label,
      name: `${t.label} — scanned units`,
      category: "equipment",
      unitLabel: "per unit-day",
      active: t.active,
      archived: false,
      equipment: { kind: "type" },
    });
  }
  for (const c of [...codes].sort((a, b) => a.sort_order - b.sort_order)) {
    if (c.section === "equipment") {
      out.push({
        key: c.code,
        code: c.code,
        name: c.label,
        category: "equipment",
        unitLabel: c.unit ? (TM_UNIT_LABEL[c.unit] ?? c.unit) : null,
        active: c.active,
        archived: false,
        equipment: {
          kind: "code",
          type: c.equipment_type ?? null,
          review: c.equipment_type_review ?? null,
        },
        note: c.unit_note,
      });
    } else if (c.section === "general" && !RULE_PRICED_CODES.has(c.code)) {
      out.push({
        key: c.code,
        code: "—",
        name: c.label,
        category: "general",
        unitLabel:
          c.code === "GEN-HOTEL" || c.code === "GEN-DEBRIS"
            ? "per unit (blank = receipt $)"
            : "per unit",
        active: c.active,
        archived: false,
        note: c.unit_note,
      });
    }
  }
  return out;
}

const toRows = (data: unknown): MoneyValueRow[] =>
  ((data ?? []) as (MoneyValueRow & { value: number | string | null })[]).map((r) => ({
    ...r,
    value: r.value == null ? null : Number(r.value),
  }));

/**
 * One grid's data. `seeCosts`: the caller holds a cost role (the database
 * enforces it either way; this only decides whether "no rows" means "none
 * entered" or "not yours to see").
 */
export async function loadTmRates(
  opts: { lens?: MoneyLens; seeCosts?: boolean } = {},
  client: SupabaseClient = db(),
): Promise<TmRatesData> {
  const lens = opts.lens ?? RATE_LENS;
  const seeCosts = opts.seeCosts ?? lens.book === "cost";
  const values = (l: MoneyLens) =>
    client
      .from("money_values")
      .select("book, item_key, measure, office_id, effective_from, value")
      .eq("book", l.book)
      .eq("measure", l.measure);
  const other = lens.book === "cost" ? RATE_LENS : COST_LENS;
  const [catalog, codesQ, typesQ, rowsQ, otherQ, p3Q, officesQ, lastQ] = await Promise.all([
    loadCatalog(client),
    // The sheet from Catalogs (20261102120000), else the old book.
    client
      .from("tm_sheet_codes")
      .select(
        "code, label, section, unit_note, sort_order, active, unit, small_tools, equipment_type, equipment_type_review",
      )
      .then((r) =>
        r.error
          ? client
              .from("tm_rate_codes")
              .select(
                "code, label, section, unit_note, sort_order, active, unit, small_tools, equipment_type, equipment_type_review",
              )
          : r,
      ),
    client.from("equipment_types").select("key, label, active, sort_order"),
    values(lens),
    seeCosts || lens.book === "cost" ? values(other) : Promise.resolve({ data: null, error: null }),
    // The Cost store exists from 20261031120000; before it costs are the old column.
    client.from("overhead_components").select("key").limit(1),
    client.from("locations").select("id, name, code, active").order("name"),
    client
      .from("money_audit_log")
      .select("changed_at")
      .eq("book", lens.book)
      .order("changed_at", { ascending: false })
      .limit(1),
  ]);
  const p3 = !(p3Q.error && isMissingSchema(p3Q.error));
  const published =
    lens.book === "cost" && p3
      ? await client
          .from("money_values")
          .select("id")
          .eq("book", "cost")
          .eq("note", "Overhead engine")
          .limit(1)
      : null;
  const empty = {
    available: false,
    items: [],
    rows: [],
    otherRows: null,
    offices: [],
    lastChange: null,
  };
  if (lens.book === "cost" && !p3) return empty;
  for (const e of [codesQ.error, typesQ.error, rowsQ.error]) {
    if (e && isMissingSchema(e)) return empty;
    if (e) throw e;
  }
  if (officesQ.error) throw officesQ.error;
  let otherRows: MoneyValueRow[] | null = null;
  if (lens.book === "cost") otherRows = otherQ.error ? null : toRows(otherQ.data);
  else if (seeCosts && p3) otherRows = otherQ.error ? null : toRows(otherQ.data);
  else if (seeCosts) {
    // Before the Cost store: each code's single cost, as a default row.
    const legacy = await client.rpc("tm_rate_code_costs" as never);
    otherRows = legacy.error
      ? null
      : ((legacy.data ?? []) as { code: string; cost_rate: number | string | null }[])
          .filter((r) => r.cost_rate != null)
          .map((r) => ({
            ...COST_LENS,
            item_key: r.code,
            office_id: null,
            effective_from: "2000-01-01",
            value: Number(r.cost_rate),
          }));
  }
  return {
    available: true,
    items: buildRateItems(
      catalog.items,
      (codesQ.data ?? []) as TmCodeRow[],
      (typesQ.data ?? []) as { key: string; label: string; active: boolean; sort_order: number }[],
    ),
    rows: toRows(rowsQ.data),
    otherRows,
    offices: ((officesQ.data ?? []) as (Office & { active: boolean })[])
      .filter((o) => o.active)
      .map(({ id, name, code }) => ({ id, name, code })),
    lastChange: ((lastQ.data ?? []) as { changed_at: string }[])[0]?.changed_at ?? null,
    enginePublished: published ? !published.error && (published.data ?? []).length > 0 : undefined,
  };
}

export async function saveTmRates(
  changes: readonly Record<string, unknown>[],
  note: string,
  client: SupabaseClient = db(),
  rpc: "tm_rates_save" | "cost_save" = "tm_rates_save",
): Promise<number> {
  const { data, error } = await client.rpc(
    rpc as never,
    {
      _changes: changes,
      _note: note.trim() || null,
    } as never,
  );
  if (error) throw error;
  return Number(data ?? 0);
}
