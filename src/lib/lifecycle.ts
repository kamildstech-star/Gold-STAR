import type { Database } from "@/integrations/supabase/types";
import { TONE } from "@/lib/tone";

/**
 * Stages are data now — rows in `pipeline_stages`, renameable by an admin.
 * This stays a plain string: the seeded keys below are the default pipeline,
 * not a closed set.
 */
export type AccountStage = string;
export type VendorDocKind = Database["public"]["Enums"]["vendor_doc_kind"];
export type VendorDocStatus = Database["public"]["Enums"]["vendor_doc_status"];
export type GiftOccasion = Database["public"]["Enums"]["gift_occasion"];
export type GiftCampaignStatus = Database["public"]["Enums"]["gift_campaign_status"];
export type GiftDeliveryStatus = Database["public"]["Enums"]["gift_delivery_status"];

/**
 * The lifecycle is a loop, not a funnel: an active account falls back to
 * nurture between losses, and nurture climbs back to active when one lands.
 * These are the seeded keys of the default pipeline — read live stage names
 * from `pipeline_stages` wherever they are shown to a user.
 */
export const ACCOUNT_STAGES: AccountStage[] = [
  "target",
  "researching",
  "attempting_contact",
  "meeting_booked",
  "meeting_held",
  "vendor_onboarding",
  "active",
  "nurture",
];

export const OFF_PATH_STAGES: AccountStage[] = ["dormant", "lost"];

const SEEDED_STAGE_LABEL: Record<string, string> = {
  target: "Target",
  researching: "Researching",
  attempting_contact: "Attempting contact",
  meeting_booked: "Meeting booked",
  meeting_held: "Meeting held",
  vendor_onboarding: "Vendor onboarding",
  active: "Active",
  nurture: "Nurture",
  dormant: "Dormant",
  lost: "Lost",
};

/** Fallback label for a stage key when the live stage row isn't loaded. */
export const ACCOUNT_STAGE_LABEL: Record<string, string> = new Proxy(SEEDED_STAGE_LABEL, {
  get: (target, prop: string) =>
    target[prop] ?? (typeof prop === "string" ? prop.replace(/_/g, " ") : prop),
});

export const VENDOR_DOC_KINDS: VendorDocKind[] = ["coi", "w9", "agreement", "other"];
export const VENDOR_DOC_KIND_LABEL: Record<VendorDocKind, string> = {
  coi: "Certificate of insurance",
  w9: "W-9",
  agreement: "Vendor agreement",
  other: "Other",
};

export const VENDOR_DOC_STATUSES: VendorDocStatus[] = ["missing", "pending", "active", "expired"];
export const VENDOR_DOC_STATUS_LABEL: Record<VendorDocStatus, string> = {
  missing: "Missing",
  pending: "Pending",
  active: "Active",
  expired: "Expired",
};
export const VENDOR_DOC_STATUS_TONE: Record<VendorDocStatus, string> = {
  missing: TONE.neutral,
  pending: TONE.warning,
  active: TONE.success,
  expired: TONE.danger,
};

/** Expiry beats stored status — a COI that lapsed yesterday is expired today. */
export function effectiveDocStatus(
  status: VendorDocStatus,
  expiryDate: string | null,
): VendorDocStatus {
  if (status === "active" && expiryDate && expiryDate < new Date().toISOString().slice(0, 10)) {
    return "expired";
  }
  return status;
}

export const GIFT_OCCASIONS: string[] = [
  "birthday",
  "jewish_holiday",
  "seasonal",
  "thank_you",
  "other",
];
export const GIFT_OCCASION_LABEL: Record<string, string> = {
  birthday: "Birthday",
  jewish_holiday: "Jewish holiday",
  seasonal: "Seasonal",
  thank_you: "Thank you",
  other: "Other",
};

export const GIFT_CAMPAIGN_STATUS_LABEL: Record<GiftCampaignStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  sending: "Sending",
  sent: "Sent",
  cancelled: "Canceled",
};

export const GIFT_DELIVERY_STATUS_LABEL: Record<GiftDeliveryStatus, string> = {
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  returned: "Returned",
  cancelled: "Canceled",
};

export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function fmtCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
