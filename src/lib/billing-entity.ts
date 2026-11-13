import { supabase } from "@/integrations/supabase/client";

/**
 * The issuing entity per job — ours, not the customer's.
 *
 * Each office is its own legal entity with its own EIN, logo, phone, payment
 * link and Zelle address. Every job carries a `billing_location_id` — separate
 * from the operating location — and every document, contract, estimate,
 * invoice and email template resolves its entity from that office.
 *
 * Who the document is addressed TO is the other half, and lives in bill-to.ts.
 * The two were conflated on one card called "Billing entity", which everyone
 * read as the customer's.
 */
export type BillingOffice = {
  id: string;
  code: string;
  name: string;
  legal_entity_name: string | null;
  region: string | null;
  locality: string | null;
  ein: string | null;
  office_phone: string | null;
  office_email: string | null;
  logo_url: string | null;
  card_payment_url: string | null;
  zelle_email: string | null;
  card_payments_offered?: boolean | null;
  payment_options_text: string | null;
  lat: number | null;
  lon: number | null;
};

const OFFICE_FIELDS =
  "id, code, name, legal_entity_name, region, locality, ein, office_phone, office_email, logo_url, card_payment_url, zelle_email, card_payments_offered, payment_options_text, lat, lon";

/**
 * Which payment methods an office can actually offer a customer. Templates
 * omit a bullet entirely rather than rendering a blank link or "n/a".
 */
export type PaymentMethods = {
  card: boolean;
  zelle: boolean;
  /** Cash/check is always available. */
  any: boolean;
};

export function paymentMethodsFor(
  o: Pick<BillingOffice, "card_payment_url" | "zelle_email"> | null | undefined,
): PaymentMethods {
  const card = Boolean(o?.card_payment_url?.trim());
  const zelle = Boolean(o?.zelle_email?.trim());
  return { card, zelle, any: card || zelle };
}

/**
 * Billing details the client still owes us. An office that deliberately does
 * not take cards (Clarkston) is complete without a card link.
 */
export function missingBillingDetails(
  o: Pick<BillingOffice, "card_payment_url" | "zelle_email" | "card_payments_offered">,
): string[] {
  const missing: string[] = [];
  if (!o.zelle_email?.trim()) missing.push("Zelle address");
  if (o.card_payments_offered !== false && !o.card_payment_url?.trim())
    missing.push("card payment link");
  return missing;
}

export async function loadBillingOffices(): Promise<BillingOffice[]> {
  const { data, error } = await supabase
    .from("locations")
    .select(OFFICE_FIELDS)
    .eq("active", true)
    .order("code");
  if (error) throw error;
  return (data ?? []) as unknown as BillingOffice[];
}

export function entityLabel(o: Pick<BillingOffice, "name" | "legal_entity_name"> | null): string {
  if (!o) return "—";
  return o.legal_entity_name?.trim() || o.name;
}

export function officeLabel(o: BillingOffice | null): string {
  if (!o) return "—";
  const place = [o.locality, o.region].filter(Boolean).join(", ");
  return place ? `${entityLabel(o)} · ${place}` : entityLabel(o);
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toUpperCase();

export type BillingResolution = {
  office: BillingOffice | null;
  /** Human note explaining the pick: "NJ address → Gold Star Restoration LLC · Lakewood, NJ". */
  reason: string | null;
  /** True when no office covers this state — the user must choose explicitly. */
  needsChoice: boolean;
};

/**
 * Pick the billing office from the job address: match the address state to an
 * office's state, and where several share a state, the nearest by coordinates.
 * Never guesses when no state matches.
 */
export function resolveBillingOffice(
  offices: BillingOffice[],
  region: string | null | undefined,
  lat?: number | null,
  lon?: number | null,
): BillingResolution {
  const state = norm(region);
  if (!state) return { office: null, reason: null, needsChoice: false };

  const matches = offices.filter((o) => norm(o.region) === state);
  if (matches.length === 0) {
    return {
      office: null,
      reason: `No office is registered in ${state} — choose a billing office.`,
      needsChoice: true,
    };
  }

  let pick = matches[0]!;
  if (matches.length > 1 && lat != null && lon != null) {
    const d = (o: BillingOffice) =>
      o.lat == null || o.lon == null
        ? Number.POSITIVE_INFINITY
        : (o.lat - lat) ** 2 + (o.lon - lon) ** 2;
    pick = matches.reduce((best, o) => (d(o) < d(best) ? o : best), matches[0]!);
  }

  const nearest = matches.length > 1 ? " (nearest office)" : "";
  return {
    office: pick,
    reason: `${state} address → ${officeLabel(pick)}${nearest}`,
    needsChoice: false,
  };
}

/** Out-of-footprint work is legitimate, but it should be a conscious decision. */
export function billingMismatch(
  office: BillingOffice | null,
  region: string | null | undefined,
): string | null {
  if (!office || !norm(region) || !norm(office.region)) return null;
  if (norm(office.region) === norm(region)) return null;
  return `This job's address is in ${norm(region)} but it will be billed by ${entityLabel(
    office,
  )} in ${norm(office.region)}. Out-of-footprint work is allowed — just confirm it's intended.`;
}

export type BillingDocImpact = {
  /** Documents still unsent — these re-resolve to the new entity automatically. */
  unsent: number;
  /** Documents already sent under the previous entity. */
  sent: number;
};

/** What changing the billing office would touch on this job. */
export async function billingDocImpact(jobId: string): Promise<BillingDocImpact> {
  const [inv, est, docs] = await Promise.all([
    supabase.from("invoices").select("id, status").eq("job_id", jobId),
    supabase.from("estimates").select("id, status").eq("job_id", jobId),
    supabase.from("documents").select("id, status").eq("job_id", jobId),
  ]);

  const SENT = new Set([
    "sent",
    "viewed",
    "paid",
    "partial",
    "overdue",
    "approved",
    "signed",
    "accepted",
  ]);
  let unsent = 0;
  let sent = 0;
  for (const row of [...(inv.data ?? []), ...(est.data ?? []), ...(docs.data ?? [])] as {
    status: string | null;
  }[]) {
    if (SENT.has((row.status ?? "").toLowerCase())) sent += 1;
    else unsent += 1;
  }
  return { unsent, sent };
}

/**
 * Change the billing office. Unsent invoices and estimates are re-pointed so
 * they render under the new entity; anything already sent keeps its history.
 */
export async function setJobBillingLocation(jobId: string, locationId: string) {
  const { error } = await supabase
    .from("jobs")
    .update({ billing_location_id: locationId })
    .eq("id", jobId);
  if (error) throw error;

  const UNSENT_INV = ["draft"] as const;
  const UNSENT_EST = ["draft"] as const;
  await Promise.all([
    supabase
      .from("invoices")
      .update({ location_id: locationId })
      .eq("job_id", jobId)
      .in("status", UNSENT_INV),
    supabase
      .from("estimates")
      .update({ location_id: locationId })
      .eq("job_id", jobId)
      .in("status", UNSENT_EST),
  ]);
}
