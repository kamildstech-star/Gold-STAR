import { supabase } from "@/integrations/supabase/client";
import { TONE } from "@/lib/tone";

/**
 * The credentials library. Gold Star holds a policy or a certificate once —
 * per legal entity, or by the person who sat the exam. Clients then tick which
 * of those they require. Nothing gets uploaded fifty times.
 */

export type CredentialCategory = "insurance" | "certification" | "licence";

export type CredentialKind = {
  key: string;
  label: string;
  category: CredentialCategory;
  /** Insurance carries limits; a certificate does not. */
  hasLimits?: boolean;
  /** Held by a person rather than the entity, typically. */
  personal?: boolean;
  /** Licences are per state. */
  stateScoped?: boolean;
};

/**
 * One vocabulary, used by both the library and the requirement chips. Adding a
 * kind here makes it tickable on every account.
 */
export const CREDENTIAL_CATALOG: CredentialKind[] = [
  // Insurance ---------------------------------------------------------------
  {
    key: "general_liability",
    label: "Commercial General Liability",
    category: "insurance",
    hasLimits: true,
  },
  { key: "auto_liability", label: "Auto Liability", category: "insurance", hasLimits: true },
  {
    key: "workers_compensation",
    label: "Workers Compensation",
    category: "insurance",
    hasLimits: true,
  },
  {
    key: "contractor_pollution",
    label: "Contractor Pollution",
    category: "insurance",
    hasLimits: true,
  },
  { key: "umbrella_excess", label: "Umbrella / Excess", category: "insurance", hasLimits: true },
  {
    key: "professional_liability",
    label: "Professional Liability",
    category: "insurance",
    hasLimits: true,
  },
  {
    key: "certificate_of_insurance",
    label: "Certificate of Insurance",
    category: "insurance",
    hasLimits: true,
  },
  { key: "additional_insured", label: "Additional Insured Endorsement", category: "insurance" },
  { key: "waiver_of_subrogation", label: "Waiver of Subrogation", category: "insurance" },

  // Certifications ----------------------------------------------------------
  { key: "iicrc_certified_firm", label: "IICRC Certified Firm", category: "certification" },
  {
    key: "iicrc_wrt",
    label: "IICRC WRT — Water Restoration",
    category: "certification",
    personal: true,
  },
  {
    key: "iicrc_asd",
    label: "IICRC ASD — Applied Structural Drying",
    category: "certification",
    personal: true,
  },
  {
    key: "iicrc_amrt",
    label: "IICRC AMRT — Mold Remediation",
    category: "certification",
    personal: true,
  },
  {
    key: "iicrc_fsrt",
    label: "IICRC FSRT — Fire & Smoke",
    category: "certification",
    personal: true,
  },
  {
    key: "iicrc_oct",
    label: "IICRC OCT — Odor Control",
    category: "certification",
    personal: true,
  },
  {
    key: "iicrc_cct",
    label: "IICRC CCT — Carpet Cleaning",
    category: "certification",
    personal: true,
  },
  {
    key: "iicrc_tcst",
    label: "IICRC TCST — Trauma & Crime Scene",
    category: "certification",
    personal: true,
  },
  { key: "epa_lead_rrp_firm", label: "EPA Company Lead RRP", category: "certification" },
  {
    key: "lead_renovator_8hr",
    label: "8-Hour Lead Renovator",
    category: "certification",
    personal: true,
  },

  // Licences and paperwork --------------------------------------------------
  {
    key: "state_contractor_licence",
    label: "State Contractor License",
    category: "licence",
    stateScoped: true,
  },
  { key: "business_license", label: "Business License", category: "licence", stateScoped: true },
  { key: "w9", label: "W-9", category: "licence" },
  { key: "vendor_agreement", label: "Signed Vendor Agreement", category: "licence" },
];

export const CATEGORY_LABEL: Record<CredentialCategory, string> = {
  insurance: "Insurance",
  certification: "Certifications",
  licence: "Licenses & paperwork",
};

export function credentialKind(key: string): CredentialKind | undefined {
  return CREDENTIAL_CATALOG.find((k) => k.key === key);
}

export function credentialLabel(key: string): string {
  return credentialKind(key)?.label ?? key;
}

export type CompanyCredential = {
  id: string;
  category: CredentialCategory;
  kind: string;
  name: string | null;
  issuer: string | null;
  carrier: string | null;
  policy_number: string | null;
  limit_occurrence: number | null;
  limit_aggregate: number | null;
  currency: string;
  effective_date: string | null;
  expiry_date: string | null;
  state_code: string | null;
  holder_location_id: string | null;
  holder_user_id: string | null;
  document_id: string | null;
  notes: string | null;
  renewal_lead_days: number;
  active: boolean;
};

