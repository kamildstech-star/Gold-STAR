/**
 * BILLING & COSTS › AUDIT (prompt 3) — the money audit log made readable: one
 * item's history behind a clock icon, and the tab-level Change log with
 * filters and a CSV export.
 *
 * Reads money_audit_log only (append-only, written by triggers). Who sees
 * what is the database's rule (20261031120000): cost entries the cost roles,
 * overhead entries owner and admin, the rest administrators. This file never
 * widens it; an entry the caller may not read simply is not returned.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { formatDateTimeUS } from "@/lib/date-format";
import { toCsv, type CsvColumn } from "@/lib/reports";
import { isMissingSchema } from "@/lib/schema-fallback";

export const AUDIT_BOOKS = ["general_rules", "tm_rates", "cost", "overhead", "catalog"] as const;
export type AuditBook = (typeof AUDIT_BOOKS)[number] | "client_agreements";

export const AUDIT_BOOK_LABEL: Record<AuditBook, string> = {
  general_rules: "Rules",
  tm_rates: "T&M",
  cost: "Cost",
  overhead: "Overhead",
  catalog: "Catalog",
  client_agreements: "Client agreements",
};

export type AuditEntry = {
  id: number;
  changed_at: string;
  changed_by: string | null;
  book: AuditBook;
  entity: string;
  entity_key: string;
  field: string;
  old_value: unknown;
  new_value: unknown;
  office_id: string | null;
  note: string | null;
};

const COLUMNS =
  "id, changed_at, changed_by, book, entity, entity_key, field, old_value, new_value, office_id, note";

const db = () => supabase as unknown as SupabaseClient;

/** A dated money value's change reads as its value; anything else as itself. */
export function auditValue(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "object" && v !== null && "value" in v) {
    const o = v as { value: number | null; effective_from?: string };
    const val = o.value == null ? "back to default" : `$${Number(o.value).toFixed(2)}`;
    return o.effective_from ? `${val} from ${o.effective_from}` : val;
  }
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "yes" : "no";
  return JSON.stringify(v);
}

/* ---------------------------------------------------- record changes, read */

/** The audit log's column names in a person's words. */
const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  code: "Code",
  unit: "Unit",
  uom: "Unit",
  category: "Category",
  active: "Active",
  archived: "Archived",
  archived_at: "Archived on",
  sort_order: "Sheet order",
  note: "How it bills",
  description: "Description",
  labor_class: "Labor class",
  in_tm: "On the T&M sheet",
  in_regular: "Priced on regular jobs",
  small_tools: "Small Tools",
  equipment_type: "Equipment type",
  section: "Section",
  label: "Label",
  value: "Value",
  effective_from: "Takes effect",
  effective_to: "Ends",
  rate: "Rate",
  price: "Price",
  unit_price: "Price",
  cost: "Cost",
  percent: "Percent",
};
const humanize = (k: string) =>
  FIELD_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, " ");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** A dated money value ({ value, effective_from }) — auditValue already reads it. */
const isMoneyValue = (v: unknown) => isRecord(v) && "value" in v && Object.keys(v).length <= 3;

/** One field's value as a person reads it. */
export function auditFieldValue(key: string, v: unknown): string {
  if (v == null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number" && /rate|price|cost|amount|value/.test(key)) return `$${v.toFixed(2)}`;
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (/_at$/.test(key) && !Number.isNaN(Date.parse(v))) return formatDateTimeUS(v);
    // Short enum-like words (equipment, field, day) read better capitalised.
    return /^[a-z][a-z_]*$/.test(v) ? humanize(v) : v;
  }
  if (Array.isArray(v)) return v.map((x) => auditFieldValue(key, x)).join(", ") || "—";
  return JSON.stringify(v);
}

export type AuditField = { key: string; label: string; old: string; new: string; changed: boolean };

/**
 * A record change (a catalog item created, an agreement edited) field by
 * field, changed fields first. null for a single value (a rate, a toggle) —
 * auditValue reads those.
 */
export function auditFields(e: Pick<AuditEntry, "old_value" | "new_value">): AuditField[] | null {
  const o = e.old_value;
  const n = e.new_value;
  if (!isRecord(o) && !isRecord(n)) return null;
  if (isMoneyValue(o) || isMoneyValue(n)) return null;
  const before = isRecord(o) ? o : {};
  const after = isRecord(n) ? n : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const rows = keys.map((key) => {
    const a = auditFieldValue(key, before[key]);
    const b = auditFieldValue(key, after[key]);
    return { key, label: humanize(key), old: a, new: b, changed: a !== b };
  });
  return [...rows.filter((r) => r.changed), ...rows.filter((r) => !r.changed)];
}

/** What kind of change: a record added, removed, or edited; or one value set. */
export function auditKind(
  e: Pick<AuditEntry, "old_value" | "new_value" | "field">,
): "added" | "removed" | "changed" {
  if (e.field === "created" || (e.old_value == null && e.new_value != null)) return "added";
  if (e.field === "deleted" || (e.new_value == null && e.old_value != null)) return "removed";
  return "changed";
}

/**
 * One line for the change log: a record's name and its key facts, or which
 * fields moved; a single value as before → after.
 */
