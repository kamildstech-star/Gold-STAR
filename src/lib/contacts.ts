import { supabase } from "@/integrations/supabase/client";

/** Where a new contact's office came from, so the form can say which it was. */
export type ContactOfficeSource = "account" | "picked" | "membership";

/**
 * The office a new contact will land in, and why.
 *
 * The account wins outright when there is one. That is not a preference: the
 * `contacts_select` RLS policy reaches an account's office through
 * `contacts.account_id`, so a contact filed under a different office from its
 * account would be readable by two offices and owned by neither. Every one of
 * the 90 live contacts currently matches its account's office; this keeps it
 * that way.
 *
 * Split out of resolveContactLocationId so the precedence can be tested and,
 * more importantly, so the create form can tell the user that the Office field
 * they are looking at is about to be overruled. See create-customer-dialog.
 */
export function pickContactLocationId(input: {
  accountLocationId?: string | null;
  fallbackLocationId?: string | null;
  membershipLocationId?: string | null;
}): { locationId: string; source: ContactOfficeSource } | null {
  if (input.accountLocationId) {
    return { locationId: input.accountLocationId, source: "account" };
  }
  if (input.fallbackLocationId) {
    return { locationId: input.fallbackLocationId, source: "picked" };
  }
  if (input.membershipLocationId) {
    return { locationId: input.membershipLocationId, source: "membership" };
  }
  return null;
}

/**
 * Contacts are scoped for RLS on their own location_id now that account_id is
 * nullable (a homeowner insured has no management company). Resolve the office
 * from the linked account where there is one, otherwise fall back to the
 * explicit office the caller already knows about.
 */
export async function resolveContactLocationId(
  accountId: string | null | undefined,
  fallbackLocationId?: string | null,
): Promise<string> {
  let accountLocationId: string | null = null;
  if (accountId) {
    const { data } = await supabase
      .from("accounts")
      .select("location_id")
      .eq("id", accountId)
      .maybeSingle();
    accountLocationId = data?.location_id ?? null;
  }
  const withoutMembership = pickContactLocationId({ accountLocationId, fallbackLocationId });
  if (withoutMembership) return withoutMembership.locationId;

  const userId = (await supabase.auth.getUser()).data.user?.id;
  if (!userId) throw new Error("You must be signed in to create a contact.");
  const { data: mine } = await supabase
    .from("location_members")
    .select("location_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  const resolved = pickContactLocationId({
    accountLocationId,
    fallbackLocationId,
    membershipLocationId: mine?.location_id ?? null,
  });
  if (!resolved) {
    throw new Error("No office could be determined for this contact.");
  }
  return resolved.locationId;
}

/**
 * Put a customer who was only ever a typed name into the CRM.
 *
 * David, on converting an estimate: "I'll write David Stern here, and it saves
 * it, not in the CRM or wherever, but when I convert it to a job, it's gonna
 * pull that to create a new contact for the job." The estimate is a pricing
 * sheet and holds a name; a job is a relationship and needs a record. The one
 * customer-creation dialog (`CreateCustomerDialog`) is still where a rep
 * creates someone deliberately, with the relationship fields it asks for —
 * this is the same insert with only what the estimate knew, so a conversion
 * never quietly drops the name.
 */
export async function createCustomerContact(input: {
  fullName: string;
  accountId: string | null;
  locationId: string | null;
  methods: readonly {
    kind: "phone" | "email";
    label: string;
    value: string;
    is_preferred: boolean;
  }[];
  createdBy: string | null;
}): Promise<{ id: string; full_name: string } | null> {
  const fullName = input.fullName.trim();
  if (!fullName) return null;
  const locationId = await resolveContactLocationId(input.accountId, input.locationId ?? "");
  const phone = input.methods.find((m) => m.kind === "phone")?.value.trim() || null;
  const email = input.methods.find((m) => m.kind === "email")?.value.trim() || null;
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      account_id: input.accountId,
      location_id: locationId,
      full_name: fullName,
      phone,
      email,
      created_by: input.createdBy,
    })
    .select("id, full_name")
    .single();
  if (error || !data) throw error ?? new Error("No contact row returned");

  const rows = input.methods
    .filter((m) => m.value.trim())
    .map((m) => ({
      contact_id: data.id,
      kind: m.kind,
      label: m.label || (m.kind === "phone" ? "Main" : "Work"),
      value: m.value.trim(),
      is_preferred: m.is_preferred,
      created_by: input.createdBy,
    }));
  // The contact itself is the point; a phone row that will not insert is not
  // worth failing the conversion over, and the number is on the job either way.
  if (rows.length) await supabase.from("contact_methods").insert(rows);
  return data;
}

export type ContactMethodDraft = {
  kind: "phone" | "email";
  label: string;
  value: string;
  extension?: string;
  is_preferred: boolean;
};

/** Phones and emails for a contact, preferred first. */
export async function loadContactMethods(contactId: string): Promise<ContactMethodDraft[]> {
  const { data, error } = await supabase
    .from("contact_methods")
    .select("kind, label, value, extension, is_preferred")
    .eq("contact_id", contactId)
    .order("is_preferred", { ascending: false });
  if (error) return [];
  return (data ?? [])
    .filter((m) => m.kind === "phone" || m.kind === "email")
    .map((m) => ({
      kind: m.kind as "phone" | "email",
      label: m.label ?? (m.kind === "phone" ? "Main" : "Work"),
      value: m.value,
      extension: m.extension ?? undefined,
      is_preferred: !!m.is_preferred,
    }));
}
