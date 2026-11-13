/**
 * Property lookup — provider-agnostic, server only.
 *
 * A lookup costs money per call, so it happens once, on accept, for a single
 * address. Never for a list, a board, or a suggestion. The provider sits
 * behind this interface so it can be swapped without touching the cockpit.
 *
 * No provider is wired yet: set PROPERTY_PROVIDER plus that provider's key in
 * Project Settings → Secrets and fill in its adapter below.
 */

export interface PropertyRecord {
  provider: string;
  ownerName: string | null;
  ownerPhone: string | null;
  ownerEmail: string | null;
  /** Owner-occupied vs rental — decides who the chaser is actually knocking for. */
  ownerOccupied: boolean | null;
  unitCount: number | null;
  yearBuilt: number | null;
  lastSaleDate: string | null;
  lastSaleAmount: number | null;
  mailingAddress: string | null;
  raw: unknown;
}

export interface PropertyProvider {
  id: string;
  /** Present only when the provider's credentials are configured. */
  configured: boolean;
  lookup(input: { address: string; postalCode?: string | null }): Promise<PropertyRecord | null>;
}

function notConfigured(id: string): PropertyProvider {
  return {
    id,
    configured: false,
    lookup: async () => null,
  };
}

/**
 * PropertyShark — the client's suggestion. Their API is per-report and
 * account-specific, so the request shape is filled in once we have a contract
 * and a key; until then the adapter reports itself as unconfigured rather
 * than pretending to work.
 */
function propertySharkProvider(apiKey: string | undefined): PropertyProvider {
  if (!apiKey) return notConfigured("propertyshark");
  return {
    id: "propertyshark",
    configured: true,
    lookup: async () => {
      throw new Error(
        "PropertyShark adapter is not implemented yet — confirm the plan and endpoint, then fill in property-lookup.server.ts.",
      );
    },
  };
}

/** Selects the configured provider, or a null object when none is set up. */
export function getPropertyProvider(): PropertyProvider {
  const id = (process.env["PROPERTY_PROVIDER"] ?? "").trim().toLowerCase();
  switch (id) {
    case "propertyshark":
      return propertySharkProvider(process.env["PROPERTYSHARK_API_KEY"]);
    default:
      return notConfigured(id || "none");
  }
}