export function auditSummary(e: Pick<AuditEntry, "old_value" | "new_value" | "field">): string {
  const fields = auditFields(e);
  if (!fields) return `${auditValue(e.old_value)} → ${auditValue(e.new_value)}`;
  const kind = auditKind(e);
  if (kind !== "changed") {
    const rec = (kind === "added" ? e.new_value : e.old_value) as Record<string, unknown>;
    const title = typeof rec.name === "string" ? rec.name : null;
    const facts = fields
      .filter((f) => f.key !== "name" && ["unit", "uom", "category", "active"].includes(f.key))
      .map((f) => {
        const v = kind === "added" ? f.new : f.old;
        return f.key === "active" ? (v === "Yes" ? "Active" : "Inactive") : v;
      })
      .filter((v) => v !== "—");
    return [title, ...facts].filter(Boolean).join(" · ") || `${fields.length} fields`;
  }
  const moved = fields.filter((f) => f.changed);
  if (moved.length === 0) return "No visible change";
  const first = moved
    .slice(0, 2)
    .map((f) => `${f.label}: ${f.old} → ${f.new}`)
    .join(" · ");
  return moved.length > 2 ? `${first} · +${moved.length - 2} more` : first;
}

/** "money_value / cost_rate" → a person's words. */
export function auditWhat(e: Pick<AuditEntry, "entity" | "field">): string {
  if (e.entity === "money_value") {
    return (
      (
        {
          bill_rate: "Rate",
          cost_rate: "Cost",
          cost_hr: "Cost per field hour",
        } as Record<string, string>
      )[e.field] ?? e.field
    );
  }
  const verb = (
    { created: "added", deleted: "removed", updated: "edited" } as Record<string, string>
  )[e.field];
  const entity = e.entity.replace(/_/g, " ");
  if (verb) return `${entity.charAt(0).toUpperCase()}${entity.slice(1)} ${verb}`;
  return `${entity}: ${e.field.replace(/_/g, " ")}`;
}

/** One item's history, newest first (the clock icon on a row). */
export async function loadItemHistory(
  q: { book: AuditBook; key: string; office?: string | null },
  client: SupabaseClient = db(),
): Promise<AuditEntry[]> {
  let query = client
    .from("money_audit_log")
    .select(COLUMNS)
    .eq("book", q.book)
    .eq("entity_key", q.key)
    .order("changed_at", { ascending: false })
    .limit(200);
  if (q.office !== undefined) {
    query = q.office === null ? query.is("office_id", null) : query.eq("office_id", q.office);
  }
  const { data, error } = await query;
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []) as AuditEntry[];
}

export type ChangeLogFilter = {
  person?: string | null;
  /** YYYY-MM-DD, inclusive. */
  from?: string | null;
  to?: string | null;
  books?: readonly AuditBook[];
  /** "default" = company-wide entries only. */
  office?: string | null;
};

export const CHANGE_LOG_LIMIT = 1000;

export async function loadChangeLog(
  f: ChangeLogFilter,
  client: SupabaseClient = db(),
): Promise<{ entries: AuditEntry[]; truncated: boolean }> {
  let q = client
    .from("money_audit_log")
    .select(COLUMNS)
    .order("changed_at", { ascending: false })
    .limit(CHANGE_LOG_LIMIT + 1);
  if (f.person) q = q.eq("changed_by", f.person);
  if (f.from) q = q.gte("changed_at", `${f.from}T00:00:00`);
  if (f.to) q = q.lte("changed_at", `${f.to}T23:59:59.999`);
  if (f.books?.length) q = q.in("book", [...f.books]);
  if (f.office === "default") q = q.is("office_id", null);
  else if (f.office) q = q.eq("office_id", f.office);
  const { data, error } = await q;
  if (error) {
    if (isMissingSchema(error)) return { entries: [], truncated: false };
    throw error;
  }
  const rows = (data ?? []) as AuditEntry[];
  return { entries: rows.slice(0, CHANGE_LOG_LIMIT), truncated: rows.length > CHANGE_LOG_LIMIT };
}

/** Names for the people in a log (falls back to "Someone" where unreadable). */
export async function loadPeople(
  ids: readonly string[],
  client: SupabaseClient = db(),
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data } = await client
    .from("profiles")
    .select("user_id, full_name, email")
    .in("user_id", unique);
  return new Map(
    ((data ?? []) as { user_id: string; full_name: string | null; email: string | null }[]).map(
      (p) => [p.user_id, p.full_name || p.email || "Someone"],
    ),
  );
}

export function changeLogCsv(
  entries: readonly AuditEntry[],
  people: ReadonlyMap<string, string>,
  offices: ReadonlyMap<string, string>,
): string {
  const columns: CsvColumn<AuditEntry>[] = [
    { key: "when", label: "When", get: (e) => formatDateTimeUS(e.changed_at) },
    {
      key: "who",
      label: "Who",
      get: (e) => (e.changed_by ? (people.get(e.changed_by) ?? "Someone") : "System"),
    },
    { key: "book", label: "Book", get: (e) => AUDIT_BOOK_LABEL[e.book] ?? e.book },
    { key: "item", label: "Item", get: (e) => e.entity_key },
    { key: "what", label: "What", get: (e) => auditWhat(e) },
    { key: "old", label: "Old", get: (e) => auditValue(e.old_value) },
    { key: "new", label: "New", get: (e) => auditValue(e.new_value) },
    {
      key: "office",
      label: "Office",
      get: (e) => (e.office_id ? (offices.get(e.office_id) ?? e.office_id) : "Company default"),
    },
    { key: "note", label: "Note", get: (e) => e.note ?? "" },
  ];
  return toCsv([...entries], columns);
}
