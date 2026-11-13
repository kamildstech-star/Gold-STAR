/**
 * BILLING & COSTS › CATALOGS — the single home for items (prompt 1 of 5).
 *
 * Labor, General Consumables, PPE and Vehicle lines, in `catalog_items`
 * (migration 20261029120000), seeded line for line from the T&M rate codes.
 * Equipment types are not here — they belong to the Equipment module — and
 * the General Charges (Small Tools, Per Diem, O&P…) are rules, for the
 * General rules tab.
 *
 * What an item is decides what may change:
 *  - the CODE is the key a filled T&M sheet stores, so it never changes;
 *  - an item is ARCHIVED, never deleted, and the screen says how many jobs
 *    carry it first;
 *  - two items may not share a name (case and spacing ignored);
 *  - every item has a UNIT that fits its category. The seed took a unit from
 *    the line's own words where it said one and flagged the rest for review;
 *    nothing here defaults one.
 *
 * Saving is explicit: edits collect in a draft and go in one `catalog_save`
 * call (one transaction, one note, one audit entry per field). The database
 * repeats every rule here, so this file decides nothing the server would not.
 * Until the T&M Rates tab ships, a save also reaches the old T&M rate codes
 * book through the migration's mirror triggers — the T&M pickers see a new or
 * archived item at once. No price or cost lives in the catalog.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * One catalog for both books (prompt 5): the T&M Daily Supply List (in_tm —
 * Labor, Consumables, PPE, Vehicle, its Equipment codes and Supply-list
 * charges) and regular pricing (in_regular — the merged Estimate catalog,
 * Equipment and Services). An Equipment item may be on either or both.
 */
export const CATALOG_CATEGORIES = [
  "labor",
  "consumable",
  "ppe",
  "vehicle",
  "equipment",
  "general",
  "service",
] as const;
export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];
/** The categories the T&M sheet (and T&M Rates / Cost) carries. */
export const TM_CATALOG_CATEGORIES = ["labor", "consumable", "ppe", "vehicle"] as const;

export const CATALOG_CATEGORY_LABEL: Readonly<Record<CatalogCategory, string>> = {
  labor: "Labor",
  consumable: "General Consumables",
  ppe: "PPE",
  vehicle: "Vehicle lines",
  equipment: "Equipment",
  general: "Supply-list charges",
  service: "Services",
};

export const CATALOG_UNITS = ["hr", "day", "piece", "roll", "box", "pair", "gal", "sqft"] as const;
export type CatalogUnit = (typeof CATALOG_UNITS)[number];

export const CATALOG_UNIT_LABEL: Readonly<Record<CatalogUnit, string>> = {
  hr: "per hour",
  day: "per day",
  piece: "per piece",
  roll: "per roll",
  box: "per box",
  pair: "per pair",
  gal: "per gallon",
  sqft: "per sq ft",
};

/** The same lists as the table's catalog_items_unit_fits_category CHECK. */
export const UNITS_BY_CATEGORY: Readonly<Record<CatalogCategory, readonly CatalogUnit[]>> = {
  labor: ["hr", "day"],
  consumable: ["piece", "roll", "box", "pair", "gal", "sqft"],
  ppe: ["piece", "box", "pair", "day"],
  vehicle: ["day", "hr"],
  equipment: CATALOG_UNITS,
  general: CATALOG_UNITS,
  service: CATALOG_UNITS,
};

export type CatalogItem = {
  code: string;
  name: string;
  category: CatalogCategory;
  unit: CatalogUnit | null;
  /** Why the unit needs a person to look at it; null = confirmed. */
  unit_review: string | null;
  /** How it bills, in words — the item's description / tooltip. */
  note?: string | null;
  /** Labor only: field = cost from the overhead engine; management = typed (20261031120000). */
  labor_class?: "field" | "management" | null;
  /** On the T&M sheet / priced on regular jobs (20261101120000); absent before. */
  in_tm?: boolean | null;
  in_regular?: boolean | null;
  active: boolean;
  archived_at: string | null;
  sort_order: number;
  updated_at: string;
};

export const CATALOG_COLUMNS =
  "code, name, category, unit, unit_review, note, labor_class, in_tm, in_regular, active, archived_at, sort_order, updated_at";
