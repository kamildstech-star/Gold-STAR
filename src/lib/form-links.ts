/**
 * Per-job form links.
 *
 * A form link is one tokenised public URL that renders one or more templates
 * as a fillable / signable form for someone who has no login. The token is the
 * only credential and carries no data, so the URL exposes exactly one job's
 * paperwork and nothing else — no navigation, no ids, no customer detail.
 *
 * Everything the form shows is merged from the job, and the entity, logo,
 * phone and payment details come from the job's *billing* location, so an NJ
 * job's form shows the NJ entity even when another office is doing the work.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  currentVersion,
  listTemplates,
  loadLocationBrand,
  logDocumentEvent,
  mergeDataForLocation,
  renderTemplate,
  stripLogoToken,
} from "./document-templates";
import { loadJobMergeContext } from "./merge-keys";
import { newToken, signUrl, type SendPacket } from "./document-send";

export type FormLinkDefaults = { expires_in_days: number; single_use: boolean };

const FALLBACK_DEFAULTS: FormLinkDefaults = { expires_in_days: 30, single_use: true };

export async function formLinkDefaults(): Promise<FormLinkDefaults> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "form_link_defaults")
    .maybeSingle();
  const v = (data?.value ?? {}) as Partial<FormLinkDefaults>;
  return {
    expires_in_days: Number(v.expires_in_days) > 0 ? Number(v.expires_in_days) : 30,
    single_use: v.single_use !== false,
  };
}

export { FALLBACK_DEFAULTS as FORM_LINK_FALLBACK_DEFAULTS };

/** Templates a form link can be built from — all types, not just contracts. */
export async function formTemplates(locationId?: string | null) {
  const rows = await listTemplates(locationId);
  return rows.filter((t) => t.is_active !== false);
}

export type CreateFormLinkInput = {
  jobId: string;
  /** Operating location — used only as a fallback for branding. */
  locationId: string;
  templateIds: string[];
  requireSignature: boolean;
  expiresInDays: number;
  singleUse: boolean;
  recipientName: string | null;
  recipientEmail: string | null;
  requiredFields: { key: string; label: string }[];
  userId: string | null;
};

export type FormLinkResult = { packet: SendPacket; url: string };

/**
 * Renders the chosen templates against the job, files the generated documents
 * on the job, and mints the link. The link starts in "Created" — it only
 * becomes "Sent" once someone actually shares it.
 */
export async function createFormLink(input: CreateFormLinkInput): Promise<FormLinkResult> {
  if (!input.templateIds.length) throw new Error("Pick at least one template.");

  const ctx = await loadJobMergeContext(input.jobId);

  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id, job_number, billing_location_id, location_id")
    .eq("id", input.jobId)
    .maybeSingle();
  if (jobError) throw jobError;

  const brandLocationId = job?.billing_location_id ?? job?.location_id ?? input.locationId;
  const brand = brandLocationId ? await loadLocationBrand(brandLocationId) : null;
  const mergeData = { ...ctx.data, ...mergeDataForLocation(brand) };

  const documentIds: string[] = [];
  const names: string[] = [];

  for (const templateId of input.templateIds) {
    const version = await currentVersion(templateId);
    if (!version) throw new Error("That template has no published version yet.");
    const { data: tpl, error: tplError } = await supabase
      .from("document_templates")
      .select("id, name, doc_type")
      .eq("id", templateId)
      .maybeSingle();
    if (tplError) throw tplError;
    if (!tpl) throw new Error("Template not found.");

    const rendered = stripLogoToken(renderTemplate(version.body, mergeData));
    const name = `${tpl.name}${job?.job_number ? ` — ${job.job_number}` : ""}`;

    const { data: doc, error } = await supabase
      .from("documents")
      .insert({
        location_id: brandLocationId,
        job_id: input.jobId,
        doc_type: tpl.doc_type,
        name,
        status: "draft",
        template_id: tpl.id,
        template_version_id: version.id,
        rendered_body: rendered,
        merge_data: mergeData as never,
        created_by: input.userId,
      })
      .select("id")
      .single();
    if (error) throw error;

    await logDocumentEvent(doc.id, "generated", {
      template_id: tpl.id,
      version: version.version,
      via: "form_link",
    });
    documentIds.push(doc.id);
    names.push(tpl.name);
  }

  const token = newToken();
  const { data: packet, error: packetError } = await supabase
    .from("document_send_packets")
    .insert({
      location_id: brandLocationId,
      job_id: input.jobId,
      token,
      recipient_email: input.recipientEmail?.trim() || null,
      recipient_name: input.recipientName?.trim() || null,
      subject: names.join(" · "),
      message: null,
      required_fields: input.requiredFields as never,
      single_use: input.singleUse,
      expires_at: new Date(Date.now() + input.expiresInDays * 86400_000).toISOString(),
      created_by: input.userId,
    })
    .select("*")
    .single();
  if (packetError) throw packetError;

  const items = documentIds.map((id, i) => ({
    packet_id: packet.id,
    document_id: id,
    requires_signature: input.requireSignature,
    sort_order: i,
  }));
  const { error: itemError } = await supabase.from("document_send_items").insert(items);
  if (itemError) throw itemError;

  return { packet: packet as SendPacket, url: signUrl(token) };
}

/** The first time a link is copied or emailed it stops being a draft. */
export async function markFormLinkSent(packetId: string): Promise<void> {
  const { error } = await supabase
    .from("document_send_packets")
    .update({ sent_at: new Date().toISOString() })
    .eq("id", packetId)
    .is("sent_at", null);
  if (error) throw error;
}

/**
 * Regenerating mints a fresh token over the same documents and retires the old
 * one, so a link that leaked or expired can be replaced without re-rendering.
 */
export async function regenerateFormLink(
  packet: SendPacket & { items?: { document_id: string; requires_signature: boolean }[] },
  userId: string | null,
): Promise<FormLinkResult> {
  const items =
    packet.items ??
    (
      await supabase
        .from("document_send_items")
        .select("document_id, requires_signature, sort_order")
        .eq("packet_id", packet.id)
        .order("sort_order")
    ).data ??
    [];

  const token = newToken();
  const days = Math.max(
    1,
    Math.round(
      (new Date(packet.expires_at).getTime() - new Date(packet.created_at).getTime()) / 86400_000,
    ) || 30,
  );

  const { data: fresh, error } = await supabase
    .from("document_send_packets")
    .insert({
      location_id: packet.location_id,
      job_id: packet.job_id,
      account_id: packet.account_id,
      token,
      recipient_email: packet.recipient_email,
      recipient_name: packet.recipient_name,
      subject: packet.subject,
      message: packet.message,
      required_fields: packet.required_fields as never,
      single_use: packet.single_use,
      expires_at: new Date(Date.now() + days * 86400_000).toISOString(),
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw error;

  if (items.length) {
    const { error: itemError } = await supabase.from("document_send_items").insert(
      items.map((i, idx) => ({
        packet_id: fresh.id,
        document_id: i.document_id,
        requires_signature: i.requires_signature,
        sort_order: idx,
      })),
    );
    if (itemError) throw itemError;
  }

  const { error: retireError } = await supabase
    .from("document_send_packets")
    .update({ revoked_at: new Date().toISOString(), replaced_by_packet_id: fresh.id })
    .eq("id", packet.id);
  if (retireError) throw retireError;

  return { packet: fresh as SendPacket, url: signUrl(token) };
}
