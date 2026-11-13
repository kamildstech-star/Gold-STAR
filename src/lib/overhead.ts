/**
 * BILLING & COSTS › COST › OVERHEAD ENGINE (prompt 3) — what a field-labor
 * hour really costs Gold Star, built from parts.
 *
 * Components (Wage, General liability, Workers' comp, and any added one) each
 * hold a dollars-per-hour value per office or company default, dated, never
 * edited (money_values book overhead, measure cost_hr). Their sum at an
 * office on a day is the true cost per field-labor hour. Every publish writes
 * that sum onto every FIELD labor code's cost from its date (the database's
 * overhead_fill), so the Cost tab and job costing read stored, dated values.
 *
 * Owner and admin only — the database answers nobody else.
 *
 * This file is the TypeScript twin of public.overhead_total() for the screen
 * (the live figure, the breakdown, the year-over-year view). All sums are in
 * integer cents.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { fromCents, toCents } from "@/lib/money";
import { resolveOfficeValue, type MoneyValueRow } from "@/lib/office-values";
import { isMissingSchema } from "@/lib/schema-fallback";

export type OverheadComponent = {
  key: string;
  name: string;
  note: string | null;
  system: boolean;
  sort_order: number;
  archived_at: string | null;
  /** The unit it is entered in (20261104120000); absent before it = hour. */
  unit_key?: string;
};

/**
 * A unit a component can be entered in, and the field-labor hours it covers
 * (20261104120000). The value is stored per hour: amount / hours, to the cent,
 * worked out by overhead_save; the amount as typed is kept beside it.
 */
export type OverheadUnit = {
  key: string;
  name: string;
  hours: number;
  system: boolean;
  sort_order: number;
};

export const HOUR_UNIT: OverheadUnit = {
  key: "hour",
  name: "Hour",
  hours: 1,
  system: true,
  sort_order: 10,
};

export const unitOf = (
  units: readonly OverheadUnit[],
  c: Pick<OverheadComponent, "unit_key"> | undefined,
): OverheadUnit => units.find((u) => u.key === (c?.unit_key ?? "hour")) ?? HOUR_UNIT;

/** The $/hour an amount in a unit comes to — the database's round(amount / hours, 2). */
export const perHour = (amount: number, unit: Pick<OverheadUnit, "hours">): number =>
  fromCents(Math.round(toCents(amount) / unit.hours));

/** The measure the typed amount is kept under, beside cost_hr. */
export const amountMeasure = (unitKey: string) => `amount_${unitKey}`;

/**
 * What to show in a component's box at an office on a day, in its unit: the
 * amount as typed when it was saved in this unit, else the $/hour × hours
 * (a value saved per hour, or before the unit changed). null = no value.
 */
export function typedAmount(
  rows: readonly MoneyValueRow[],
  component: string,
  unit: OverheadUnit,
  office: string | null,
  on: string,
): { amount: number; source: "office" | "default"; exact: boolean } | null {
  const r = resolveOfficeValue(rows, { ...OVERHEAD_LENS, item_key: component }, office, on);
  if (!r || r.value == null) return null;
  const source = r.source;
  if (unit.key === "hour") return { amount: r.value, source, exact: true };
  const scope = source === "office" ? office : null;
  const typed = rows.find(
    (x) =>
      x.book === "overhead" &&
      x.item_key === component &&
      x.measure === amountMeasure(unit.key) &&
      (x.office_id ?? null) === scope &&
      x.effective_from === r.effective_from,
  );
  return typed?.value != null
    ? { amount: typed.value, source, exact: true }
    : { amount: fromCents(toCents(r.value) * unit.hours), source, exact: false };
}

export const OVERHEAD_LENS = { book: "overhead", measure: "cost_hr" } as const;

/**
 * Vehicle finance, insurance and maintenance (5 Nov, T9; 20261109150000):
 * summed from Fleet by the database, read only here and refused if typed.
 */
export const isFleetComponent = (key: string) => key.startsWith("fleet_");

export type EnginePart = {
  key: string;
  name: string;
  /** null = no value entered for this component (counts 0, named). */
  value: number | null;
  source: "office" | "default" | "none";
  effective_from: string | null;
};

export type EngineAt = {
  /** The true cost per field-labor hour. */
  total: number;
  parts: EnginePart[];
  /** Names of components in use with no value. */
  missing: string[];
};

/** A component counts on a day unless it was archived on or before it. */
const inUse = (c: OverheadComponent, on: string) =>
  !c.archived_at || c.archived_at.slice(0, 10) > on;