/** Older databases, newest first: before 20261101120000 (no books), 20261031120000 (no labor_class), 20261030120000 (no note). */
const CATALOG_COLUMNS_OLDER = [
  "code, name, category, unit, unit_review, note, labor_class, active, archived_at, sort_order, updated_at",
  "code, name, category, unit, unit_review, note, active, archived_at, sort_order, updated_at",
  "code, name, category, unit, unit_review, active, archived_at, sort_order, updated_at",
];

export type CatalogStatus = "active" | "inactive" | "archived";

export function statusOf(item: Pick<CatalogItem, "active" | "archived_at">): CatalogStatus {
  if (item.archived_at) return "archived";
  return item.active ? "active" : "inactive";
}

/** What two names are compared as: case, outer and repeated spaces ignored. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Codes are typed the way the T&M paper prints them. */
export function normaliseCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidCode(code: string): boolean {
  return /^[A-Z0-9][A-Z0-9-]{0,23}$/.test(code);
}

export function unitFits(category: CatalogCategory, unit: string | null): unit is CatalogUnit {
  return unit !== null && (UNITS_BY_CATEGORY[category] as readonly string[]).includes(unit);
}

// ----------------------------------------------------------------- the draft

/** Pending changes to one existing item. Absent keys are unchanged. */
export type CatalogEdit = {
  name?: string;
  note?: string;
  unit?: CatalogUnit | null;
  active?: boolean;
  archived?: boolean;
  /** Set a flagged unit as confirmed without changing it. */
  confirmUnit?: boolean;
};

export type NewCatalogItem = {
  /** Local only, for React keys and error lookup. */
  tempId: string;
  category: CatalogCategory;
  code: string;
  name: string;
  unit: CatalogUnit | null;
  /** Equipment only: put it on the T&M sheet too (default: regular pricing only). */
  inTm?: boolean;
};

export type CatalogDraft = {
  edits: Readonly<Record<string, CatalogEdit>>;
  creates: readonly NewCatalogItem[];
};

export const EMPTY_DRAFT: CatalogDraft = { edits: {}, creates: [] };

/** An item as it will be once the draft is saved. */
export function applyEdit(item: CatalogItem, edit: CatalogEdit | undefined): CatalogItem {
  if (!edit) return item;
  const unitSet = "unit" in edit && edit.unit !== undefined;
  return {
    ...item,
    name: edit.name ?? item.name,
    note: edit.note !== undefined ? edit.note : item.note,
    unit: unitSet ? (edit.unit ?? null) : item.unit,
    unit_review:
      (unitSet && edit.unit) || (edit.confirmUnit && item.unit) ? null : item.unit_review,
    active: edit.active ?? item.active,
    archived_at:
      edit.archived === undefined
        ? item.archived_at
        : edit.archived
          ? (item.archived_at ?? "pending")
          : null,
  };
}

/**
 * Drop the parts of an edit that equal the saved row, so undoing a change by
 * hand leaves nothing pending. Returns undefined when nothing is left.
 */
export function pruneEdit(item: CatalogItem, edit: CatalogEdit): CatalogEdit | undefined {
  const out: CatalogEdit = {};
  if (edit.name !== undefined && edit.name !== item.name) out.name = edit.name;
  if (edit.note !== undefined && edit.note.trim() !== (item.note ?? "")) out.note = edit.note;
  if (edit.unit !== undefined && (edit.unit !== item.unit || item.unit_review !== null)) {
    out.unit = edit.unit;
  }
  if (edit.confirmUnit && item.unit_review !== null && item.unit) out.confirmUnit = true;
  if (edit.active !== undefined && edit.active !== item.active) out.active = edit.active;
  if (edit.archived !== undefined && edit.archived !== (item.archived_at !== null)) {
    out.archived = edit.archived;
  }
  return Object.keys(out).length ? out : undefined;
}

export function draftSize(draft: CatalogDraft): number {
  return Object.keys(draft.edits).length + draft.creates.length;
}

