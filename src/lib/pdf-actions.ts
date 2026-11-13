import { supabase } from "@/integrations/supabase/client";
import { DOCUMENT_BUCKET } from "@/lib/documents";
import type { Database } from "@/integrations/supabase/types";
import { signStoredFile, type SignedUrlLife } from "@/lib/signed-url";

type DocType = Database["public"]["Enums"]["document_type"];

export function pdfBlob(bytes: Uint8Array) {
  return new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
}

export function downloadPdf(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(pdfBlob(bytes));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Open in a hidden frame and fire the print dialog — no round trip to storage. */
export function printPdf(bytes: Uint8Array) {
  const url = URL.createObjectURL(pdfBlob(bytes));
  const frame = document.createElement("iframe");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.src = url;
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch {
      window.open(url, "_blank");
    }
  };
  document.body.appendChild(frame);
  setTimeout(() => {
    frame.remove();
    URL.revokeObjectURL(url);
  }, 120_000);
}

export type SavePdfInput = {
  bytes: Uint8Array;
  filename: string;
  name: string;
  description?: string | null;
  docType: DocType;
  locationId: string;
  jobId: string | null;
  accountId?: string | null;
  /** Set when the document is queued to go out by email. */
  sentTo?: string | null;
};

/**
 * Puts the generated PDF in the job's Documents tab. Regenerating overwrites
 * the same path so a job never accumulates five copies of ESTIMATE-1.
 */
export async function savePdfToDocuments(input: SavePdfInput): Promise<string> {
  const { data: auth } = await supabase.auth.getUser();
  const path = `${input.jobId ?? input.locationId}/${input.filename}`;
  const blob = pdfBlob(input.bytes);

  const up = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(path, blob, { contentType: "application/pdf", upsert: true });
  if (up.error) throw up.error;

  const existing = await supabase
    .from("documents")
    .select("id")
    .eq("storage_path", path)
    .maybeSingle();

  if (existing.data?.id) {
    const { error } = await supabase
      .from("documents")
      .update({
        name: input.name,
        description: input.description ?? null,
        size_bytes: blob.size,
        sent_to: input.sentTo ?? null,
      })
      .eq("id", existing.data.id);
    if (error) throw error;
    return existing.data.id;
  }

  const { data, error } = await supabase
    .from("documents")
    .insert({
      location_id: input.locationId,
      job_id: input.jobId,
      account_id: input.accountId ?? null,
      doc_type: input.docType,
      name: input.name,
      description: input.description ?? null,
      status: "draft",
      storage_bucket: DOCUMENT_BUCKET,
      storage_path: path,
      mime: "application/pdf",
      size_bytes: blob.size,
      sent_to: input.sentTo ?? null,
      created_by: auth.user?.id ?? null,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/**
 * A time-limited download link for a stored document.
 *
 * Signs the file that was actually stored rather than rebuilding the path —
 * the uploader owns that shape, and a guessed path signs nothing. The default
 * ten minutes; a caller putting the link in an email passes a longer life and
 * says why (src/lib/signed-url.ts).
 */
export async function signedDocumentUrl(
  documentId: string,
  life: SignedUrlLife = {},
): Promise<string> {
  const { data, error } = await supabase
    .from("documents")
    .select("storage_bucket, storage_path")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.storage_path) throw new Error("The generated file could not be found in storage.");
  const signed = await signStoredFile(
    supabase,
    data.storage_bucket ?? DOCUMENT_BUCKET,
    data.storage_path,
    life,
  );
  if (signed.error || !signed.data?.signedUrl) {
    throw signed.error ?? new Error("A download link for the file could not be created.");
  }
  return signed.data.signedUrl;
}

/**
 * Email is not wired yet — Graph credentials are still outstanding. We save the
 * exact bytes the recipient will get and record the intended address, so the
 * send is a one-liner once the mailbox lands. Nothing leaves the building here.
 */
export async function queuePdfEmail(input: SavePdfInput & { sentTo: string }) {
  return savePdfToDocuments(input);
}