/** The engine at an office (null = company default) on a day. */
export function engineAt(
  rows: readonly MoneyValueRow[],
  components: readonly OverheadComponent[],
  office: string | null,
  on: string,
): EngineAt {
  const parts: EnginePart[] = [];
  let cents = 0;
  for (const c of [...components].sort((a, b) => a.sort_order - b.sort_order)) {
    if (!inUse(c, on)) continue;
    const r = resolveOfficeValue(rows, { ...OVERHEAD_LENS, item_key: c.key }, office, on);
    parts.push({
      key: c.key,
      name: c.name,
      value: r?.value ?? null,
      source: r?.source ?? "none",
      effective_from: r?.effective_from ?? null,
    });
    if (r) cents += toCents(r.value);
  }
  return {
    total: fromCents(cents),
    parts,
    missing: parts.filter((p) => p.value == null).map((p) => p.name),
  };
}

export type TimelinePoint = {
  date: string;
  total: number;
  /** What moved on this date, component by component (none on the first point). */
  changes: { key: string; name: string; from: number | null; to: number | null; delta: number }[];
};

/**
 * Every day the engine changed at an office, oldest first, with the total
 * and what moved. A day nothing moved at this office (another office's
 * change) is left out.
 */
export function engineTimeline(
  rows: readonly MoneyValueRow[],
  components: readonly OverheadComponent[],
  office: string | null,
): TimelinePoint[] {
  const days = new Set<string>();
  for (const r of rows) {
    if (r.book === "overhead" && (r.office_id === null || r.office_id === office))
      days.add(r.effective_from);
  }
  for (const c of components) if (c.archived_at) days.add(c.archived_at.slice(0, 10));
  const out: TimelinePoint[] = [];
  let prev: EngineAt | null = null;
  for (const day of [...days].sort()) {
    const now = engineAt(rows, components, office, day);
    const changes = prev ? diffParts(prev, now) : [];
    if (prev && changes.length === 0) continue;
    out.push({ date: day, total: now.total, changes });
    prev = now;
  }
  return out;
}

function diffParts(a: EngineAt, b: EngineAt): TimelinePoint["changes"] {
  const before = new Map(a.parts.map((p) => [p.key, p]));
  const after = new Map(b.parts.map((p) => [p.key, p]));
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const out: TimelinePoint["changes"] = [];
  for (const k of keys) {
    const from = before.get(k)?.value ?? null;
    const to = after.get(k)?.value ?? null;
    if (from === to) continue;
    out.push({
      key: k,
      name: after.get(k)?.name ?? before.get(k)?.name ?? k,
      from,
      to,
      delta: fromCents(toCents(to ?? 0) - toCents(from ?? 0)),
    });
  }
  return out;
}

export type EngineCompare = {
  from: { date: string; total: number };
  to: { date: string; total: number };
  delta: number;
  /** Each component's move between the two dates, with the day it moved. */
  moves: { name: string; delta: number; date: string }[];
};

/** Why the cost per hour differs between two dates ("compare any two dates"). */
export function compareEngine(
  rows: readonly MoneyValueRow[],
  components: readonly OverheadComponent[],
  office: string | null,
  a: string,
  b: string,
): EngineCompare {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const start = engineAt(rows, components, office, lo);
  const end = engineAt(rows, components, office, hi);
  const moves: EngineCompare["moves"] = [];
  for (const p of engineTimeline(rows, components, office)) {
    if (p.date <= lo || p.date > hi) continue;
    for (const c of p.changes) moves.push({ name: c.name, delta: c.delta, date: p.date });
  }
  return {
    from: { date: lo, total: start.total },
    to: { date: hi, total: end.total },
    delta: fromCents(toCents(end.total) - toCents(start.total)),
    moves,
  };
}

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const signed = (n: number) => `${n < 0 ? "−" : "+"}${usd(Math.abs(n))}`;

/** "Why $45→$49: General liability +$3 (Mar), Wage +$1 (Jun)". */
export function explainCompare(c: EngineCompare): string {
  const head = `Why ${usd(c.from.total)}→${usd(c.to.total)}`;
  if (!c.moves.length) return `${head}: nothing changed`;
  const sameYear = c.from.date.slice(0, 4) === c.to.date.slice(0, 4);
  const when = (d: string) =>
    `${MONTH[Number(d.slice(5, 7)) - 1]}${sameYear ? "" : ` ${d.slice(0, 4)}`}`;
  return `${head}: ${c.moves.map((m) => `${m.name} ${signed(m.delta)} (${when(m.date)})`).join(", ")}`;
}

// --------------------------------------------------------------- the draft

/** A typed value per component × scope; "reset" hands an office back to the default. */
export type EngineDraft = Readonly<Record<string, { value: string } | { reset: true }>>;

