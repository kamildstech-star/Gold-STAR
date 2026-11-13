import { supabase } from "@/integrations/supabase/client";
import { signStoredFile, type SignedUrlLife } from "@/lib/signed-url";

/**
 * Two very different pieces of paper hang off one compliance requirement.
 *
 * The *sample* is what the client sent us — their vendor insurance schedule,
 * a specimen COI, the endorsement wording they insist on. It is an instruction
 * to our agent, not proof of anything, and there can be several of them.
 *
 * The *certificate* is the document that actually satisfies the requirement.
 * It has a policy number and an expiry, and it is never overwritten: a renewal
 * supersedes the previous one so the old certificate stays as evidence of what
 * we held at the time of a job.
 */

export const COMPLIANCE_FILE_BUCKET = "compliance-files";

export type ComplianceSlot = "sample" | "certificate";

export type ComplianceFile = {
  id: string;
  requirement_id: string;
  account_id: string;
  slot: ComplianceSlot;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  version: number;
  is_current: boolean;
  superseded_at: string | null;
  issuer: string | null;
  policy_number: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  covered_amount: number | null;
  currency: string;
  notes: string | null;
  sent_to_agent_at: string | null;
  cert_sent_at: string | null;
  cert_sent_to: string | null;
  cert_sent_by: string | null;
  uploaded_by: string | null;
  created_at: string;
};

const SELECT =
  "id, requirement_id, account_id, slot, storage_path, file_name, mime_type, size_bytes, version, is_current, superseded_at, issuer, policy_number, effective_date, expiry_date, covered_amount, currency, notes, sent_to_agent_at, cert_sent_at, cert_sent_to, cert_sent_by, uploaded_by, created_at";

export async function fetchRequirementFiles(requirementId: string): Promise<ComplianceFile[]> {
  const { data, error } = await supabase
    .from("compliance_requirement_files")
    .select(SELECT)
    .eq("requirement_id", requirementId)
    .order("version", { ascending: false })
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as ComplianceFile[];
}

function safeName(name: string) {
  return name.replace(/[^\w.-]+/g, "_").slice(-80);
}

export type CertificateMeta = {
  issuer?: string | null;
  policyNumber?: string | null;
  effectiveDate?: string | null;
  expiryDate?: string | null;
  coveredAmount?: number | null;
  currency?: string;
};

/**
 * Uploads one file into the requirement's folder. A new certificate supersedes
 * the current one rather than replacing the bytes, so history survives.
 */
export async function uploadRequirementFile(input: {
  requirementId: string;
  accountId: string;
  slot: ComplianceSlot;
  file: File;
  userId: string | null;
  meta?: CertificateMeta;
}): Promise<ComplianceFile> {
  const { requirementId, accountId, slot, file } = input;
  const path = `${accountId}/${requirementId}/${slot}/${Date.now()}-${safeName(file.name)}`;

  const up = await supabase.storage
    .from(COMPLIANCE_FILE_BUCKET)
    .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
  if (up.error) throw up.error;

  let version = 1;
  let previousId: string | null = null;
  if (slot === "certificate") {
    const existing = await fetchRequirementFiles(requirementId);
    const certs = existing.filter((f) => f.slot === "certificate");
    version = certs.length ? Math.max(...certs.map((c) => c.version)) + 1 : 1;
    previousId = certs.find((c) => c.is_current)?.id ?? null;
  }

  const { data, error } = await supabase
    .from("compliance_requirement_files")
    .insert({
      requirement_id: requirementId,
      account_id: accountId,
      slot,
      storage_path: path,
      file_name: file.name,
      mime_type: file.type || null,
      size_bytes: file.size,
      version,
      is_current: true,
      issuer: input.meta?.issuer ?? null,
      policy_number: input.meta?.policyNumber ?? null,
      effective_date: input.meta?.effectiveDate || null,
      expiry_date: input.meta?.expiryDate || null,
      covered_amount: input.meta?.coveredAmount ?? null,
      currency: input.meta?.currency ?? "USD",
      uploaded_by: input.userId,
    })
    .select(SELECT)
    .single();
  if (error) throw error;

  if (previousId) {
    await supabase
      .from("compliance_requirement_files")
      .update({
        is_current: false,
        superseded_at: new Date().toISOString(),
        superseded_by: (data as { id: string }).id,
      })
      .eq("id", previousId);
  }

  return data as unknown as ComplianceFile;
}

/** Ten minutes unless `life` says otherwise — and a longer life says why. */
export async function signedComplianceUrl(
  path: string,
  life: SignedUrlLife = {},
): Promise<string | null> {
  const { data } = await signStoredFile(supabase, COMPLIANCE_FILE_BUCKET, path, life);
  return data?.signedUrl ?? null;
}

export async function removeRequirementFile(file: ComplianceFile) {
  await supabase.storage.from(COMPLIANCE_FILE_BUCKET).remove([file.storage_path]);
  const { error } = await supabase.from("compliance_requirement_files").delete().eq("id", file.id);
  if (error) throw error;
}

/** Where "Send to agent" goes. Configured once, in Admin. */
export async function fetchAgentEmail(): Promise<string | null> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "insurance_agent_email")
    .maybeSingle();
  const v = data?.value as unknown;
  return typeof v === "string" ? v : ((v as { email?: string } | null)?.email ?? null);
}

export async function saveAgentEmail(email: string, userId: string | null) {
  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: "insurance_agent_email", value: email as never, updated_by: userId },
      { onConflict: "key" },
    );
  if (error) throw error;
}

export function markSentToAgent(fileIds: string[], userId: string | null) {
  return supabase
    .from("compliance_requirement_files")
    .update({ sent_to_agent_at: new Date().toISOString(), sent_to_agent_by: userId })
    .in("id", fileIds);
}

/** Per-company address the current certificate is emailed to. */
export async function fetchCertificatesEmail(accountId: string): Promise<string | null> {
  const { data } = await supabase
    .from("accounts")
    .select("certificates_email")
    .eq("id", accountId)
    .maybeSingle();
  return (data as { certificates_email?: string | null } | null)?.certificates_email ?? null;
}

export async function saveCertificatesEmail(accountId: string, email: string | null) {
  const { error } = await supabase
    .from("accounts")
    .update({ certificates_email: email })
    .eq("id", accountId);
  if (error) throw error;
}

/** Records that the certificate itself went out — who sent it, where, and when. */
export function markCertificateSent(fileId: string, to: string, userId: string | null) {
  return supabase
    .from("compliance_requirement_files")
    .update({ cert_sent_at: new Date().toISOString(), cert_sent_to: to, cert_sent_by: userId })
    .eq("id", fileId);
}
