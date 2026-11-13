/**
 * Public signing surface.
 *
 * The customer is not a user of this system, so these functions are
 * deliberately unauthenticated and the token is the only credential. Every
 * call re-checks it: unknown, revoked, expired and completed tokens return
 * nothing. What comes back is the minimum needed to read and sign — document
 * wording and office branding, never job financials, internal notes or staff
 * detail.
 *
 * Signing is one-way. Once a signature lands the document is hashed and
 * locked; a second submission on the same token is refused rather than
 * silently overwriting evidence.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import type { Json } from "@/integrations/supabase/types";

export type PublicSignDocument = {
  id: string;
  name: string;
  body: string;
  requiresSignature: boolean;
  signed: boolean;
};

export type PublicSignField = { key: string; label: string; value: string | null };

export type PublicSignPayload = {
  ok: boolean;
  reason?: "not_found" | "revoked" | "expired" | "completed";
  companyName?: string;
  officeName?: string | null;
  officeLogoUrl?: string | null;
  officePhone?: string | null;
  officeEntityName?: string | null;
  officePaymentLink?: string | null;
  officeZelleEmail?: string | null;
  recipientName?: string | null;
  message?: string | null;
  subject?: string | null;
  jobNumber?: string | null;
  documents?: PublicSignDocument[];
  fields?: PublicSignField[];
};

async function adminClient() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

function validToken(token: unknown): string {
  if (typeof token !== "string" || token.length < 16) throw new Error("Invalid link.");
  return token;
}

async function loadPacket(token: string) {
  const db = await adminClient();
  const { data } = await db
    .from("document_send_packets")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  return { db, packet: data };
}

export const loadSignPacket = createServerFn({ method: "GET" })
  .inputValidator((data: { token: string }) => ({ token: validToken(data?.token) }))
  .handler(async ({ data }): Promise<PublicSignPayload> => {
    /* Fails OPEN. The token is the credential and it is not guessable; a
       counter store that is down must not stop a customer opening a contract
       they were sent. */
    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    await guardPublicServerFn("sign:read", RATE_LIMITS.publicTokenRead, "open");

    const { db, packet } = await loadPacket(data.token);
    if (!packet) return { ok: false, reason: "not_found" };
    if (packet.revoked_at) return { ok: false, reason: "revoked" };
    if (
      !packet.expires_at ||
      !Number.isFinite(Date.parse(packet.expires_at)) ||
      Date.parse(packet.expires_at) <= Date.now()
    )
      return { ok: false, reason: "expired" };
    // A single-use link dies at the first completed submission; a reusable one
    // stays open so a second recipient can fill the same form.
    if (packet.completed_at && packet.single_use !== false)
      return { ok: false, reason: "completed" };

    const { data: items } = await db
      .from("document_send_items")
      .select("document_id, requires_signature, sort_order")
      .eq("packet_id", packet.id)
      .order("sort_order");

    const ids = (items ?? []).map((i) => i.document_id);
    const { data: docs, error: docsError } = await db
      .from("documents")
      .select("id, name, rendered_body, status")
      .in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])
      .eq("location_id", packet.location_id);
    // Item membership alone is not authorization: packet editors can name a
    // document ID from another office. Never read or mark those documents viewed.
    if (docsError || (docs ?? []).length !== new Set(ids).size)
      return { ok: false, reason: "not_found" };

    // Branding follows the job's billing entity, never the operating office.
    const { data: job } = packet.job_id
      ? await db
          .from("jobs")
          .select("job_number, billing_location_id")
          .eq("id", packet.job_id)
          .maybeSingle()
      : { data: null };

    const brandLocationId = job?.billing_location_id ?? packet.location_id;
    const { data: loc } = await db
      .from("locations")
      .select("name, legal_entity_name, office_phone, logo_url, card_payment_url, zelle_email")
      .eq("id", brandLocationId)
      .maybeSingle();

    // First open is recorded once, and on the documents too so the office sees
    // "Viewed" on the record itself rather than only inside the packet.
    if (!packet.first_viewed_at) {
      const now = new Date().toISOString();
      await db.from("document_send_packets").update({ first_viewed_at: now }).eq("id", packet.id);
      if (ids.length) {
        await db
          .from("documents")
          .update({ first_viewed_at: now })
          .in("id", ids)
          .is("first_viewed_at", null);
        for (const id of ids) {
          await db.from("document_events").insert({
            document_id: id,
            event_type: "viewed",
            actor_label: packet.recipient_email ?? "Form link recipient",
            user_agent: getRequestHeader("user-agent") ?? null,
            detail: { packet_id: packet.id } as never,
          });
        }
      }
    }

    const values = (packet.field_values ?? {}) as Record<string, string>;
    const documents: PublicSignDocument[] = (items ?? []).map((i) => {
      const d = (docs ?? []).find((x) => x.id === i.document_id);
      return {
        id: i.document_id,
        name: d?.name ?? "Document",
        body: d?.rendered_body ?? "",
        requiresSignature: i.requires_signature,
        signed: d?.status === "signed",
      };
    });

    return {
      ok: true,
      companyName: "Gold Star Restoration",
      officeName: loc?.name ?? null,
      officeLogoUrl: loc?.logo_url ?? null,
      officePhone: loc?.office_phone ?? null,
      officeEntityName: loc?.legal_entity_name ?? loc?.name ?? null,
      officePaymentLink: loc?.card_payment_url ?? null,
      officeZelleEmail: loc?.zelle_email ?? null,
      recipientName: packet.recipient_name,
      message: packet.message,
      subject: packet.subject,
      jobNumber: job?.job_number ?? null,
      documents,
      fields: ((packet.required_fields ?? []) as { key: string; label: string }[]).map((f) => ({
        key: f.key,
        label: f.label,
        value: values[f.key] ?? null,
      })),
    };
  });