/** The `_changes` argument of catalog_save, in a stable order. */
export function draftToChanges(
  items: readonly CatalogItem[],
  draft: CatalogDraft,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const c of draft.creates) {
    out.push({
      op: "create",
      code: normaliseCode(c.code),
      name: c.name.trim(),
      category: c.category,
      unit: c.unit,
      ...(c.category === "equipment" ? { in_tm: !!c.inTm } : {}),
    });
  }
  const byCode = new Map(items.map((i) => [i.code, i]));
  for (const code of Object.keys(draft.edits).sort()) {
    const item = byCode.get(code);
    const edit = item && pruneEdit(item, draft.edits[code]!);
    if (!item || !edit) continue;
    const change: Record<string, unknown> = { op: "update", code };
    if (edit.name !== undefined) change.name = edit.name.trim();
    if (edit.note !== undefined) change.note = edit.note.trim() || null;
    if (edit.unit !== undefined) change.unit = edit.unit;
    else if (edit.confirmUnit) change.unit = item.unit;
    if (edit.active !== undefined) change.active = edit.active;
    if (edit.archived !== undefined) change.archived = edit.archived;
    out.push(change);
  }
  return out;
}

// ---------------------------------------------------------------- validation

export type FieldProblem = {
  field: "code" | "name" | "unit";
  message: string;
  /** For a duplicate name: the code of the item that already has it. */
  clashCode?: string;
};

/** Problems keyed by item code, or by tempId for a new item. They block Save. */
export type DraftProblems = ReadonlyMap<string, FieldProblem[]>;

/**
 * Everything the database would refuse, said first and in plain words. Only
 * items the draft touches are checked: a seeded item with a flagged unit is a
 * warning to work through, not a reason to block an unrelated save.
 */
export function validateDraft(
  items: readonly CatalogItem[],
  draft: CatalogDraft,
  /** Every code the old T&M book holds, with its section, to catch reuse. */
  tmCodes: ReadonlyMap<string, string> = new Map(),
): DraftProblems {
  const problems = new Map<string, FieldProblem[]>();
  const add = (key: string, p: FieldProblem) =>
    problems.set(key, [...(problems.get(key) ?? []), p]);

  const after = items.map((i) => applyEdit(i, draft.edits[i.code]));
  const byName = new Map<string, string>();
  for (const i of [...items, ...after]) {
    if (!byName.has(nameKey(i.name))) byName.set(nameKey(i.name), i.code);
  }

  const nameProblem = (name: string, selfKey: string): FieldProblem | null => {
    if (!name.trim()) return { field: "name", message: "Give the item a name." };
    if (name.trim().length > 200)
      return { field: "name", message: "Keep the name under 200 characters." };
    const clash = byName.get(nameKey(name));
    if (clash && clash !== selfKey) {
      return { field: "name", message: `"${name.trim()}" already exists.`, clashCode: clash };
    }
    return null;
  };

  for (const i of items) {
    const edit = draft.edits[i.code];
    if (!edit) continue;
    const next = applyEdit(i, edit);
    if (edit.name !== undefined) {
      // The server renames one item at a time, so a name another item holds
      // now OR will hold after this save is taken (a swap needs two saves).
      const clash =
        items.find((o) => o.code !== i.code && nameKey(o.name) === nameKey(next.name)) ??
        after.find((o) => o.code !== i.code && nameKey(o.name) === nameKey(next.name));
      if (!next.name.trim()) add(i.code, { field: "name", message: "Give the item a name." });
      else if (next.name.trim().length > 200)
        add(i.code, { field: "name", message: "Keep the name under 200 characters." });
      else if (clash)
        add(i.code, {
          field: "name",
          message: `"${next.name.trim()}" already exists.`,
          clashCode: clash.code,
        });
    }
    const touchesUnit = edit.unit !== undefined || edit.name !== undefined || edit.confirmUnit;
    if (touchesUnit && !unitFits(i.category, next.unit)) {
      add(i.code, {
        field: "unit",
        message: next.unit
          ? `${CATALOG_UNIT_LABEL[next.unit]} doesn't fit ${CATALOG_CATEGORY_LABEL[i.category]}.`
          : "Choose a unit — this item has none yet.",
      });
    }
  }

  const newCodes = new Map<string, string>();
  for (const c of draft.creates) {
    const code = normaliseCode(c.code);
    if (!code) add(c.tempId, { field: "code", message: "Give the item a code." });
    else if (!isValidCode(code))
      add(c.tempId, {
        field: "code",
        message: "Use letters, digits and dashes, as printed on the T&M sheet (e.g. APM, 157).",
      });
    else if (items.some((i) => i.code === code))
      add(c.tempId, {
        field: "code",
        message: `${code} is already in the catalog.`,
        clashCode: code,
      });
    else if (tmCodes.has(code) && tmCodes.get(code) !== c.category)
      add(c.tempId, {
        field: "code",
        message: `${code} is already a T&M rate code under ${tmCodes.get(code)}. Pick another code.`,
      });
    else if (newCodes.has(code))
      add(c.tempId, { field: "code", message: `${code} is used twice in this save.` });
    newCodes.set(code, c.tempId);

    const np = nameProblem(c.name, c.tempId);
    if (np) add(c.tempId, np);
    else {
      const twin = draft.creates.find(
        (o) => o.tempId !== c.tempId && nameKey(o.name) === nameKey(c.name),
      );
      if (twin)
        add(c.tempId, {
          field: "name",
          message: `"${c.name.trim()}" is added twice in this save.`,
        });
    }
    if (!unitFits(c.category, c.unit)) {
      add(c.tempId, { field: "unit", message: "Choose a unit." });
    }
  }
  return problems;
}

