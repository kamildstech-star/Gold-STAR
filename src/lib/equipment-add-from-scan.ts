/**
 * Adding a unit to the equipment register straight from a scan.
 *
 * The CEO, 26 Oct: a tag that is NOT yet in the register can be added right
 * there, from the scan, instead of only being refused. The scanner's one
 * authoritative "no" (`unregistered`) now offers "Add to register": the tag as
 * read, a type and a home office guessed from the tag, optional notes. One
 * confirm and the unit is on the session's list like any scanned unit.
 *
 * THE GUARDS
 *   - Only a plate-shaped tag (`normalizeAssetTag`) can be added — a camera
 *     read has also passed the Code 128 checksum. A misread is never a unit.
 *   - Only after the register answered "unregistered": never on an offline or
 *     failed lookup, which say nothing either way.
 *   - The server adds it (`add_equipment_from_scan`, 20261026160000), and
 *     first looks for the tag across the WHOLE register by the scanner's
 *     matching rule (case and separators ignored). The scan's own lookup only
 *     sees the offices this person can view, so a unit registered to another
 *     office reads as "unregistered" here — the server hands that unit back
 *     instead of making a twin.
 *   - Who may add: exactly who may add a unit on the register screen
 *     (`can_manage_location` on the home office: owners/admins, and an
 *     office's office staff, location managers and regionals). Anyone else is
 *     told to ask an admin; the server refuses them regardless.
 *   - Audit: the unit records who added it (`created_by`), from which screen
 *     (`created_via`) and on which job (`created_job_id`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeAssetTag, type RegisterUnit } from "@/lib/equipment-scan";

/** Type letters after the prefix: GSR-AM00034-NJ → air mover. */
const TYPE_BY_LETTERS: Record<string, string> = {
  AM: "air_mover",
  DU: "dehumidifier",
  AS: "air_scrubber",
};

/** The register type a tag's letters say, or null when they say nothing. */
export function typeFromTag(tag: string): string | null {
  const plate = normalizeAssetTag(tag);
  if (!plate) return null;
  const letters = /^[A-Z]{2,5}-([A-Z]{0,4})\d/.exec(plate)?.[1] ?? "";
  return TYPE_BY_LETTERS[letters] ?? null;
}

/**
 * The tag's location suffix → the office, as the pre-printed register import
 * maps them (20261026120000): office codes first, then the city in its name.
 * CAT1 / CAT2 are the catastrophe pools, homed at the CAT location.
 */
const SUFFIX_OFFICE: Record<string, { codes: string[]; names: string[] }> = {
  NY: { codes: ["NY"], names: ["brooklyn"] },
  NYU: { codes: ["NY-UP", "NYU"], names: ["monsey", "upstate"] },
  NJ: { codes: ["NJ"], names: ["lakewood"] },
  MD: { codes: ["MD"], names: ["baltimore"] },
  MI: { codes: ["MI"], names: ["southfield"] },
  GA: { codes: ["GA"], names: ["atlanta"] },
  HTX: { codes: ["TX", "HTX"], names: ["houston", "htx"] },
  NC: { codes: ["NC"], names: ["garner"] },
  IL: { codes: ["IL"], names: ["skokie"] },
  IN: { codes: ["IN"], names: ["columbus"] },
  CA: { codes: ["CA"], names: ["los angeles"] },
  CAT1: { codes: ["CAT1", "CAT"], names: [] },
  CAT2: { codes: ["CAT2", "CAT"], names: [] },
};

export type OfficeChoice = { id: string; code: string; name: string };

/** The office a tag's suffix names, among those offered; null when none fits. */
export function officeFromTag(tag: string, offices: readonly OfficeChoice[]): string | null {
  const plate = normalizeAssetTag(tag);
  if (!plate) return null;
  const suffix = plate.slice(plate.lastIndexOf("-") + 1);
  const rule = SUFFIX_OFFICE[suffix];
  if (!rule) return null;
  for (const code of rule.codes) {
    const hit = offices.find((o) => o.code.toUpperCase() === code);
    if (hit) return hit.id;
  }
  for (const n of rule.names) {
    const hit = offices.find((o) => o.name.toLowerCase().includes(n));
    if (hit) return hit.id;
  }
  return null;
}

/**
 * The defaults the add step opens with: type from the tag (else air mover,
 * changeable), office from the tag's suffix, else the job's office, else the
 * person's primary office.
 */
export function addDefaults(
  tag: string,
  ctx: {
    offices: readonly OfficeChoice[];
    jobLocationId: string | null;
    primaryLocationId: string | null;
  },
): { equipmentType: string; officeId: string; typeFromTag: boolean } {
  const fromTag = typeFromTag(tag);
  const visible = (id: string | null) => (id && ctx.offices.some((o) => o.id === id) ? id : null);
  return {
    equipmentType: fromTag ?? "air_mover",
    typeFromTag: fromTag != null,
    officeId:
      officeFromTag(tag, ctx.offices) ??
      visible(ctx.jobLocationId) ??
      visible(ctx.primaryLocationId) ??
      ctx.jobLocationId ??
      ctx.offices[0]?.id ??
      "",
  };
}

/** May this scan be offered "Add to register"? Plate-shaped only, and only after an authoritative no. */
export function canOfferAdd(tag: string, lookupKind: string): boolean {
  return lookupKind === "unregistered" && normalizeAssetTag(tag) != null;
}

/** Where the scan came from, kept on the unit. */
export type AddVia = "scan:equipment_setup" | "scan:field_ticket";

export type AddFromScanResult =
  | { kind: "created"; unit: RegisterUnit }
  /** The tag was already registered (another spelling, or an office this person cannot see). */
  | { kind: "existing"; unit: RegisterUnit }
  | { kind: "not_permitted" }
  | { kind: "not_a_tag" };

type RpcRow = {
  outcome: "created" | "existing";
  id: string;
  asset_tag: string;
  equipment_type: string;
  status: RegisterUnit["status"];
  location_id: string;
  /** Always NULL since 20261027150000: cost is not handed back by a scan. */
  purchase_cost_cents: number | null;
};

/** The one write. Throws only on a failure that is neither a refusal nor a bad tag. */
export async function addEquipmentFromScan(
  client: SupabaseClient,
  input: {
    tag: string;
    equipmentType: string;
    officeId: string;
    notes: string | null;
    via: AddVia;
    jobId: string | null;
  },
): Promise<AddFromScanResult> {
  const plate = normalizeAssetTag(input.tag);
  if (!plate) return { kind: "not_a_tag" };
  const { data, error } = await client.rpc("add_equipment_from_scan", {
    _tag: plate,
    _equipment_type: input.equipmentType,
    _location_id: input.officeId,
    _notes: input.notes?.trim() || null,
    _via: input.via,
    _job_id: input.jobId,
  });
  if (error) {
    const msg = `${error.message ?? ""}`;
    if (error.code === "42501" || /not_permitted/.test(msg)) return { kind: "not_permitted" };
    if (/not_a_tag/.test(msg)) return { kind: "not_a_tag" };
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | null;
  if (!row) throw new Error("The register did not return the unit.");
  const unit: RegisterUnit = {
    id: row.id,
    asset_tag: row.asset_tag,
    equipment_type: row.equipment_type,
    status: row.status,
    location_id: row.location_id,
  };
  return { kind: row.outcome, unit };
}

/** Whether this person may add a unit homed at this office — the register's own rule. */
export async function mayAddToRegister(
  client: SupabaseClient,
  userId: string,
  officeId: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("can_manage_location", {
    _user_id: userId,
    _location_id: officeId,
  });
  if (error) throw error;
  return data === true;
}
