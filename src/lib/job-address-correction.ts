/**
 * Correcting a job's address (David, 21 Oct): a mistyped address used to
 * mean deleting the job and making it again. Now it is edited in place, and
 * what hangs off the address follows the correction:
 *
 *   - The map position. `lat`/`lon` (and `geom`, which the jobs trigger
 *     derives from them) are taken from the picked suggestion, or geocoded
 *     from the corrected text. When neither finds the place they are CLEARED:
 *     a pin left on the old, wrong spot is worse than no pin — the map,
 *     routes and anything matched "near" the job read it.
 *   - Property standing. Notes are keyed by the normalised address
 *     (`addressKey`), so the banner already reads the new address. A note
 *     written against the mistyped address is copied to the corrected one
 *     when the corrected one has none — copied, not moved, in case another
 *     job really is at the old address.
 *   - The audit trail. Every column changed is logged by the jobs trigger and
 *     can be reverted from History like any other field edit.
 *
 * Incidents and exposures keep their own address — it is what the fire feed
 * reported, not what was typed on the job — so they are left alone.
 */
import { addressKey, fetchPropertyNote, savePropertyNote } from "@/lib/standing-notes";

export type AddressDraft = {
  address: string;
  address_line2: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  county: string | null;
};

export type Coords = { lat: number; lon: number };

/** Trimmed, blanks to null — the shape the jobs row stores. */
export function cleanAddressDraft(d: AddressDraft): AddressDraft {
  const t = (v: string | null | undefined) => {
    const s = (v ?? "").trim();
    return s ? s : null;
  };
  return {
    address: (d.address ?? "").trim(),
    address_line2: t(d.address_line2),
    locality: t(d.locality),
    region: t(d.region),
    postal_code: t(d.postal_code),
    county: t(d.county),
  };
}

/** One line for the geocoder — street, city, state, zip. No unit: it only confuses it. */
export function geocodeLine(d: AddressDraft): string {
  return [d.address, d.locality, [d.region, d.postal_code].filter(Boolean).join(" ")]
    .map((s) => (s ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/** Did anything that places the job move? The unit alone does not. */
export function placeChanged(before: AddressDraft, after: AddressDraft): boolean {
  const k = (d: AddressDraft) => geocodeLine(cleanAddressDraft(d)).toLowerCase();
  return k(before) !== k(after);
}

/**
 * The row update. Coordinates only change when the place did: correcting the
 * unit number keeps the pin. `coords` null with a moved place clears them.
 */
export function addressCorrectionPatch(
  before: AddressDraft,
  draft: AddressDraft,
  coords: Coords | null,
): Record<string, unknown> {
  const after = cleanAddressDraft(draft);
  const patch: Record<string, unknown> = {};
  const b = cleanAddressDraft(before);
  for (const k of Object.keys(after) as (keyof AddressDraft)[]) {
    if (after[k] !== b[k]) patch[k] = after[k];
  }
  if (placeChanged(b, after)) {
    patch.lat = coords?.lat ?? null;
    patch.lon = coords?.lon ?? null;
  }
  return patch;
}

/**
 * Copy the property's standing note from the mistyped address to the
 * corrected one, when the corrected one has none. Returns whether it copied.
 */
export async function carryPropertyNote(opts: {
  from: string;
  to: string;
  userId: string | null;
  locationId?: string | null;
}): Promise<boolean> {
  if (!addressKey(opts.to) || addressKey(opts.from) === addressKey(opts.to)) return false;
  const old = await fetchPropertyNote(opts.from);
  if (!old?.note) return false;
  const existing = await fetchPropertyNote(opts.to);
  if (existing?.note) return false;
  await savePropertyNote({
    address: opts.to,
    note: old.note,
    userId: opts.userId,
    locationId: opts.locationId ?? null,
  });
  return true;
}
