import { supabase } from "@/integrations/supabase/client";
import { isValidEmail } from "@/lib/email";

/**
 * The one write that adds phones and emails to a job's own list
 * (`job_contact_methods`). The Customer card's "Phones & emails" panel and the
 * suggested-fields review both go through it, so a number accepted from a
 * customer's reply lands exactly as a typed one would.
 */
export type NewJobContactMethod = {
  kind: "phone" | "email";
  label?: string | null;
  value: string;
  extension?: string | null;
  is_preferred?: boolean;
};

/** An email that is filled in but is not an address — blank rows are skipped, not wrong. */
export function isBadContactEmail(m: { kind: string; value: string }): boolean {
  return m.kind === "email" && m.value.trim() !== "" && !isValidEmail(m.value);
}

/** The message to show when any of these would save a non-address as an email. */
export function contactMethodsError(methods: { kind: string; value: string }[]): string | null {
  const bad = methods.find(isBadContactEmail);
  return bad ? `"${bad.value.trim()}" is not a valid email address.` : null;
}

export async function insertJobContactMethods(
  jobId: string,
  methods: NewJobContactMethod[],
): Promise<void> {
  const invalid = contactMethodsError(methods);
  if (invalid) throw new Error(invalid);
  const payload = methods
    .filter((m) => m.value.trim())
    .map((m) => ({
      job_id: jobId,
      kind: m.kind,
      label: m.label || null,
      value: m.value.trim(),
      extension: m.extension?.trim() || null,
      is_preferred: m.is_preferred ?? false,
    }));
  if (!payload.length) return;
  const { error } = await supabase.from("job_contact_methods").insert(payload);
  if (error) throw error;
}
