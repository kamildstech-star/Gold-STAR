import { supabase } from "@/integrations/supabase/client";
import { actionFor, type ActionDef } from "@/lib/action-catalogue";
import type { RoleGroup, Weight } from "@/lib/scorecard";

/**
 * Scorecard admin — the data and the arithmetic behind /admin/scorecard.
 *
 * Mark, 16 Sep 2026: "this needs to have an admin menu to change and add".
 * `scorecard_weights` was seeded once by 20260805201804 and had no screen;
 * the Intelligence header even pointed at the table name. This module is the
 * screen's logic, kept free of React so it can be tested: which rows are in
 * force for an office, what they add up to, what a perfect month scores, and
 * what to write when the admin presses Save.
 *
 * SCOPE: COMPANY OR OFFICE
 * ------------------------
 * `location_id IS NULL` is the company default. A row with an office
 * overrides the company row for the same component, in that office only —
 * `weightsFor()` in src/lib/scorecard.ts is the precedence rule and is not
 * changed here. Two consequences the screen has to be honest about:
 *
 *   - a company component applies in every office unless the office writes
 *     its own row for it. There is no office-level "off" switch: `weightsFor`
 *     skips disabled rows entirely, so a disabled office row would simply
 *     let the company row through. The office's way to switch a company
 *     component off is a weight of 0, and the screen says so.
 *
 *   - removing an office row means "back to the company rule", not "gone".
 *
 * MONEY
 * -----
 * A currency component is fine to weight; the actual is NULL for a viewer
 * who may not see money and that component then contributes nothing to what
 * they see. The ranking itself is computed by everyone from what they may
 * see, so a peer's board can differ from a manager's on those components.
 */

export type Scope = { locationId: string | null };

/** One row as the screen edits it. */
export type DraftRow = {
  component: string;
  action: ActionDef | null;
  weight: number;
  target: number | null;
  direction: "higher" | "lower";
  enabled: boolean;
  /** The stored row this draft edits, when one exists AT THIS SCOPE. */
  id: string | null;
  /** Where the rule in force comes from. "company" on an office screen means inherited. */
  source: "company" | "office";
  /** The company row behind an inherited or overriding row, for "reset" and diffing. */
  companyRow: Weight | null;
};

/**
 * The rows in force for a group at a scope, as `weightsFor` would pick them,
 * but including disabled company rows (the admin needs to see what is off)
 * and excluding disabled office rows (they have no effect, see above).
 */
export function effectiveRows(all: Weight[], group: RoleGroup, scope: Scope): DraftRow[] {
  const company = new Map<string, Weight>();
  for (const w of all) {
    if (w.role_group !== group || w.location_id != null) continue;
    if (!company.has(w.component)) company.set(w.component, w);
  }
  const office = new Map<string, Weight>();
  if (scope.locationId) {
    for (const w of all) {
      if (w.role_group !== group || w.location_id !== scope.locationId || !w.enabled) continue;
      office.set(w.component, w);
    }
  }
  const keys = new Set<string>([...company.keys(), ...office.keys()]);
  const rows: DraftRow[] = [];
  for (const key of keys) {
    const o = office.get(key);
    const c = company.get(key) ?? null;
    const w = o ?? c!;
    rows.push({
      component: key,
      action: actionFor(key),
      weight: Number(w.weight),
      target: Number(w.target),
      direction: w.direction,
      enabled: w.enabled,
      id: scope.locationId ? (o?.id ?? null) : (c?.id ?? null),
      source: o ? "office" : "company",
      companyRow: c,
    });
  }
  return rows.sort((a, b) => b.weight - a.weight || a.component.localeCompare(b.component));
}

/** True when this office has any row of its own for the group. */
export function officeOverrides(all: Weight[], group: RoleGroup, locationId: string): boolean {
  return all.some((w) => w.role_group === group && w.location_id === locationId);
}

/** A fresh row for an action just picked from the catalogue. */
export function draftFromAction(action: ActionDef, scope: Scope): DraftRow {
  return {
    component: action.key,
    action,
    weight: 10,
    target: null,
    direction: action.direction,
    enabled: true,
    id: null,
    source: scope.locationId ? "office" : "company",
    companyRow: null,
  };
}

/** Σ weight over enabled rows. The seeds sum to 100 per group. */
export function weightTotal(rows: DraftRow[]): number {
  return rows.filter((r) => r.enabled).reduce((s, r) => s + (Number(r.weight) || 0), 0);
}

/**
 * "A rep who exactly hits every target scores N points" — attainment 1 on
 * every enabled row, × 25, the constant `pointsFor` uses.
 */
export function previewPoints(rows: DraftRow[]): number {
  return Math.round(weightTotal(rows) * 25);
}

export type RowProblem = { component: string; message: string };