export type CredentialStatus = "active" | "expiring" | "expired" | "no_expiry";

export const CREDENTIAL_STATUS_LABEL: Record<CredentialStatus, string> = {
  active: "Active",
  expiring: "Expiring",
  expired: "Expired",
  no_expiry: "No expiry",
};

export const CREDENTIAL_STATUS_TONE: Record<CredentialStatus, string> = {
  active: TONE.success,
  expiring: TONE.warning,
  expired: TONE.danger,
  no_expiry: TONE.neutral,
};

export function daysToExpiry(expiry: string | null): number | null {
  if (!expiry) return null;
  const ms = new Date(`${expiry}T00:00:00`).getTime() - new Date().setHours(0, 0, 0, 0);
  return Math.round(ms / 86_400_000);
}

export function credentialStatus(c: {
  expiry_date: string | null;
  renewal_lead_days?: number;
}): CredentialStatus {
  const d = daysToExpiry(c.expiry_date);
  if (d == null) return "no_expiry";
  if (d < 0) return "expired";
  if (d <= (c.renewal_lead_days ?? 30)) return "expiring";
  return "active";
}

const CRED_SELECT =
  "id, category, kind, name, issuer, carrier, policy_number, limit_occurrence, limit_aggregate, currency, effective_date, expiry_date, state_code, holder_location_id, holder_user_id, document_id, notes, renewal_lead_days, active";

export async function fetchCredentials(opts?: { locationId?: string | null }) {
  let q = supabase.from("company_credentials").select(CRED_SELECT).eq("active", true);
  if (opts?.locationId) {
    q = q.or(`holder_location_id.is.null,holder_location_id.eq.${opts.locationId}`);
  }
  const { data, error } = await q.order("expiry_date", { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as unknown as CompanyCredential[];
}

/** Which clients an expiry puts at risk — the reason a renewal is urgent. */
export async function fetchAccountsAtRisk(credentialId: string) {
  const { data, error } = await supabase.rpc("credential_accounts_at_risk", {
    _credential_id: credentialId,
  });
  if (error) throw error;
  return (data ?? []) as {
    account_id: string;
    account_name: string;
    location_id: string | null;
    requirement_type: string;
  }[];
}

/** Library documents share the compliance bucket under a `library/` prefix. */
export const CREDENTIAL_LIBRARY_BUCKET = "compliance-files";

/**
 * One derived indicator per account. Never settable by hand — an expiry flips
 * it red on its own.
 */
export type ComplianceIndicator =
  "compliant" | "expiring" | "in_progress" | "not_compliant" | "none";

export const INDICATOR_LABEL: Record<ComplianceIndicator, string> = {
  compliant: "Compliant",
  expiring: "Expires soon",
  in_progress: "In progress",
  not_compliant: "Not compliant",
  none: "No requirements",
};

export const INDICATOR_TONE: Record<ComplianceIndicator, string> = {
  compliant:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/40",
  expiring:
    "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40",
  in_progress:
    "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40",
  not_compliant:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/40",
  none: "bg-muted text-muted-foreground border-border",
};

export const INDICATOR_DOT: Record<ComplianceIndicator, string> = {
  compliant: "bg-emerald-500",
  expiring: "bg-amber-500",
  in_progress: "bg-amber-500",
  not_compliant: "bg-red-500",
  none: "bg-muted-foreground/40",
};

export async function fetchComplianceIndicator(accountId: string): Promise<ComplianceIndicator> {
  const { data, error } = await supabase.rpc("account_compliance_indicator", {
    _account_id: accountId,
  });
  if (error) throw error;
  return ((data as string | null) ?? "none") as ComplianceIndicator;
}

/** Badge for a whole list in one request rather than one call per row. */
export async function fetchComplianceIndicators(
  accountIds: string[],
): Promise<Record<string, ComplianceIndicator>> {
  if (!accountIds.length) return {};
  const { data, error } = await supabase.rpc("accounts_compliance_indicators", {
    _ids: accountIds,
  });
  if (error) throw error;
  const out: Record<string, ComplianceIndicator> = {};
  for (const r of (data ?? []) as { account_id: string; indicator: string | null }[]) {
    out[r.account_id] = (r.indicator ?? "none") as ComplianceIndicator;
  }
  return out;
}