export const engineCellKey = (component: string, office: string | null) =>
  `${component}|${office ?? "default"}`;

/**
 * The draft as overhead_save changes ("" effective = the server's today). A
 * value typed in a unit other than hour goes as its amount and unit; the
 * database works out the $/hour.
 */
export function engineDraftToChanges(
  draft: EngineDraft,
  effectiveFrom: string,
  unitFor: (component: string) => OverheadUnit = () => HOUR_UNIT,
): Record<string, unknown>[] {
  return Object.keys(draft)
    .sort()
    .map((id) => {
      const e = draft[id]!;
      const at = id.lastIndexOf("|");
      const scope = id.slice(at + 1);
      const component = id.slice(0, at);
      const unit = unitFor(component);
      const typed = "reset" in e ? null : Number(e.value.replace(/[$,\s]/g, ""));
      return {
        op: "value",
        component,
        office_id: scope === "default" ? null : scope,
        value: typed == null ? null : perHour(typed, unit),
        ...(typed != null && unit.key !== "hour" ? { amount: typed, unit: unit.key } : {}),
        effective_from: effectiveFrom,
      };
    });
}

// --------------------------------------------------------------- the loaders

const db = () => supabase as unknown as SupabaseClient;

/** A labor cost rate on file that is not the engine's (read only, kept). */
export type LegacyLaborRate = {
  id: string;
  role: string | null;
  crew_class: string | null;
  user_id: string | null;
  location_id: string | null;
  hourly_rate: number;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
};

export type OverheadData = {
  /** False until 20261031120000, or for anyone but an owner or admin. */
  available: boolean;
  components: OverheadComponent[];
  /** Hour alone until 20261104120000; then every unit, in order. */
  units: OverheadUnit[];
  unitsAvailable: boolean;
  rows: MoneyValueRow[];
  /** Temp crew wage and every other labor rate on file, newest first. */
  labour: LegacyLaborRate[];
};

export async function loadOverhead(client: SupabaseClient = db()): Promise<OverheadData> {
  const [compWithUnitQ, rowsQ, labourQ, unitsQ] = await Promise.all([
    client
      .from("overhead_components")
      .select("key, name, note, system, sort_order, archived_at, unit_key")
      .order("sort_order"),
    client
      .from("money_values")
      .select("book, item_key, measure, office_id, effective_from, value")
      .eq("book", "overhead"),
    client
      .from("labour_rates")
      .select(
        "id, role, crew_class, user_id, location_id, hourly_rate, effective_from, effective_to, note",
      )
      .order("effective_from", { ascending: false }),
    client
      .from("overhead_units")
      .select("key, name, hours, system, sort_order")
      .order("sort_order"),
  ]);
  // Before 20261104120000 there is no unit_key: read the components without it.
  const compQ =
    compWithUnitQ.error && isMissingSchema(compWithUnitQ.error)
      ? await client
          .from("overhead_components")
          .select("key, name, note, system, sort_order, archived_at")
          .order("sort_order")
      : compWithUnitQ;
  if (compQ.error) {
    if (isMissingSchema(compQ.error))
      return {
        available: false,
        components: [],
        units: [HOUR_UNIT],
        unitsAvailable: false,
        rows: [],
        labour: [],
      };
    throw compQ.error;
  }
  if (unitsQ.error && !isMissingSchema(unitsQ.error)) throw unitsQ.error;
  const units = unitsQ.error
    ? [HOUR_UNIT]
    : ((unitsQ.data ?? []) as (OverheadUnit & { hours: number | string })[]).map((u) => ({
        ...u,
        hours: Number(u.hours),
      }));
  if (rowsQ.error) throw rowsQ.error;
  const components = (compQ.data ?? []) as OverheadComponent[];
  return {
    available: components.length > 0,
    components,
    units: units.length ? units : [HOUR_UNIT],
    unitsAvailable: !unitsQ.error,
    rows: ((rowsQ.data ?? []) as (MoneyValueRow & { value: number | string | null })[]).map(
      (r) => ({
        ...r,
        value: r.value == null ? null : Number(r.value),
      }),
    ),
    labour: labourQ.error
      ? []
      : ((labourQ.data ?? []) as (LegacyLaborRate & { hourly_rate: number | string })[]).map(
          (r) => ({ ...r, hourly_rate: Number(r.hourly_rate) }),
        ),
  };
}

export async function saveOverhead(
  changes: readonly Record<string, unknown>[],
  note: string,
  client: SupabaseClient = db(),
): Promise<number> {
  const { data, error } = await client.rpc(
    "overhead_save" as never,
    { _changes: changes, _note: note.trim() } as never,
  );
  if (error) throw error;
  return Number(data ?? 0);
}
