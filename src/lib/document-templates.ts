// Contract templates and the merge/hash machinery around them.
//
// The governing rule: a generated document must always resolve to the exact
// template version it was produced from. Templates are therefore versioned and
// versions are append-only in the database — this module never attempts an
// update, only a new version.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { DocumentType } from "./documents";
import { stripUnavailablePaymentBlocks } from "./merge-keys";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export type DocumentTemplate = Database["public"]["Tables"]["document_templates"]["Row"];
export type DocumentTemplateVersion =
  Database["public"]["Tables"]["document_template_versions"]["Row"];
export type DocumentEventType = Database["public"]["Enums"]["document_event_type"];

export const MERGE_FIELD_GROUPS: { group: string; fields: { key: string; label: string }[] }[] = [
  {
    group: "Job",
    fields: [
      { key: "job.number", label: "Job number" },
      { key: "job.name", label: "Job name" },
      { key: "loss.type", label: "Loss type" },
      { key: "loss.date", label: "Date of loss" },
      { key: "property.address", label: "Property address" },
      { key: "property.city_state_zip", label: "City, state, ZIP" },
    ],
  },
  {
    group: "Contact",
    fields: [
      { key: "customer.name", label: "Primary contact name" },
      { key: "customer.phone", label: "Primary contact phone" },
      { key: "customer.email", label: "Primary contact email" },
    ],
  },
  {
    group: "Insurance",
    fields: [
      { key: "insurance.carrier", label: "Carrier" },
      { key: "insurance.claim_number", label: "Claim number" },
      { key: "insurance.adjuster", label: "Adjuster" },
      { key: "insurance.deductible", label: "Deductible" },
    ],
  },
  {
    group: "Office / branding",
    fields: [
      { key: "company.name", label: "Company name" },
      { key: "company.location", label: "Office name" },
      { key: "location.legal_name", label: "Legal entity name" },
      { key: "location.address", label: "Office address" },
      { key: "location.phone", label: "Office phone" },
      { key: "location.email", label: "Office email" },
      { key: "location.ein", label: "Office EIN" },
    ],
  },
  {
    // Filled when a proposal on a pipeline card is printed (src/lib/account-proposals.ts).
    group: "Proposal",
    fields: [
      { key: "account.name", label: "Company (account) name" },
      { key: "proposal.title", label: "Proposal title" },
      { key: "proposal.table", label: "Pricing lines and total" },
      { key: "proposal.total", label: "Proposal total" },
    ],
  },
  { group: "Other", fields: [{ key: "today", label: "Today's date" }] },
];

/**
 * The merge fields a template author may use. Anything not on this list is
 * left untouched in the body and reported as unresolved before generation, so
 * nobody sends a contract with a literal {{claim_number}} on the page.
 */
export const MERGE_FIELDS = MERGE_FIELD_GROUPS.flatMap((g) => g.fields);

export type MergeData = Record<string, string | null | undefined>;

/**
 * Two syntaxes are supported deliberately:
 *  - {{dotted.key}} — the templates this app authored itself;
 *  - {Job.CustomerName}, {Office - Company Name}, {Office Address (Full)} —
 *    the client's existing wording, pasted in verbatim. Their keys carry
 *    spaces, hyphens and parentheses, so the character class is wide.
 * A key that resolves to nothing is left on the page rather than blanked.
 */
const TOKEN =
  /\{\{\s*([A-Za-z][A-Za-z0-9_.\-()' ]*?)\s*\}\}|\{\s*([A-Za-z][A-Za-z0-9_.\-()' ]*?)\s*\}/g;

/** Filled at signing time, not from the job — never reported as missing. */
export const SIGNING_TOKENS = new Set(["Signature", "SignatureDate", "LocationLogo"]);

/** Every token used in a body, in document order, deduplicated. */
export function tokensIn(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(TOKEN)) out.add((m[1] ?? m[2])!);
  return Array.from(out);
}