/** What stops a save: a missing or non-positive target, a negative weight. */
export function rowProblems(rows: DraftRow[]): RowProblem[] {
  const out: RowProblem[] = [];
  for (const r of rows) {
    if (r.target == null || !(Number(r.target) > 0)) {
      out.push({ component: r.component, message: "Target is required and must be above zero." });
    }
    if (!(Number(r.weight) >= 0)) {
      out.push({ component: r.component, message: "Weight cannot be negative." });
    }
  }
  return out;
}

export type SavePlan = {
  inserts: {
    location_id: string | null;
    role_group: RoleGroup;
    component: string;
    weight: number;
    target: number;
    direction: "higher" | "lower";
    enabled: boolean;
  }[];
  updates: {
    id: string;
    weight: number;
    target: number;
    direction: "higher" | "lower";
    enabled: boolean;
  }[];
  deleteIds: string[];
};

function sameAs(r: DraftRow, w: Weight): boolean {
  return (
    Number(r.weight) === Number(w.weight) &&
    Number(r.target) === Number(w.target) &&
    r.direction === w.direction &&
    r.enabled === w.enabled
  );
}

/**
 * What to write for a group at a scope.
 *
 *   - a row with an id at this scope is updated;
 *   - a row without one is inserted at this scope — on an office screen an
 *     inherited company row is only inserted if the admin changed it, so
 *     Save on an untouched office writes nothing and it keeps following the
 *     company;
 *   - a row that existed at this scope and is no longer in the draft is
 *     deleted (on an office, that is "back to the company rule").
 */
export function planSave(
  draft: DraftRow[],
  all: Weight[],
  group: RoleGroup,
  scope: Scope,
): SavePlan {
  const atScope = all.filter(
    (w) => w.role_group === group && (w.location_id ?? null) === (scope.locationId ?? null),
  );
  const keep = new Set<string>();
  const plan: SavePlan = { inserts: [], updates: [], deleteIds: [] };
  for (const r of draft) {
    const target = Number(r.target);
    const row = {
      weight: Number(r.weight) || 0,
      target,
      direction: r.direction,
      enabled: r.enabled,
    };
    if (r.id) {
      keep.add(r.id);
      const stored = atScope.find((w) => w.id === r.id);
      if (!stored || !sameAs(r, stored)) plan.updates.push({ id: r.id, ...row });
      continue;
    }
    if (scope.locationId && r.companyRow && sameAs(r, r.companyRow)) continue;
    plan.inserts.push({
      location_id: scope.locationId,
      role_group: group,
      component: r.component,
      ...row,
    });
  }
  for (const w of atScope) if (!keep.has(w.id)) plan.deleteIds.push(w.id);
  return plan;
}

export async function applySavePlan(plan: SavePlan): Promise<void> {
  for (const id of plan.deleteIds) {
    const { error } = await supabase.from("scorecard_weights").delete().eq("id", id);
    if (error) throw error;
  }
  for (const u of plan.updates) {
    const { id, ...row } = u;
    const { error } = await supabase.from("scorecard_weights").update(row).eq("id", id);
    if (error) throw error;
  }
  if (plan.inserts.length) {
    const { error } = await supabase.from("scorecard_weights").insert(plan.inserts);
    if (error) throw error;
  }
}

/** Drop every office row for the group: the office follows the company again. */
export async function resetOfficeToCompany(group: RoleGroup, locationId: string): Promise<void> {
  const { error } = await supabase
    .from("scorecard_weights")
    .delete()
    .eq("role_group", group)
    .eq("location_id", locationId);
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/* Minimum activity                                                    */
/* ------------------------------------------------------------------ */

export type ScorecardSetting = {
  id: string;
  location_id: string | null;
  min_activity_events: number;
};

export const MIN_ACTIVITY_DEFAULT = 8;

export async function fetchScorecardSettings(): Promise<ScorecardSetting[]> {
  const { data, error } = await supabase
    .from("scorecard_settings")
    .select("id, location_id, min_activity_events");
  if (error) throw error;
  return (data ?? []) as ScorecardSetting[];
}

/** The setting in force at a scope, and whether it is the office's own. */
export function minActivityAt(
  rows: ScorecardSetting[],
  scope: Scope,
): { value: number; own: ScorecardSetting | null; company: ScorecardSetting | null } {
  const company = rows.find((r) => r.location_id == null) ?? null;
  const own = scope.locationId
    ? (rows.find((r) => r.location_id === scope.locationId) ?? null)
    : company;
  const value = Number((own ?? company)?.min_activity_events ?? MIN_ACTIVITY_DEFAULT);
  return { value, own, company };
}

export async function saveMinActivity(scope: Scope, value: number, existingId: string | null) {
  const v = Math.max(0, Math.round(value));
  const { error } = existingId
    ? await supabase
        .from("scorecard_settings")
        .update({ min_activity_events: v })
        .eq("id", existingId)
    : await supabase
        .from("scorecard_settings")
        .insert({ location_id: scope.locationId, min_activity_events: v });
  if (error) throw error;
}

export async function clearOfficeMinActivity(id: string) {
  const { error } = await supabase.from("scorecard_settings").delete().eq("id", id);
  if (error) throw error;
}
