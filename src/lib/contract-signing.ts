/**
 * Signed-on-glass contract capture.
 *
 * A rep stands in a wet basement with one bar of signal and a homeowner ready
 * to sign. Nothing in this flow may wait on the network: the signature is
 * captured on the canvas, the PDF is rendered on the device with pdf-lib, and
 * the job is created locally with a client-generated id. Upload, document rows
 * and the homeowner's email queue in IndexedDB and flush when service returns.
 *
 * The signed version of the template is recorded on the document row, so we can
 * always prove which wording the customer agreed to.
 */
import { get as idbGet, set as idbSet, del as idbDel, entries as idbEntries } from "idb-keyval";
import { supabase } from "@/integrations/supabase/client";
import {
  brandAddressLine,
  currentVersion,
  loadLocationBrand,
  logDocumentEvent,
  mergeDataForJob,
  mergeDataForLocation,
  renderTemplate,
  stripLogoToken,
  sha256Hex,
  type DocumentTemplate,
  type DocumentTemplateVersion,
  type LocationBrand,
} from "./document-templates";
import { buildContractPdf, type ContractBrand } from "./contract-pdf";
import { DOCUMENT_BUCKET } from "./documents";

export type ContractJob = {
  id: string;
  job_number: string | null;
  job_name: string | null;
  customer_name: string | null;
  address: string | null;
  address_line2: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  loss_type: string | null;
  loss_date: string | null;
  scope: string | null;
  loss_description: string | null;
  insurance_carrier: string | null;
  claim_number: string | null;
  adjuster_name: string | null;
  estimated_amount: number | null;
  agreed_price: number | null;
  deductible: number | null;
  location_id: string;
  billing_location_id: string | null;
  account_id: string | null;
  primary_contact_id: string | null;
};

export type ContractCustomer = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

export type ContractContext = {
  job: ContractJob;
  customer: ContractCustomer;
  brand: LocationBrand | null;
  template: DocumentTemplate | null;
  version: DocumentTemplateVersion | null;
  /** Merge-resolved template body — the wording the customer is agreeing to. */
  body: string;
  /** True when the job row exists only on this device so far. */
  jobIsLocal: boolean;
};

const JOB_FIELDS =
  "id, job_number, job_name, customer_name, address, address_line2, locality, region, postal_code, loss_type, loss_date, scope, loss_description, insurance_carrier, claim_number, adjuster_name, estimated_amount, agreed_price, deductible, location_id, billing_location_id, account_id, primary_contact_id";

export function propertyAddress(
  job: Pick<ContractJob, "address" | "locality" | "region" | "postal_code">,
) {
  const city = [job.locality, job.region, job.postal_code].filter(Boolean).join(", ");
  return { line1: job.address ?? "—", line2: city || null };
}