/** Things worth knowing that never block a save. */
export function itemWarnings(item: CatalogItem, usedOnJobs: number | undefined): string[] {
  const out: string[] = [];
  if (item.unit_review) out.push(item.unit_review);
  if (statusOf(item) === "archived" && usedOnJobs) {
    out.push(
      `Archived, but already on ${usedOnJobs} job${usedOnJobs === 1 ? "" : "s"}' T&M sheets — those sheets keep it.`,
    );
  }
  return out;
}

// --------------------------------------------------------------- the database

/* Not in the generated types until Lovable regenerates them after the
   migration is applied. */
const db = () => supabase as unknown as SupabaseClient;

export type CatalogLoad = {
  /** False until migration 20261029120000 is applied. */
  fromDatabase: boolean;
  items: CatalogItem[];
  /** Every T&M rate code and its section, to refuse a reused code early. */
  tmCodes: Map<string, string>;
};

export async function loadCatalog(client: SupabaseClient = db()): Promise<CatalogLoad> {
  const read = (cols: string) =>
    client
      .from("catalog_items")
      .select(cols)
      .order("category", { ascending: true })
      .order("sort_order", { ascending: true });
  const [first, tmQ] = await Promise.all([
    read(CATALOG_COLUMNS),
    // The T&M sheet, read from Catalogs since 20261102120000 (tm_rate_codes before).
    client
      .from("tm_sheet_codes")
      .select("code, section")
      .then((r) => (r.error ? client.from("tm_rate_codes").select("code, section") : r)),
  ]);
  // An older database lacks a newer column: read without it.
  let itemsQ = first;
  for (const cols of CATALOG_COLUMNS_OLDER) {
    if (!(itemsQ.error && (itemsQ.error as { code?: string }).code === "42703")) break;
    itemsQ = await read(cols);
  }
  if (itemsQ.error) {
    if (isMissingSchema(itemsQ.error))
      return { fromDatabase: false, items: [], tmCodes: new Map() };
    throw itemsQ.error;
  }
  const tmCodes = new Map(
    ((tmQ.data ?? []) as { code: string; section: string }[]).map((r) => [r.code, r.section]),
  );
  return { fromDatabase: true, items: (itemsQ.data ?? []) as unknown as CatalogItem[], tmCodes };
}

export async function saveCatalog(
  changes: readonly Record<string, unknown>[],
  note: string,
  client: SupabaseClient = db(),
): Promise<number> {
  const { data, error } = await client.rpc("catalog_save", {
    _changes: changes,
    _note: note.trim() || null,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

/** Distinct jobs whose T&M sheets carry each code. Administrators only. */
export async function loadCatalogUsage(
  codes: readonly string[],
  client: SupabaseClient = db(),
): Promise<Map<string, number>> {
  if (!codes.length) return new Map();
  const { data, error } = await client.rpc("catalog_item_usage", { _codes: codes });
  if (error) throw error;
  return new Map(
    ((data ?? []) as { code: string; jobs: number | string }[]).map((r) => [
      r.code,
      Number(r.jobs),
    ]),
  );
}

/** The other item a refused save collided with, from the server's DETAIL. */
export function duplicateFromError(err: unknown): string | null {
  const detail =
    (err as { details?: string; detail?: string } | null)?.details ??
    (err as { detail?: string } | null)?.detail;
  const m = /catalog_duplicate_name:([A-Z0-9-]+)/.exec(detail ?? "");
  return m ? m[1]! : null;
}