export type SubmitSignatureInput = {
  token: string;
  signerName: string;
  signerRole?: string | null;
  signerEmail?: string | null;
  /** PNG data URL from the signature pad, or a rendered typed signature. */
  signatureDataUrl: string;
  fieldValues: Record<string, string>;
};

export const submitSignPacket = createServerFn({ method: "POST" })
  .inputValidator((data: SubmitSignatureInput) => {
    const token = validToken(data?.token);
    const signerName = (data.signerName ?? "").trim();
    if (signerName.length < 2 || signerName.length > 120)
      throw new Error("Enter the full name of the person signing.");
    if (!data.signatureDataUrl?.startsWith("data:image/png"))
      throw new Error("A signature is required.");
    if (data.signatureDataUrl.length > 400_000) throw new Error("Signature image is too large.");
    const email = (data.signerEmail ?? "").trim().slice(0, 255) || null;
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(data.fieldValues ?? {})) {
      values[String(k).slice(0, 80)] = String(v ?? "").slice(0, 500);
    }
    return {
      token,
      signerName,
      signerRole: (data.signerRole ?? "").trim().slice(0, 80) || null,
      signerEmail: email,
      signatureDataUrl: data.signatureDataUrl,
      fieldValues: values,
    };
  })
  .handler(async ({ data }) => {
    // Signing renders a PDF and writes evidence, so it is the most expensive
    // unauthenticated call in the app. It fails CLOSED: with the counter store
    // down the limiter is the only thing in front of an anonymous writer, and
    // the signing transaction below needs the same database anyway. A refused
    // customer can retry; an unthrottled token endpoint cannot be taken back.
    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    await guardPublicServerFn("sign:write", RATE_LIMITS.publicTokenWrite, "closed");

    const { db, packet } = await loadPacket(data.token);
    if (!packet) throw new Error("This link is not valid.");
    if (packet.revoked_at) throw new Error("This request has been withdrawn.");
    if (packet.completed_at && packet.single_use !== false)
      throw new Error("These documents have already been signed.");
    if (
      !packet.expires_at ||
      !Number.isFinite(Date.parse(packet.expires_at)) ||
      Date.parse(packet.expires_at) <= Date.now()
    )
      throw new Error("This link has expired. Ask your Gold Star contact for a new one.");

    const missing = ((packet.required_fields ?? []) as { key: string; label: string }[]).filter(
      (f) => !(data.fieldValues[f.key] ?? "").trim(),
    );
    if (missing.length)
      throw new Error(`Please complete: ${missing.map((m) => m.label).join(", ")}`);

    const { data: items } = await db
      .from("document_send_items")
      .select("document_id, requires_signature, sort_order")
      .eq("packet_id", packet.id)
      .order("sort_order");

    // Resolve the entire packet inside its office before generating or writing
    // any evidence. Fail the whole request if even one item is outside scope.
    const ids = [...new Set((items ?? []).map((item) => item.document_id))];
    const { data: docs, error: docsError } = await db
      .from("documents")
      .select("id, name, rendered_body, storage_path, status, doc_type, locked_at")
      .in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])
      .eq("location_id", packet.location_id);
    if (docsError || (docs ?? []).length !== ids.length) throw new Error("This link is not valid.");

    const { data: brandJob } = packet.job_id
      ? await db
          .from("jobs")
          .select("id, job_number, billing_location_id")
          .eq("id", packet.job_id)
          .maybeSingle()
      : { data: null };

    const { data: loc } = await db
      .from("locations")
      .select(
        "name, legal_entity_name, address, locality, region, postal_code, office_phone, office_email, ein, logo_url",
      )
      .eq("id", brandJob?.billing_location_id ?? packet.location_id)
      .maybeSingle();

    let logo: Uint8Array | null = null;
    let logoMime: string | null = null;
    if (loc?.logo_url) {
      try {
        const res = await fetch(loc.logo_url);
        if (res.ok) {
          logo = new Uint8Array(await res.arrayBuffer());
          logoMime = res.headers.get("content-type");
        }
      } catch {
        // Branding is cosmetic; never block a signature on it.
      }
    }

    const { buildContractPdf, dataUrlToBytes } = await import("./contract-pdf");
    const { sha256Hex } = await import("./document-templates");

    const signedAtIso = new Date().toISOString();
    // Evidence: only an address this host wrote itself, already checked to be
    // one (client-ip.server.ts) — never a header the signer could have typed.
    const { clientIp } = await import("./client-ip.server");
    const ip = clientIp(getRequestHeader);
    const userAgent = getRequestHeader("user-agent") ?? null;
    const cityLine = [loc?.locality, loc?.region, loc?.postal_code].filter(Boolean).join(", ");

    const filledFields = ((packet.required_fields ?? []) as { key: string; label: string }[]).map(
      (f) => [f.label, data.fieldValues[f.key] ?? ""] as [string, string],
    );

    // Every attempt writes to its own folder, never over a fixed path. With
    // `${doc.id}/signed.pdf` and `upsert: true`, two overlapping submissions
    // (a double tap, two tabs, a retry racing the original) each overwrote the
    // other's PDF and signature image, so the stored evidence could belong to
    // the attempt the database did not record. The paths are part of what
    // `complete_document_signing_atomic` checks, so it only ever publishes the
    // attempt that won the lock. A losing attempt leaves orphaned objects
    // behind; it can never replace the winner's.
    const attemptId = crypto.randomUUID();
    const evidence: Record<string, Json>[] = [];

    for (const item of items ?? []) {
      const doc = (docs ?? []).find((document) => document.id === item.document_id);
      // The transaction counts exactly these documents (not signed, not
      // locked), so the two filters must agree or every attempt is refused.
      if (!doc || doc.status === "signed" || doc.locked_at) continue;

      const pdfBytes = await buildContractPdf({
        title: doc.name,
        body: doc.rendered_body ?? "",
        meta: [
          ["Document", doc.name],
          ["Reference", packet.id.slice(0, 8).toUpperCase()],
          ["Prepared for", packet.recipient_name ?? packet.recipient_email ?? data.signerName],
        ],
        brand: {
          companyName: "Gold Star Restoration",
          legalEntityName: loc?.legal_entity_name ?? null,
          officeName: loc?.name ?? null,
          address: [loc?.address, cityLine].filter(Boolean).join(", ") || null,
          phone: loc?.office_phone ?? null,
          email: loc?.office_email ?? null,
          ein: loc?.ein ?? null,
          logo,
          logoMime,
        },
        filledFields,
        signature: item.requires_signature
          ? {
              signerName: data.signerName,
              signerRole: data.signerRole,
              signerEmail: data.signerEmail,
              signedAtIso,
              signatureDataUrl: data.signatureDataUrl,
              ip,
              userAgent,
            }
          : null,
      });

      const pdfPath = `${doc.id}/${attemptId}/signed.pdf`;
      const sigPath = `${doc.id}/${attemptId}/signature.png`;
      const blob = new Blob([pdfBytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
      // Upload results were ignored before, so a failed upload still marked the
      // document signed against a file that did not exist.
      const { error: pdfError } = await db.storage
        .from("documents")
        .upload(pdfPath, blob, { contentType: "application/pdf", upsert: false });
      if (pdfError) throw new Error("The signed document could not be stored. Please try again.");

      if (item.requires_signature) {
        const sigBytes = dataUrlToBytes(data.signatureDataUrl);
        const { error: sigError } = await db.storage.from("documents").upload(sigPath, sigBytes, {
          contentType: "image/png",
          upsert: false,
        });
        if (sigError) throw new Error("The signature could not be stored. Please try again.");
      }

      evidence.push({
        document_id: doc.id,
        name: doc.name,
        rendered_body: doc.rendered_body,
        requires_signature: item.requires_signature,
        pdf_path: pdfPath,
        signature_path: item.requires_signature ? sigPath : null,
        size_bytes: blob.size,
        hash: await sha256Hex(pdfBytes),
      });
    }

    // One transaction (migration 20260908014000) locks the packet and its
    // documents, re-checks the token, writes the documents, signatures,
    // events and job note, and consumes the link. These used to be separate
    // writes whose errors were never read, so a single-use link could be
    // completed twice and a half-finished attempt left a document "signed"
    // with no signature row. There is no fallback to separate writes: if the
    // function is missing or refuses, nothing is published.
    const { data: signed, error: commitError } = await db.rpc("complete_document_signing_atomic", {
      _token: data.token,
      _packet_id: packet.id,
      _attempt_id: attemptId,
      _evidence: evidence,
      _submission: {
        signer_name: data.signerName,
        signer_role: data.signerRole,
        signer_email: data.signerEmail ?? packet.recipient_email ?? null,
        signed_at: signedAtIso,
        field_values: data.fieldValues,
        // The column is inet: anything that is not an address would abort the
        // whole transaction, and the address is evidence, not a gate.
        ip,
        user_agent: userAgent,
        // Must equal the packet row exactly; a packet edited between our read
        // and the commit is refused rather than signed against stale scope.
        packet_scope: {
          location_id: packet.location_id,
          job_id: packet.job_id,
          recipient_name: packet.recipient_name ?? null,
          recipient_email: packet.recipient_email ?? null,
        },
      },
    });
    if (commitError || typeof signed !== "number" || !Number.isInteger(signed) || signed < 0) {
      if (commitError)
        console.error("[sign] complete_document_signing_atomic refused:", commitError);
      throw new Error(
        "Signing could not be completed. The link or documents may have changed; reopen the link and try again.",
      );
    }
    return { ok: true, signed };
  });
