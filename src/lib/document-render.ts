/**
 * Rendering a document row that has no file in storage.
 *
 * A templated document only gets a PDF written to storage when it is signed —
 * `document-sign.functions.ts` is the only place that sets `storage_path` for
 * one. Before signing the row is all there is: the merge-resolved wording, the
 * merge data it was resolved with, and the template version it came from. So
 * the PDF is built here, on demand, from that row.
 *
 * It is built from the row's own `rendered_body` and never by re-resolving the
 * template. A contract is a legal document and templates get edited; rendering
 * today's wording would show a customer or an adjuster something other than
 * what was sent and signed. When the row preserved no wording there is nothing
 * honest to draw, and it says so rather than substituting the live template.
 *
 * `client` exists because `/api/documents/$id/file` renders this server-side
 * from the caller's own Supabase client, so RLS decides what it may read. The
 * browser default keeps every existing call site unchanged.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { buildContractPdf } from "./contract-pdf";
import { contractBrandFrom, loadBrandLogo } from "./contract-signing";
import { loadLocationBrand, type MergeData } from "./document-templates";

export type OnDemandRender = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

/**
 * The send dialog stamps its own preview the same way. An unsigned render must
 * never be mistaken for the executed document, so every state short of signed
 * says so on every page.
 */
function previewNote(status: string): string | null {
  if (status === "signed") return null;
  if (status === "draft") return "PREVIEW — not yet sent";
  if (status === "sent" || status === "viewed" || status === "pending_signature") {
    return "PREVIEW — sent for signature, not yet signed";
  }
  return "PREVIEW — rendered from the wording stored on this record";
}

export async function renderDocumentOnDemand(
  documentId: string,
  client: SupabaseClient<Database> = supabase,
): Promise<OnDemandRender> {
  const { data, error } = await client
    .from("documents")
    .select("name, status, rendered_body, merge_data, location_id, template_version_id")
    .eq("id", documentId)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "This document could not be loaded." };

  if (!data.rendered_body?.trim()) {
    return {
      ok: false,
      reason: data.template_version_id
        ? "This record has no stored file, and the wording it was drafted from was never copied onto it — only a reference to the template it used. Templates get edited, so rendering today's version could show wording this document never carried. It is not shown for that reason."
        : "This record has no stored file and no wording of its own, so there is nothing to render.",
    };
  }

  const merge = (data.merge_data ?? {}) as MergeData;
  const brand = await loadLocationBrand(data.location_id, client).catch(() => null);
  const logo = await loadBrandLogo(brand?.logo_url ?? null);

  const bytes = await buildContractPdf({
    title: data.name,
    body: data.rendered_body,
    meta: [
      ["Document", data.name],
      ["Prepared for", merge["customer.name"] ?? "—"],
      ["Job", merge["job.number"] ?? "—"],
      ["Property", merge["property.address"] ?? "—"],
    ],
    brand: contractBrandFrom(brand, logo),
    footerNote: previewNote(data.status),
  });
  return { ok: true, bytes };
}
