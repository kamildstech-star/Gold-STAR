import type { Database } from "@/integrations/supabase/types";

export type AccountType = Database["public"]["Enums"]["account_type"];
export type AccountStatus = Database["public"]["Enums"]["account_status"];
export type { GiftPolicy } from "@/lib/gift-policy";
import type { GiftPolicy } from "@/lib/gift-policy";
export type ContactDecisionRole = Database["public"]["Enums"]["contact_decision_role"];
export type TouchpointType = Database["public"]["Enums"]["touchpoint_type"];

export const ACCOUNT_TYPES: AccountType[] = [
  "property_management",
  "commercial",
  "residential",
  "other",
];
export const ACCOUNT_TYPE_LABEL: Record<AccountType, string> = {
  property_management: "Property management",
  commercial: "Commercial",
  residential: "Residential",
  other: "Other",
};

export const ACCOUNT_STATUSES: AccountStatus[] = [
  "prospect",
  "onboarding",
  "active",
  "dormant",
  "lost",
];
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  prospect: "Prospect",
  onboarding: "Onboarding",
  active: "Active customer",
  dormant: "Dormant",
  lost: "Lost",
};

export { GIFT_POLICIES, GIFT_POLICY_LABEL } from "@/lib/gift-policy";

export const CONTACT_DECISION_ROLES: string[] = [
  "decision_maker",
  "regional_manager",
  "influencer",
  "gatekeeper",
];
export const CONTACT_ROLE_LABEL: Record<string, string> = {
  decision_maker: "Decision maker",
  regional_manager: "Regional manager",
  influencer: "Influencer",
  gatekeeper: "Gatekeeper",
};

export const TOUCHPOINT_TYPES: TouchpointType[] = [
  "call",
  "email",
  "text",
  "meeting_in_person",
  "meeting_virtual",
  "linkedin",
  "mail",
  "gift",
  "seasonal_send",
  "other",
];
/**
 * The only touchpoint types a person may still enter by hand. Calls and emails
 * arrive from the dialer and the mailbox, so a rep cannot type those into
 * existence. LinkedIn and mail have no gateway — they are two of the six
 * outreach methods (src/lib/pipeline-rules.ts), so a rep logs them here.
 *
 * Text was gateway-only until Mark reversed that on 9 Sep 2026: a rep texts a
 * prospect from their own phone as often as from the SMS gateway, and an
 * attempt the standard cannot see is an attempt that never happened. So text
 * is manual too — but only in the same shape as the rest of this list. Every
 * touchpoint written here carries `capture_source: 'manual'`, which the
 * `tg_touchpoint_cadence` trigger turns into `is_self_reported = true`; the
 * timeline prints that as "Self-reported" where a gateway text says "SMS".
 * A hand-logged text is a rep's claim, and it is labelled as one.
 */
export const MANUAL_TOUCHPOINT_TYPES: TouchpointType[] = [
  "text",
  "meeting_in_person",
  "linkedin",
  "mail",
  "gift",
  "seasonal_send",
  "other",
];
/**
 * The capture source every hand-logged touchpoint is written with. It is what
 * `tg_touchpoint_cadence` reads to set `is_self_reported`, and what the
 * timeline prints as "Self-reported". Never write a manual row without it —
 * that is the whole difference between a rep's claim and gateway evidence.
 */
export const MANUAL_TOUCHPOINT_CAPTURE_SOURCE = "manual" as const;

export const TOUCHPOINT_LABEL: Record<TouchpointType, string> = {
  call: "Call",
  email: "Email",
  text: "Text",
  meeting_in_person: "In-person meeting",
  meeting_virtual: "Virtual meeting",
  linkedin: "LinkedIn",
  mail: "Mail",
  gift: "Gift",
  seasonal_send: "Seasonal send",
  other: "Other",
};

export const IN_PERSON_TYPES: TouchpointType[] = ["meeting_in_person"];

// Cadence rules: any touch every 90 days; in-person every 365 days.
export const TOUCH_INTERVAL_DAYS = 90;
export const IN_PERSON_INTERVAL_DAYS = 365;
export const DUE_SOON_WINDOW_DAYS = 14;

export type CadenceHealth = "overdue" | "due_soon" | "healthy" | "never";

export function cadenceHealth(
  lastTouchAt: string | null,
  lastInPersonAt: string | null,
): CadenceHealth {
  const now = Date.now();
  const dayMs = 86400000;
  const anyDays = lastTouchAt ? Math.floor((now - new Date(lastTouchAt).getTime()) / dayMs) : null;
  const ipDays = lastInPersonAt
    ? Math.floor((now - new Date(lastInPersonAt).getTime()) / dayMs)
    : null;

  if (anyDays == null && ipDays == null) return "never";
  const touchOverdue = anyDays == null || anyDays > TOUCH_INTERVAL_DAYS;
  const inPersonOverdue = ipDays == null || ipDays > IN_PERSON_INTERVAL_DAYS;
  if (touchOverdue || inPersonOverdue) return "overdue";

  const touchDueSoon = anyDays! >= TOUCH_INTERVAL_DAYS - DUE_SOON_WINDOW_DAYS;
  const inPersonDueSoon = ipDays! >= IN_PERSON_INTERVAL_DAYS - DUE_SOON_WINDOW_DAYS;
  if (touchDueSoon || inPersonDueSoon) return "due_soon";
  return "healthy";
}

export const HEALTH_LABEL: Record<CadenceHealth, string> = {
  overdue: "Overdue",
  due_soon: "Due soon",
  healthy: "On cadence",
  never: "Never contacted",
};

export const HEALTH_ORDER: CadenceHealth[] = ["overdue", "never", "due_soon", "healthy"];

export function daysSinceTs(ts: string | null): number | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

export function nextInPersonDueLabel(lastInPersonAt: string | null): string {
  if (!lastInPersonAt) return "In-person overdue (never met)";
  const days = daysSinceTs(lastInPersonAt)!;
  const remaining = IN_PERSON_INTERVAL_DAYS - days;
  if (remaining < 0) return `In-person overdue by ${Math.abs(remaining)}d`;
  if (remaining <= DUE_SOON_WINDOW_DAYS) return `In-person due in ${remaining}d`;
  return `In-person due in ${remaining}d`;
}
