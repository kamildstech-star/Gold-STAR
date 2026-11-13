/**
 * Report share links — a filed report, sent as a link (David, 13 Oct: "the
 * drying report shareable via a link I can send to the insurance company").
 *
 * Same table, token, expiry, revoke and public page as the schedule and photo
 * links (`share_links`, /share/<token>); the link names ONE filed PDF in
 * `document_ids`, and the public byte route serves that file and nothing else.
 * Pure rules here; the insert is below, the reads are in job-share.functions
 * and the byte route.
 */
import { supabase } from "@/integrations/supabase/client";
import { jobShareUrl, newShareToken } from "@/lib/job-share-links";

export const DRYING_REPORT_SHARE_KIND = "job_drying_report";
export const REPORT_SHARE_DAYS = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * May this report link hand out this file? Only a live link of the report
 * kind, only the document it names, and only a PDF filed on the link's own
 * job. Anything else is the same "not part of this link" as a wrong id.
 */
export function reportShareServes(
  link: {
    kind: string;
    job_id: string | null;
    expires_at: string;
    revoked_at: string | null;
    document_ids: string[] | null;
  },
  documentId: string,
  doc: { job_id: string | null; mime: string | null; storage_path: string | null } | null,
  now = Date.now(),
): "ok" | "not_found" | "revoked" | "expired" {
  if (link.kind !== DRYING_REPORT_SHARE_KIND || !link.job_id) return "not_found";
  if (link.revoked_at) return "revoked";
  if (new Date(link.expires_at).getTime() < now) return "expired";
  if (!UUID.test(documentId) || !(link.document_ids ?? []).includes(documentId)) return "not_found";
  if (!doc || doc.job_id !== link.job_id || !doc.storage_path) return "not_found";
  if ((doc.mime ?? "").toLowerCase() !== "application/pdf") return "not_found";
  return "ok";
}

/** Where the public page fetches the report's bytes — the share byte route. */
export function reportShareFileHref(token: string, documentId: string): string {
  return `/api/share/${token}/photo/${documentId}`;
}

/** Make a link to one filed drying report. RLS: whoever can manage the job. */
export async function createDryingReportShareLink(input: {
  jobId: string;
  documentId: string;
  userId: string | null;
  expiresInDays?: number;
  note?: string | null;
}): Promise<{ id: string; token: string; url: string }> {
  const token = newShareToken();
  const days = Math.max(1, input.expiresInDays ?? REPORT_SHARE_DAYS);
  const { data, error } = await supabase
    .from("share_links")
    .insert({
      job_id: input.jobId,
      // Newer than the generated enum until 20261014121000 is applied.
      kind: DRYING_REPORT_SHARE_KIND as never,
      token,
      created_by: input.userId,
      expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
      note: input.note ?? null,
      document_ids: [input.documentId],
    } as never)
    .select("id, token")
    .single();
  if (error) throw error;
  const row = data as { id: string; token: string };
  return { id: row.id, token: row.token, url: jobShareUrl(row.token) };
}
