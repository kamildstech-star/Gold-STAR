/**
 * Link merge keys.
 *
 * {SignatureLink}, {FormLink}, {PortalLink} and {DocumentLink} cannot resolve
 * while a template is being written — the URL has to be a fresh unguessable
 * token minted for one recipient at send time, honouring the template's expiry
 * setting. This module does that minting and records who each link went to, so
 * the packet history answers "which link did we send this person" exactly.
 */
import { supabase } from "@/integrations/supabase/client";
import { createFormLink, formLinkDefaults } from "./form-links";
import { listTemplates, logDocumentEvent } from "./document-templates";
import { signUrl } from "./document-send";

export type LinkKind = "SignatureLink" | "FormLink" | "PortalLink" | "DocumentLink";

const LINK_TOKENS: LinkKind[] = ["SignatureLink", "FormLink", "PortalLink", "DocumentLink"];

export function linkKeysUsed(text: string): LinkKind[] {
  return LINK_TOKENS.filter((k) => text.includes(`{${k}}`) || text.includes(`{{${k}}}`));
}

export type MintLinksInput = {
  jobId: string;
  locationId: string;
  text: string;
  recipientEmail: string | null;
  recipientName: string | null;
  /** Template's expiry setting; falls back to the app-wide form link default. */
  expiresInDays?: number | null;
  singleUse?: boolean | null;
  userId: string | null;
};

export type MintedLink = { key: LinkKind; url: string; packetId: string | null };

/**
 * Mints one packet per distinct link kind used in the message and returns the
 * URLs. Signature links require a signature; form and portal links do not.
 */
export async function mintLinkKeys(input: MintLinksInput): Promise<MintedLink[]> {
  const used = linkKeysUsed(input.text);
  if (!used.length) return [];

  const defaults = await formLinkDefaults();
  const expiresInDays =
    input.expiresInDays && input.expiresInDays > 0 ? input.expiresInDays : defaults.expires_in_days;
  const singleUse = input.singleUse ?? defaults.single_use;

  const templates = (await listTemplates(input.locationId)).filter((t) => t.is_active !== false);
  const signable = templates.filter((t) =>
    ["contract", "work_authorization", "service_agreement"].includes(String(t.doc_type)),
  );

  const out: MintedLink[] = [];

  for (const key of used) {
    if (key === "DocumentLink") {
      // The most recent generated document on this job, viewed through its packet.
      const { data: doc } = await supabase
        .from("documents")
        .select("id, storage_path")
        .eq("job_id", input.jobId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!doc) continue;
      const { data: item } = await supabase
        .from("document_send_items")
        .select("packet_id, packet:document_send_packets(token)")
        .eq("document_id", doc.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const token = (item as { packet?: { token?: string } } | null)?.packet?.token ?? null;
      const url = token ? signUrl(token) : null;
      if (!url) continue;
      out.push({ key, url, packetId: (item?.packet_id as string | null) ?? null });
      await logDocumentEvent(doc.id, "sent", {
        link_key: key,
        to: input.recipientEmail,
      });
      continue;
    }

    const requireSignature = key === "SignatureLink";
    const templateIds = (requireSignature ? signable : templates).slice(0, 1).map((t) => t.id);
    if (!templateIds.length) continue;

    const { packet, url } = await createFormLink({
      jobId: input.jobId,
      locationId: input.locationId,
      templateIds,
      requireSignature,
      expiresInDays,
      singleUse,
      recipientName: input.recipientName,
      recipientEmail: input.recipientEmail,
      requiredFields: [],
      userId: input.userId,
    });
    out.push({ key, url, packetId: packet.id });
  }

  return out;
}

/** Substitutes the minted URLs as anchors into the outgoing HTML. */
export function applyMintedLinks(html: string, minted: MintedLink[]): string {
  let out = html;
  for (const m of minted) {
    const anchor = `<a href="${m.url}">${m.url}</a>`;
    out = out.replaceAll(`{{${m.key}}}`, anchor).replaceAll(`{${m.key}}`, anchor);
  }
  return out;
}