/** Tokens the supplied data cannot fill. Shown before anything is generated. */
export function unresolvedTokens(body: string, data: MergeData): string[] {
  return tokensIn(body).filter((t) => {
    if (SIGNING_TOKENS.has(t)) return false;
    const v = data[t];
    return v == null || String(v).trim() === "";
  });
}

export function renderTemplate(body: string, data: MergeData): string {
  // Payment methods the billing office does not offer are dropped whole,
  // never rendered as a blank link.
  return stripUnavailablePaymentBlocks(body, data).replace(
    TOKEN,
    (whole, a?: string, b?: string) => {
      const key = (a ?? b) as string;
      const v = data[key];
      return v == null || String(v).trim() === "" ? whole : String(v);
    },
  );
}

/**
 * The header logo is drawn by the page and the PDF, not printed as a URL, so
 * a standalone {{LocationLogo}} line is removed from the rendered body.
 */
export function stripLogoToken(body: string): string {
  return body.replace(/^\s*\{\{?\s*LocationLogo\s*\}?\}\s*$/gm, "").replace(/^\n+/, "");
}

/* ------------------------------------------------------------------ */
/* Content hashing — the tamper check                                  */
/* ------------------------------------------------------------------ */

/**
 * SHA-256 of the exact bytes stored. Recorded when a document is locked and
 * re-checked on retrieval: if the file in storage no longer hashes to the
 * recorded value, the document is not evidence any more and we say so loudly
 * rather than quietly serving it.
 */
export async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  const buf = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type HashVerdict =
  | { state: "ok"; hash: string }
  | { state: "unhashed" }
  | { state: "mismatch"; expected: string; actual: string }
  | { state: "unavailable"; reason: string };

/** Downloads the stored file and compares it against the recorded hash. */
export async function verifyDocumentHash(doc: {
  id: string;
  storage_bucket: string | null;
  storage_path: string | null;
  content_hash: string | null;
}): Promise<HashVerdict> {
  if (!doc.content_hash) return { state: "unhashed" };
  if (!doc.storage_bucket || !doc.storage_path)
    return { state: "unavailable", reason: "No file stored for this document." };
  const { data, error } = await supabase.storage
    .from(doc.storage_bucket)
    .download(doc.storage_path);
  if (error || !data) return { state: "unavailable", reason: error?.message ?? "Download failed" };
  const actual = await sha256Hex(await data.arrayBuffer());
  if (actual !== doc.content_hash) {
    await logDocumentEvent(doc.id, "hash_mismatch", { expected: doc.content_hash, actual });
    return { state: "mismatch", expected: doc.content_hash, actual };
  }
  return { state: "ok", hash: actual };
}

/* ------------------------------------------------------------------ */
/* Audit trail                                                         */
/* ------------------------------------------------------------------ */

export async function logDocumentEvent(
  documentId: string,
  eventType: DocumentEventType,
  detail: Record<string, unknown> = {},
  actorLabel?: string | null,
): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  await supabase.from("document_events").insert({
    document_id: documentId,
    event_type: eventType,
    actor_id: auth.user?.id ?? null,
    actor_label: actorLabel ?? auth.user?.email ?? null,
    user_agent: typeof navigator === "undefined" ? null : navigator.userAgent,
    detail: detail as never,
  });
}

/* ------------------------------------------------------------------ */
/* Reads and writes                                                    */
/* ------------------------------------------------------------------ */

