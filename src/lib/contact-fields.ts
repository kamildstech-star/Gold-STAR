/**
 * The one list of the fields a contact record shows, and the derivation of
 * what the compact card on the prospect view has to hide behind an expander.
 *
 * Mark: "whatever doesnt show from here in th4e small card on the prospect
 * view should have an expand button that will show that extra info but by
 * default should be collapsed". The thing worth noticing about that report is
 * how it happened: the full contact panel grew Position and Gift policy, the
 * small card was written separately, and nobody noticed the small card had
 * quietly stopped being a summary of the big one. Hand-listing the missing
 * three here would set that same trap for the next field.
 *
 * So the expanded set is never written down. CONTACT_ACCOUNT_FIELDS is the
 * full panel's ACCOUNT section, the card declares only what it already puts
 * on screen, and the expander shows the difference. Add a field to the panel
 * and it turns up under the chevron on its own.
 *
 * Why a mirrored list rather than one the drawer renders from: the drawer's
 * fields are not uniform — each one carries its own editor, option list and
 * save, and the name refuses a blank. Driving that markup from a descriptor
 * would be a rewrite of an editable surface for a read-only card's benefit.
 * The list is kept honest instead by contact-drawer.fields.test.ts, which
 * reads the drawer's own ACCOUNT section and fails the moment the two differ.
 */

import { splitFullName } from "@/lib/person-name";

export type ContactFieldKey =
  | "first_name"
  | "last_name"
  | "title"
  | "position_key"
  | "email"
  | "phone"
  | "decision_role"
  | "gift_policy";

export type ContactField = {
  key: ContactFieldKey;
  label: string;
};

/**
 * The ACCOUNT section of the contact panel, in the order it draws them.
 * Keep in step with the DrawerSection titled ACCOUNT in contact-drawer.tsx.
 */
export const CONTACT_ACCOUNT_FIELDS: readonly ContactField[] = [
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
  // Position leads Title: it is the fixed list the org chart is drawn from,
  // and Title is only worth typing when somebody's own wording differs.
  { key: "position_key", label: "Position" },
  { key: "title", label: "Custom title (optional)" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  // Decision role is NOT here any more: it is a sales concept and moved to the
  // panel's Relationship section, which collapses for non-sellers. The card
  // still counts it as shown (see collapsedCardFieldKeys) so it cannot turn up
  // under the chevron either.
  { key: "gift_policy", label: "Gift policy" },
];

/** As much of a contact as either surface needs to read. */
export type ContactFieldSource = {
  full_name?: string | null;
  /** Null until 20260913120000 is applied; derived from `full_name` until then. */
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  position_key?: string | null;
  email?: string | null;
  phone?: string | null;
  decision_role?: string | null;
  gift_policy?: string | null;
};

/** The lookup tables that turn the stored keys into what a rep reads. */
export type ContactFieldLabels = {
  position: Record<string, string>;
  role: Record<string, string>;
  giftPolicy: Record<string, string>;
};

/**
 * What the collapsed card already has on screen for this person.
 *
 * Title is the conditional one. The line under the name prints the decision
 * role and falls back to the job title when there is no role (see
 * contactRoleLabel), so the title counts as shown only in that case —
 * otherwise the expander would either repeat it or swallow it.
 */
export function collapsedCardFieldKeys(contact: ContactFieldSource): ContactFieldKey[] {
  // The card prints the whole name on one line, which is both halves of it —
  // so both count as shown and neither turns up under the chevron.
  const keys: ContactFieldKey[] = ["first_name", "last_name", "phone", "email"];
  if (contact.decision_role) keys.push("decision_role");
  else keys.push("title");
  return keys;
}

/**
 * A field's value as the card would print it, or null when there is nothing
 * to print. "Position not set" and "Policy unknown" are placeholders the full
 * panel shows because it is also the editor for them; here they are empty.
 */
export function contactFieldValue(
  contact: ContactFieldSource,
  key: ContactFieldKey,
  labels: ContactFieldLabels,
): string | null {
  if (key === "first_name" || key === "last_name") {
    // The stored column when it exists, else the same first-space split the
    // backfill uses — so the card reads identically before and after the
    // migration.
    const stored = contact[key];
    if (stored) return String(stored);
    const derived = splitFullName(contact.full_name);
    const value = key === "first_name" ? derived.firstName : derived.lastName;
    return value || null;
  }
  if (key === "position_key") {
    const raw = contact.position_key ?? "";
    return raw ? (labels.position[raw] ?? raw) : null;
  }
  if (key === "decision_role") {
    const raw = contact.decision_role ?? "";
    return raw ? (labels.role[raw] ?? raw) : null;
  }
  if (key === "gift_policy") {
    const raw = contact.gift_policy ?? "";
    // "unknown" is the absence of a policy, not a policy. A card that opens
    // to say "Policy unknown" has wasted the click.
    return raw && raw !== "unknown" ? (labels.giftPolicy[raw] ?? raw) : null;
  }
  const raw = contact[key];
  return raw ? String(raw) : null;
}

/**
 * The full list minus what is already visible — the general form, so a test
 * can prove the subtraction rather than the answer it happens to give today.
 */
export function fieldsNotShown(
  all: readonly ContactField[],
  shown: readonly ContactFieldKey[],
): ContactField[] {
  const seen = new Set(shown);
  return all.filter((f) => !seen.has(f.key));
}

export type ExpandedContactField = ContactField & { value: string };

/**
 * What the chevron reveals: every field of the full panel the card does not
 * already show, minus the ones this contact has no value for.
 *
 * Empties are dropped on purpose. The full panel keeps a "Position not set"
 * row because that row is how you set it; the card is read-only and lives in
 * a 300px column, so a drawer of "not set" lines would make expanding pointless
 * and would hide the one field that is actually filled in among four that
 * are not.
 */
export function expandedContactFields(
  contact: ContactFieldSource,
  labels: ContactFieldLabels,
): ExpandedContactField[] {
  return fieldsNotShown(CONTACT_ACCOUNT_FIELDS, collapsedCardFieldKeys(contact))
    .map((f) => ({ ...f, value: contactFieldValue(contact, f.key, labels) }))
    .filter((f): f is ExpandedContactField => f.value !== null);
}