export function money(n: number | null | undefined): string {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

/** Everything the signing page needs, in one round trip set. */
export async function loadContractContext(jobId: string): Promise<ContractContext> {
  const { data: job, error } = await supabase
    .from("jobs")
    .select(JOB_FIELDS)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  if (!job) throw new Error("Job not found");

  const j = job as unknown as ContractJob;

  const [customer, brand, template] = await Promise.all([
    loadCustomer(j),
    loadLocationBrand(j.billing_location_id ?? j.location_id).catch(() => null),
    loadContractTemplate(j.billing_location_id ?? j.location_id),
  ]);

  const version = template ? await currentVersion(template.id).catch(() => null) : null;
  const data = {
    ...mergeDataForJob(
      {
        ...j,
        address_line1: j.address,
        address_city: j.locality,
        address_state: j.region,
        address_zip: j.postal_code,
        carrier: j.insurance_carrier,
        customer_email: customer.email,
        customer_phone: customer.phone,
      } as never,
      brand?.legal_entity_name ?? brand?.name ?? "",

      brand?.name ?? null,
    ),
    ...mergeDataForLocation(brand),
  };

  return {
    job: j,
    customer,
    brand,
    template,
    version,
    body: version ? stripLogoToken(renderTemplate(version.body, data)) : DEFAULT_TERMS,
    jobIsLocal: false,
  };
}

async function loadCustomer(job: ContractJob): Promise<ContractCustomer> {
  if (job.primary_contact_id) {
    const { data } = await supabase
      .from("contacts")
      .select("full_name, email, phone")
      .eq("id", job.primary_contact_id)
      .maybeSingle();
    if (data) {
      return { name: data.full_name || job.customer_name, email: data.email, phone: data.phone };
    }
  }
  return { name: job.customer_name, email: null, phone: null };
}

async function loadContractTemplate(locationId: string): Promise<DocumentTemplate | null> {
  const { data } = await supabase
    .from("document_templates")
    .select("*")
    .in("doc_type", ["contract", "service_agreement"])
    .eq("is_active", true)
    .or(`location_id.is.null,location_id.eq.${locationId}`);
  if (!data?.length) return null;
  // An office-specific template beats the national one.
  return (
    (data.find((t) => t.location_id === locationId) as DocumentTemplate | undefined) ??
    (data[0] as DocumentTemplate)
  );
}

export const DEFAULT_TERMS = [
  "By signing below, I authorize Gold Star Restoration to perform the work described above and agree to the terms of this agreement.",
  "Gold Star Restoration bills the insurance carrier directly for covered work. Final payment is subject to carrier review and approval. The homeowner is responsible for any deductible and for any items not covered by the policy.",
  "I confirm that I am the owner of the property, or an agent authorized by the owner, and that I may lawfully authorize this work.",
].join("\n\n");

export const PAYMENT_NOTE =
  "Final payment is subject to carrier review and approval. Homeowner is responsible for any deductible and non-covered items.";

/* ------------------------------------------------------------------ */
/* Signing                                                             */
/* ------------------------------------------------------------------ */

export type ContractSignInput = {
  documentId: string;
  jobId: string;
  /** Set when the job row itself has to be created as part of signing. */
  createJob: {
    locationId: string;
    accountId: string | null;
    incidentId: string | null;
    address: string | null;
    locality: string | null;
    region: string | null;
    postalCode: string | null;
    customerName: string | null;
    lossType: string | null;
  } | null;
  locationId: string;
  accountId: string | null;
  jobNumber: string | null;
  title: string;
  body: string;
  meta: [string, string][];
  templateVersionId: string | null;
  signerName: string;
  signerEmail: string | null;
  signerPhone: string | null;
  signedAtIso: string;
  signatureDataUrl: string;
  lat: number | null;
  lon: number | null;
  capturedBy: string | null;
  userAgent: string;
  brand: ContractBrand;
  /** PNG/JPEG logo is fetched before queueing so an offline flush still brands. */
  emailTo: string | null;
};

export type QueuedContract = Omit<ContractSignInput, "brand"> & {
  brand: Omit<ContractBrand, "logo"> & { logoBase64: string | null };
  queuedAt: string;
  attempts: number;
  lastError?: string;
};

const QUEUE_PREFIX = "gs-contract-queue:";

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function enqueueContract(input: ContractSignInput): Promise<void> {
  const { logo, ...brandRest } = input.brand;
  const item: QueuedContract = {
    ...input,
    brand: { ...brandRest, logoBase64: logo ? toBase64(logo) : null },
    queuedAt: new Date().toISOString(),
    attempts: 0,
  };
  await idbSet(QUEUE_PREFIX + input.documentId, item);
}

export async function listContractQueue(): Promise<QueuedContract[]> {
  const all = await idbEntries<string, QueuedContract>();
  return all
    .filter(([k]) => typeof k === "string" && k.startsWith(QUEUE_PREFIX))
    .map(([, v]) => v)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

function rehydrate(item: QueuedContract): ContractSignInput {
  const { logoBase64, ...brand } = item.brand;
  return {
    ...item,
    brand: { ...brand, logo: logoBase64 ? fromBase64(logoBase64) : null } as ContractBrand,
  };
}

/** Renders the contract PDF on this device. Never touches the network. */
export async function renderContractPdf(input: ContractSignInput): Promise<Uint8Array> {
  return buildContractPdf({
    title: input.title,
    body: input.body,
    meta: input.meta,
    brand: input.brand,
    footerNote: PAYMENT_NOTE,
    signature: {
      signerName: input.signerName,
      signerRole: "Property owner",
      signerEmail: input.signerEmail,
      signedAtIso: input.signedAtIso,
      signatureDataUrl: input.signatureDataUrl,
      ip: null,
      userAgent: input.userAgent,
    },
  });
}

/**
 * Pushes an already-signed contract to the backend: job (if it was created on
 * device), file, document row, signature row and the queued homeowner email.
 * Idempotent — a replay from the queue re-uses the same ids.
 */
export async function pushSignedContract(input: ContractSignInput): Promise<void> {
  if (input.createJob) {
    const c = input.createJob;
    const { error } = await supabase.from("jobs").insert({
      id: input.jobId,
      location_id: c.locationId,
      account_id: c.accountId,
      address: c.address,
      locality: c.locality,
      region: c.region,
      postal_code: c.postalCode,
      customer_name: c.customerName,
      loss_type: c.lossType,
      status: "new",
      created_by: input.capturedBy,
    } as never);
    if (error && error.code !== "23505") throw error;
    if (c.incidentId) {
      await supabase.from("incidents").update({ job_id: input.jobId }).eq("id", c.incidentId);
    }
  }

  const pdfPath = `${input.jobId}/contract-${input.documentId}.pdf`;
  const sigPath = `${input.jobId}/contract-${input.documentId}-signature.png`;
  const pdfBytes = await renderContractPdf(input);
  const pdfBlob = new Blob([pdfBytes.slice().buffer as ArrayBuffer], { type: "application/pdf" });
  const sigBlob = new Blob([dataUrlBytes(input.signatureDataUrl).slice().buffer as ArrayBuffer], {
    type: "image/png",
  });

  const { error: docErr } = await supabase.from("documents").insert({
    id: input.documentId,
    location_id: input.locationId,
    job_id: input.jobId,
    account_id: input.accountId,
    doc_type: "contract",
    name: `Contract — ${input.title}`,
    description: input.jobNumber ? `Job ${input.jobNumber}` : null,
    status: "pending_signature",
    storage_bucket: DOCUMENT_BUCKET,
    storage_path: pdfPath,
    mime: "application/pdf",
    size_bytes: pdfBlob.size,
    provider: "native",
    template_version_id: input.templateVersionId,
    sent_to: input.emailTo,
    created_by: input.capturedBy,
  } as never);
  if (docErr && docErr.code !== "23505") throw docErr;

  const up1 = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(pdfPath, pdfBlob, { contentType: "application/pdf", upsert: true });
  if (up1.error) throw up1.error;
  const up2 = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(sigPath, sigBlob, { contentType: "image/png", upsert: true });
  if (up2.error) throw up2.error;

  const contentHash = await sha256Hex(pdfBytes);

  const { error: sigErr } = await supabase.from("document_signatures").insert({
    document_id: input.documentId,
    signer_name: input.signerName,
    signer_role: "Property owner",
    signer_email: input.signerEmail,
    signer_phone: input.signerPhone,
    signed_at: input.signedAtIso,
    lat: input.lat,
    lon: input.lon,
    signature_path: sigPath,
    signature_data_url: input.signatureDataUrl,
    provider: "native",
    captured_by: input.capturedBy,
    user_agent: input.userAgent,
  } as never);
  if (sigErr && sigErr.code !== "23505") throw sigErr;

  const { error: lockErr } = await supabase
    .from("documents")
    .update({
      status: "signed",
      signed_at: input.signedAtIso,
      content_hash: contentHash,
      locked_at: new Date().toISOString(),
    })
    .eq("id", input.documentId);
  if (lockErr) throw lockErr;

  await logDocumentEvent(input.documentId, "signed", {
    signer: input.signerName,
    hash: contentHash,
    template_version_id: input.templateVersionId,
    lat: input.lat,
    lon: input.lon,
  });
  if (input.emailTo) {
    // Email delivery itself lands with the Graph mailbox; the intent and the
    // exact bytes the homeowner will receive are recorded now.
    await logDocumentEvent(input.documentId, "sent", { to: input.emailTo, queued_offline: true });
  }
}

export function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function flushContractQueue(): Promise<{ synced: number; failed: number }> {
  let synced = 0;
  let failed = 0;
  for (const item of await listContractQueue()) {
    try {
      await pushSignedContract(rehydrate(item));
      await idbDel(QUEUE_PREFIX + item.documentId);
      synced++;
    } catch (e) {
      const cur = (await idbGet(QUEUE_PREFIX + item.documentId)) as QueuedContract | undefined;
      if (cur) {
        await idbSet(QUEUE_PREFIX + item.documentId, {
          ...cur,
          attempts: cur.attempts + 1,
          lastError: e instanceof Error ? e.message : String(e),
        });
      }
      failed++;
    }
  }
  return { synced, failed };
}

/** Fetches the office logo bytes so an offline PDF still carries the entity mark. */
export async function loadBrandLogo(
  url: string | null,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf, mime: res.headers.get("content-type") ?? "image/png" };
  } catch {
    return null;
  }
}

export function contractBrandFrom(
  brand: LocationBrand | null,
  logo: { bytes: Uint8Array; mime: string } | null,
): ContractBrand {
  return {
    companyName: brand?.legal_entity_name ?? brand?.name ?? "",
    legalEntityName: brand?.legal_entity_name ?? brand?.name ?? null,
    officeName: brand?.name ?? null,
    address: brandAddressLine(brand),
    phone: brand?.office_phone ?? null,
    email: brand?.office_email ?? null,
    ein: brand?.ein ?? null,
    logo: logo?.bytes ?? null,
    logoMime: logo?.mime ?? null,
  };
}