export async function listTemplates(locationId?: string | null): Promise<DocumentTemplate[]> {
  let q = supabase.from("document_templates").select("*").order("doc_type").order("name");
  if (locationId) q = q.or(`location_id.is.null,location_id.eq.${locationId}`);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function listVersions(templateId: string): Promise<DocumentTemplateVersion[]> {
  const { data, error } = await supabase
    .from("document_template_versions")
    .select("*")
    .eq("template_id", templateId)
    .order("version", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function currentVersion(templateId: string): Promise<DocumentTemplateVersion | null> {
  const { data, error } = await supabase
    .from("document_template_versions")
    .select("*")
    .eq("template_id", templateId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function createTemplate(input: {
  name: string;
  docType: DocumentType;
  locationId: string | null;
  description: string | null;
  body: string;
  userId: string;
}): Promise<DocumentTemplate> {
  const { data, error } = await supabase
    .from("document_templates")
    .insert({
      name: input.name,
      doc_type: input.docType,
      location_id: input.locationId,
      description: input.description,
      created_by: input.userId,
    })
    .select("*")
    .single();
  if (error) throw error;
  await publishVersion(data.id, input.body, "Initial version", input.userId);
  return data;
}

/**
 * Publishing is the only way to change wording. The previous version stays
 * readable forever so a contract signed under it still resolves.
 */
export async function publishVersion(
  templateId: string,
  body: string,
  changeNote: string | null,
  userId: string,
): Promise<DocumentTemplateVersion> {
  const { data, error } = await supabase
    .from("document_template_versions")
    .insert({
      template_id: templateId,
      version: 0, // assigned by the database
      body,
      merge_fields: tokensIn(body) as never,
      change_note: changeNote,
      created_by: userId,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/* ------------------------------------------------------------------ */
/* Starter library                                                     */
/* ------------------------------------------------------------------ */

/**
 * Wording is deliberately plain and reflects Gold Star's no-cost-to-customer
 * position. Counsel owns the final text — these exist so an office has
 * something to edit rather than a blank page.
 */
/**
 * The client's own CONTRACT FOR SERVICES, verbatim. The legal wording is not
 * ours to edit — only the merge keys are substituted at render time. The
 * signature block and gold footer band are the last paragraphs; the footer
 * resolves per the job's location, exactly as invoices do.
 */
export const CONTRACT_FOR_SERVICES_BODY = [
  "{{LocationLogo}}",
  "",
  "CONTRACT FOR SERVICES",
  "",
  "Agreement: The undersigned, {Job.CustomerName} - {Job.SiteAddress.Community} (Owner/Agent) for the job site listed below, authorize Gold Star Restoration to enter my property, furnish materials, supply all equipment and perform all labor necessary to preserve and protect my property from further damage. Gold Star Restoration will only be providing mitigation services and will not be performing any repairs to the property or mold remediation.",
  "",
  "Assignment of Insurance Benefits and Direct Payment Authorization: I hereby assign any and all insurance rights, benefits, and proceeds under any applicable insurance policies to Gold Star Restoration for the remediation services rendered only (this does not include any money for the reconstruction of your property). I also hereby authorize direct payment of any benefits or proceeds to Gold Star Restoration. I make this assignment and authorization in consideration of Gold Star Restoration's agreement to perform services and supply materials and otherwise perform its obligations under this contract including not requiring full payment at the time of service.",
  "",
  "I believe the appropriate insurance carrier to be {Insurance Company}. I also hereby direct my insurance carrier(s) to release any and all information requested by Gold Star Restoration its representative, or its Attorney for the direct purpose of obtaining actual benefits to be paid by my insurance carrier(s) for services rendered or to be rendered. In this regard, I waive my privacy rights.",
  "",
  "If payment is made directly to the Owner/Agent by an insurer, it shall be endorsed over to Gold Star Restoration within three business days. I agree that any portion of work, deductibles, betterment, depreciation, or additional work requested by the undersigned, not covered by insurance, must be made by the undersigned on or before its completion. I hereby appoint Gold Star Restoration as attorney in-fact authorizing Gold Star Restoration to endorse my name, and to deposit insurance check or drafts for Gold Star Restoration. Payment for services rendered by Gold Star Restoration is due upon completion of services. Late charges of 1.5% monthly are charged to any withheld insurance payments.",
  "",
  "Gold Star Restoration Shall be entitled to reimbursement for costs of collection (including reasonable attorney's fees and costs) of unpaid amounts by owner/agent and for reasonable attorney's fees and costs for the breach or enforcement, of any terms of this entire service agreement.",
  "",
  "Authorized Antimicrobial Agents: I understand that, in the best judgment of Gold Star Restoration, materials may be treated with a commercial antimicrobial and antimicrobial product as part of the restoration process. I understand it is beyond the expertise of Gold Star Restoration to determine if someone is sensitive to its application and will hold Gold Star Restoration harmless for its use.",
  "",
  "Stop Work- Hold Harmless: In the event Gold Star Restoration is not allowed to perform its recommended procedures and/or drying equipment is removed prematurely, I agree to release and hold Gold Star Restoration harmless and indemnify Gold Star Restoration against all claims or actions that may result from such procedures.",
  "",
  "Limitation of Liability: In no event shall Gold Star Restoration, its owners, officers, directors, employees, agents or affiliates be responsible for indirect, special, nominal, incidental, punitive or consequential losses or damages, or for any penalties, to the extent permitted by law.",
  "",
  "Address: {Job.SiteAddress.Address1} / {Job.SiteAddress.City}, {Job.SiteAddress.State} {Job.SiteAddress.PostalCode}    Signature: {Signature}",
  "Claim Number: {Job.ClaimNumber}    Signature Date: {SignatureDate}",
  "Type of Loss: {Job.Type}    Job Primary Contact: {Job.CustomerName}",
  "Date of Loss: {Job.LossDate}    Site Name: {Job.SiteAddress.Community}",
  "",
  "{Office - Company Name} · {Office Address (Full)} · {Office Phone}",
  "Toll Free: 877-95-WATER ~ www.GoldStarRestoration.com",
].join("\n");

export const STARTER_TEMPLATES: {
  name: string;
  docType: DocumentType;
  description: string;
  body: string;
}[] = [
  {
    name: "Contract for services",
    docType: "contract",
    description:
      "Gold Star's own contract wording, as signed on glass. Legal text is verbatim — edit merge keys only.",
    body: CONTRACT_FOR_SERVICES_BODY,
  },

  {
    name: "Work authorization",
    docType: "work_authorization",
    description: "Signed at the loss scene. Converts a chase into a job.",
    body: [
      "WORK AUTHORIZATION",
      "",
      "Property: {{property.address}}, {{property.city_state_zip}}",
      "Customer: {{customer.name}}    Date: {{today}}",
      "Loss type: {{loss.type}}    Job: {{job.number}}",
      "Carrier: {{insurance.carrier}}    Claim: {{insurance.claim_number}}",
      "",
      "I authorize {{company.name}} and its authorized subcontractors to enter the property described above and to perform emergency mitigation and restoration services.",
      "",
      "I understand that {{company.name}} bills my insurance carrier directly for covered work. I am not being quoted a price and I am not being asked to pay for the authorized work. Any amount the carrier does not pay for authorized work is absorbed by {{company.name}}.",
      "",
      "I confirm I am the owner of the property, or an agent authorized by the owner, and may lawfully authorize this work.",
    ].join("\n"),
  },
  {
    name: "Service agreement",
    docType: "service_agreement",
    description: "Full scope agreement for planned restoration work.",
    body: [
      "SERVICE AGREEMENT",
      "",
      "Between {{company.name}} ({{company.location}}) and {{customer.name}}.",
      "Property: {{property.address}}, {{property.city_state_zip}}",
      "Job: {{job.number}} — {{job.name}}    Date: {{today}}",
      "",
      "Scope of services is as described in the estimate issued for this job and any approved supplements.",
      "",
      "Payment is sought from the carrier under claim {{insurance.claim_number}}. The customer is responsible only for the policy deductible of {{insurance.deductible}}, where applicable.",
    ].join("\n"),
  },
  {
    name: "Certificate of completion",
    docType: "certificate_of_completion",
    description: "Signed by the customer when work is finished.",
    body: [
      "CERTIFICATE OF SATISFACTION AND COMPLETION",
      "",
      "Job: {{job.number}}    Property: {{property.address}}",
      "Customer: {{customer.name}}    Date: {{today}}",
      "",
      "I confirm that the restoration services described for this job have been completed at the above property and that the work is satisfactory to me.",
    ].join("\n"),
  },
  {
    name: "Direction to pay",
    docType: "direction_to_pay",
    description: "Directs the carrier to pay Gold Star directly.",
    body: [
      "DIRECTION TO PAY",
      "",
      "To: {{insurance.carrier}}    Claim: {{insurance.claim_number}}",
      "Adjuster: {{insurance.adjuster}}    Date: {{today}}",
      "",
      "I, {{customer.name}}, insured under the above claim for the loss at {{property.address}}, direct {{insurance.carrier}} to issue payment for restoration services performed at that property directly to {{company.name}}.",
      "",
      "This direction applies to work performed under job {{job.number}} and remains in effect until the claim is closed.",
    ].join("\n"),
  },
  {
    name: "Non-waiver agreement",
    docType: "non_waiver",
    description: "Preserves both parties' positions while work proceeds.",
    body: [
      "NON-WAIVER AGREEMENT",
      "",
      "Claim: {{insurance.claim_number}}    Carrier: {{insurance.carrier}}",
      "Property: {{property.address}}    Date: {{today}}",
      "",
      "The parties agree that any investigation, inspection, or emergency work performed in connection with this loss is undertaken without prejudice, and does not waive any right, term, or condition of the policy, or any defense available to either party.",
    ].join("\n"),
  },
  {
    name: "Vendor agreement",
    docType: "vendor_agreement",
    description: "Subcontractor terms, insurance and payment.",
    body: [
      "VENDOR AGREEMENT",
      "",
      "Between {{company.name}} ({{company.location}}) and the vendor named below.",
      "Date: {{today}}",
      "",
      "The vendor agrees to maintain current general liability and workers' compensation coverage, to supply a certificate of insurance naming {{company.name}} as additional insured, and to supply a completed W-9 before any payment is issued.",
    ].join("\n"),
  },
];

/** Builds merge data for a job. Missing values stay null so they surface. */
export function mergeDataForJob(
  job: {
    job_number?: string | null;
    job_name?: string | null;
    customer_name?: string | null;
    // Not columns on jobs — the caller resolves these off the primary contact.
    customer_phone?: string | null;
    customer_email?: string | null;
    address?: string | null;
    locality?: string | null;
    region?: string | null;
    postal_code?: string | null;
    community?: string | null;
    loss_type?: string | null;
    loss_date?: string | null;
    insurance_carrier?: string | null;
    claim_number?: string | null;
    adjuster_name?: string | null;
    deductible?: number | null;
  },
  companyName = "Gold Star Restoration",
  locationName?: string | null,
): MergeData {
  const cityStateZip = [job.locality, job.region, job.postal_code].filter(Boolean).join(", ");
  return {
    "customer.name": job.customer_name ?? null,
    "customer.phone": job.customer_phone ?? null,
    "customer.email": job.customer_email ?? null,
    "property.address": job.address ?? null,
    "property.city_state_zip": cityStateZip || null,
    "loss.type": job.loss_type ?? null,
    "loss.date": job.loss_date ?? null,
    "job.number": job.job_number ?? null,
    "job.name": job.job_name ?? null,
    "insurance.carrier": job.insurance_carrier ?? null,
    "insurance.claim_number": job.claim_number ?? null,
    "insurance.adjuster": job.adjuster_name ?? null,
    "insurance.deductible":
      job.deductible == null ? null : `$${Number(job.deductible).toLocaleString("en-US")}`,
    "company.name": companyName,
    "company.location": locationName ?? null,
    today: new Date().toLocaleDateString(DATE_LOCALE, US_DATE),

    // The client's own key names, resolving to the same values so their
    // existing contract wording merges without being rewritten.
    "Job.JobNumber": job.job_number ?? null,
    "Job.JobName": job.job_name ?? null,
    "Job.CustomerName": job.customer_name ?? null,
    "Job.CustomerPhone": job.customer_phone ?? null,
    "Job.CustomerEmail": job.customer_email ?? null,
    "Job.SiteAddress.Address1": job.address ?? null,
    "Job.SiteAddress.City": job.locality ?? null,
    "Job.SiteAddress.State": job.region ?? null,
    "Job.SiteAddress.PostalCode": job.postal_code ?? null,
    "Job.SiteAddress.Zip": job.postal_code ?? null,
    "Job.SiteAddress.Full": [job.address, cityStateZip].filter(Boolean).join(", ") || null,
    // Site / community name — the building or complex the loss sits in.
    "Job.SiteAddress.Community": job.community ?? job.job_name ?? null,
    "Job.Type": job.loss_type ?? null,
    "Job.LossType": job.loss_type ?? null,
    "Job.LossDate": job.loss_date ?? null,
    "Job.ClaimNumber": job.claim_number ?? null,
    "Insurance Company": job.insurance_carrier ?? null,
    InsuranceCompany: job.insurance_carrier ?? null,
    Today: new Date().toLocaleDateString(DATE_LOCALE, US_DATE),
  };
}

/* ------------------------------------------------------------------ */
/* Per-office branding                                                 */
/* ------------------------------------------------------------------ */

export type LocationBrand = {
  id: string;
  name: string;
  legal_entity_name: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  office_phone: string | null;
  office_email: string | null;
  ein: string | null;
  logo_url: string | null;
  card_payment_url: string | null;
  zelle_email: string | null;
  payment_options_text: string | null;
};

export function brandAddressLine(loc: Partial<LocationBrand> | null): string | null {
  if (!loc) return null;
  const cityLine = [loc.locality, loc.region, loc.postal_code].filter(Boolean).join(", ");
  return [loc.address, cityLine].filter(Boolean).join(", ") || null;
}

/** The office a job belongs to owns the branding on that job's documents. */
export async function loadLocationBrand(
  locationId: string,
  // The document file route renders server-side through the caller's client.
  client: SupabaseClient<Database> = supabase,
): Promise<LocationBrand | null> {
  const { data, error } = await client
    .from("locations")
    .select(
      "id, name, legal_entity_name, address, locality, region, postal_code, office_phone, office_email, ein, logo_url, card_payment_url, zelle_email, payment_options_text",
    )
    .eq("id", locationId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

/** Branding tokens, merged on top of the job tokens. */
export function mergeDataForLocation(loc: LocationBrand | null): MergeData {
  return {
    "company.location": loc?.name ?? null,
    "location.legal_name": loc?.legal_entity_name ?? loc?.name ?? null,
    "location.address": brandAddressLine(loc),
    "location.phone": loc?.office_phone ?? null,
    "location.email": loc?.office_email ?? null,
    "location.ein": loc?.ein ?? null,

    // Footer band on the client's contract — the legal entity that owns the job.
    "Office - Company Name": loc?.legal_entity_name ?? loc?.name ?? null,
    "Office Address (Full)": brandAddressLine(loc),
    "Office Phone": loc?.office_phone ?? null,
    "Office.Name": loc?.name ?? null,
    "Office.Address": brandAddressLine(loc),
    "Office.Phone": loc?.office_phone ?? null,
    "Office.Email": loc?.office_email ?? null,
    LocationLogo: loc?.logo_url ?? null,
    "Office Payment Link": loc?.card_payment_url ?? null,
    "Payment Link": loc?.card_payment_url ?? null,
    "Office Zelle Email": loc?.zelle_email ?? null,
    "Office Payment Options": loc?.payment_options_text ?? null,
    "location.ein_display": loc?.ein ?? null,
  };
}
