/**
 * Where a supply order is delivered.
 *
 * David, 22 Sep: "this address up here should be delivery address. And maybe
 * have their location, their warehouse preset — or they should be able to
 * type in a different address."
 *
 * The office's address is the preset — the office is where the warehouse is —
 * and the field is plain text so anything else can be typed over it. Pure, so
 * the prefill rule and the fallback are tested without a DOM.
 */

export type OfficeAddress = {
  address?: string | null;
  locality?: string | null;
  region?: string | null;
  postal_code?: string | null;
};

/** One line a driver can read: "12 Main St, Lakewood, NJ 08701". */
export function officeDeliveryAddress(office: OfficeAddress | null | undefined): string {
  if (!office) return "";
  const street = office.address?.trim() ?? "";
  const town = office.locality?.trim() ?? "";
  // Some offices already hold the whole address in `address`; do not say the
  // town twice.
  if (street && town && street.toLowerCase().includes(town.toLowerCase())) return street;
  const stateZip = [office.region?.trim(), office.postal_code?.trim()].filter(Boolean).join(" ");
  return [street, town, stateZip].filter(Boolean).join(", ");
}

/**
 * The address the form shows: whatever was typed, else the chosen office's.
 * `typed === null` means untouched, so changing the office moves the preset
 * with it; an address somebody typed is never replaced behind their back.
 */
export function formDeliveryAddress(typed: string | null, office: OfficeAddress | null): string {
  return typed ?? officeDeliveryAddress(office);
}

/** Where the vendor ships: the order's own address, else its office's. */
export function orderDeliveryAddress(
  request: object,
  office: OfficeAddress | { address: string | null } | null | undefined,
): string | null {
  const own = (request as { delivery_address?: string | null }).delivery_address?.trim();
  if (own) return own;
  const fallback = officeDeliveryAddress(office ?? null);
  return fallback || null;
}

/** A picked job's site as one line — the "Job site" ship-to answer. */
export function jobSiteAddress(
  job: { address?: string | null; locality?: string | null } | null | undefined,
): string | null {
  if (!job?.address?.trim()) return null;
  const street = job.address.trim();
  const town = job.locality?.trim();
  return town && !street.toLowerCase().includes(town.toLowerCase()) ? `${street}, ${town}` : street;
}
