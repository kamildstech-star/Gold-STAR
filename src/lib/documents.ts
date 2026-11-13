import { get as idbGet, set as idbSet, del as idbDel, entries as idbEntries } from "idb-keyval";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { logDocumentEvent, sha256Hex } from "./document-templates";
import { buildPersonNames, type PersonNames } from "./document-metadata";
import { DOCUMENT_SIGNATURE_COLUMNS, type DocumentSignatureFacts } from "./document-status";
import { isMissingSchema } from "./schema-fallback";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { TONE } from "@/lib/tone";

export type DocumentType = Database["public"]["Enums"]["document_type"];
export type DocumentStatus = Database["public"]["Enums"]["document_status"];
export type SignatureProvider = Database["public"]["Enums"]["signature_provider"];

export const DOCUMENT_BUCKET = "documents";

export const DOCUMENT_TYPES: DocumentType[] = [
  "work_authorization",
  "service_agreement",
  "certificate_of_completion",
  "vendor_agreement",
  "direction_to_pay",
  "non_waiver",
  "contract",
  "coi",
  "w9",
  "carrier_correspondence",
  "estimate",
  "invoice",
  "certificate",
  "photo_report",
  "other",
];

export const DOCUMENT_TYPE_LABEL: Record<DocumentType, string> = {
  work_authorization: "Work authorization",
  service_agreement: "Service agreement",
  certificate_of_completion: "Certificate of completion",
  vendor_agreement: "Vendor agreement",
  direction_to_pay: "Direction to pay",
  non_waiver: "Non-waiver agreement",
  contract: "Contract",
  coi: "Certificate of insurance",
  w9: "W9",
  carrier_correspondence: "Carrier correspondence",
  estimate: "Estimate",
  invoice: "Invoice",
  certificate: "Certificate",
  photo_report: "Photo report",
  job_report: "Job report",
  other: "Other",
};

/**
 * Is this a report rather than paperwork?
 *
 * The documents screen shows the two side by side — David, 16 Sep, wanted
 * "reports on one side and documents on the other" instead of one list running
 * down the page. A report is something Gold Star produced about the job; a
 * document is something the file needs to hold.
 */
export function isReportDocument(docType: string | null | undefined): boolean {
  return (
    docType === "photo_report" ||
    docType === "job_report" ||
    docType === "certificate_of_completion" ||
    docType === "certificate"
  );
}

/**
 * What to call a document that did not arrive with a usable name.
 *
 * A row is drawn from `name` and the type label beside it. When `name` is empty
 * or whitespace the row renders as a blank band with a thumbnail tile floating
 * in it — which is what the Documents list showed on 2026-09-16: a header and a
 * stat tile both reading "10 documents" above nine legible rows and one that
 * looked like a rendering fault. The document is real and must stay on the
 * list; it just needs something to be called.
 */
export function documentDisplayName(name: string | null | undefined): string {
  return name?.trim() || "Untitled document";
}

/**
 * The label for a document's type, including one this build has never heard of.
 *
 * `DOCUMENT_TYPE_LABEL` is typed against the union, so a `doc_type` written by a
 * newer migration — or by hand — indexes to `undefined` and leaves the cell
 * empty. Printing the raw value is worse than a pretty label and far better
 * than printing nothing.
 */
export function documentTypeLabel(docType: string | null | undefined): string {
  if (!docType) return "—";
  return DOCUMENT_TYPE_LABEL[docType as DocumentType] ?? docType;
}

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  draft: "Draft",
  sent: "Sent",
  viewed: "Viewed",
  pending_signature: "Awaiting signature",
  signed: "Signed",
  declined: "Declined",
  active: "Active",
  expired: "Expired",
  void: "Void",
};

/**
 * The raw enum, one label per value. Not what a list should render: `viewed`
 * is never written to `status`, `sent` means different things on a contract
 * and on a COI, and a document sent three weeks ago looks the same as one sent
 * this morning. Use `treatDocumentStatus` / `DocumentStatusBadge` for anything
 * a user reads, so every surface says the same thing.
 */
export const DOCUMENT_STATUS_TONE: Record<DocumentStatus, string> = {
  draft: TONE.neutral,
  sent: TONE.info,
  viewed: TONE.info,
  pending_signature: TONE.warning,
  signed: TONE.success,
  declined: TONE.danger,
  active: TONE.info,
  expired: TONE.danger,
  void: TONE.neutral,
};

/**
 * The at-the-scene authorisation body. This is the operative paragraph a
 * homeowner signs on a phone outside a burning building — the document that
 * converts a chase into a job, and the one scrutinised in a coverage dispute.
 * Wording is Gold Star's standard no-cost position; counsel owns the text.
 */
export const WORK_AUTHORIZATION_BODY = [
  "I authorize Gold Star Restoration and its authorized subcontractors to enter the property described below and to perform emergency mitigation and restoration services, including but not limited to water extraction, board-up, structural drying, smoke and odor control, and content protection.",
  "I understand that Gold Star Restoration bills my insurance carrier directly for the covered work performed. I am not being quoted a price and I am not being asked to pay for the authorized work. Any amount the carrier does not pay for authorized work is absorbed by Gold Star Restoration and will not be billed to me.",
  "I confirm I am the owner of the property, or an agent authorized by the owner, and that I may lawfully authorize this work. I authorize Gold Star Restoration to communicate with my insurance carrier and its adjuster regarding this loss and to photograph the property for claim documentation.",
].join("\n\n");

export type AuthorizationInput = {
  documentId: string;
  jobId: string | null;
  accountId: string | null;
  incidentId: string | null;
  locationId: string;
  jobNumber: string | null;
  address: string;
  lossType: string | null;
  signerName: string;
  signerRole: string | null;
  signerPhone: string | null;
  signerEmail: string | null;
  signedAtIso: string;
  lat: number | null;
  lon: number | null;
  bodyText: string;
  /** PNG data URL from the signature pad. */
  signatureDataUrl: string;
  capturedBy: string | null;
  userAgent: string;
  /** Billing entity identity, resolved from the job's billing location. */
  entityName?: string | null;
  entityPhone?: string | null;
  /** The folder open when it was signed; else the job's Work Authorizations folder. */
  folderId?: string | null;
};

/** Where a job's signed work authorizations are filed (27 Oct). */
export const WORK_AUTHORIZATION_FOLDER = "Work Authorizations";

/**
 * The folder a work authorization is filed into AS IT IS WRITTEN. It cannot be
 * moved afterwards by an ordinary update: a signed document refuses every
 * write but this one narrow function (move_document_to_folder). Never throws —
 * a folder that cannot be made leaves the document at the top level.
 */
export async function authorizationFolderId(
  input: Pick<AuthorizationInput, "jobId" | "accountId" | "locationId" | "capturedBy" | "folderId">,
  ensure: typeof ensureJobFolder = ensureJobFolder,
): Promise<string | null> {
  if (input.folderId) return input.folderId;
  if (!input.jobId) return null;
  try {
    const folder = await ensure({
      scope: { locationId: input.locationId, jobId: input.jobId, accountId: input.accountId },
      name: WORK_AUTHORIZATION_FOLDER,
      userId: input.capturedBy,
    });
    return folder?.id ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* PDF                                                                 */
/* ------------------------------------------------------------------ */

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (!para.trim()) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/**
 * Renders the signed authorisation to a flat PDF. Everything that makes the
 * document defensible — signer, timestamp, coordinates, device — is printed
 * onto the page itself, not just held in the database.
 */
export async function buildAuthorizationPdf(input: AuthorizationInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.063, 0.141, 0.239);
  const grey = rgb(0.4, 0.4, 0.4);
  const gold = rgb(0.722, 0.627, 0.188); // #B8A030

  const M = 54;
  const W = 612 - M * 2;
  let y = 792 - M;

  // Entity identity comes from the job's billing location, never a constant.
  const entityName = (input.entityName ?? "").trim().toUpperCase();
  if (entityName) page.drawText(entityName, { x: M, y, size: 16, font: bold, color: navy });
  if (input.entityPhone) {
    const phone = input.entityPhone;
    page.drawText(phone, {
      x: M + W - bold.widthOfTextAtSize(phone, 10),
      y,
      size: 10,
      font: bold,
      color: navy,
    });
  }

  y -= 18;
  page.drawText("Emergency Services Work Authorization", { x: M, y, size: 11, font, color: grey });
  y -= 12;
  // Solid gold rule — the brand's structural divider
  page.drawRectangle({ x: M, y, width: W, height: 3, color: gold });
  y -= 24;

  const meta: [string, string][] = [
    ["Property", input.address],
    ["Job", input.jobNumber ?? "Not yet assigned"],
    ["Loss type", input.lossType ?? "—"],
    ["Signed", new Date(input.signedAtIso).toLocaleString("en-US")],
  ];
  for (const [k, v] of meta) {
    page.drawText(`${k}:`, { x: M, y, size: 9, font: bold, color: grey });
    page.drawText(v, { x: M + 70, y, size: 9, font, color: navy });
    y -= 14;
  }
  y -= 12;

  for (const line of wrap(input.bodyText, font, 10, W)) {
    if (!line) {
      y -= 8;
      continue;
    }
    page.drawText(line, { x: M, y, size: 10, font, color: rgb(0.1, 0.1, 0.1) });
    y -= 14;
  }

  y -= 24;
  page.drawText("Signature", { x: M, y, size: 9, font: bold, color: grey });
  y -= 6;

  const pngBytes = await (await fetch(input.signatureDataUrl)).arrayBuffer();
  const png = await pdf.embedPng(pngBytes);
  const sigW = Math.min(260, W);
  const sigH = (png.height / png.width) * sigW;
  y -= sigH;
  page.drawImage(png, { x: M, y, width: sigW, height: sigH });
  y -= 8;
  page.drawLine({ start: { x: M, y }, end: { x: M + sigW, y }, thickness: 0.8, color: navy });
  y -= 14;

  const attest: [string, string][] = [
    ["Signer", input.signerName],
    ["Capacity", input.signerRole ?? "Property owner"],
    ["Phone", input.signerPhone ?? "—"],
    ["Email", input.signerEmail ?? "—"],
    [
      "Coordinates",
      input.lat != null && input.lon != null
        ? `${input.lat.toFixed(6)}, ${input.lon.toFixed(6)}`
        : "Not available at signing",
    ],
    ["Timestamp", new Date(input.signedAtIso).toISOString()],
  ];
  for (const [k, v] of attest) {
    page.drawText(`${k}:`, { x: M, y, size: 8, font: bold, color: grey });
    page.drawText(v, { x: M + 70, y, size: 8, font, color: navy });
    y -= 12;
  }
  y -= 6;
  for (const line of wrap(`Captured on device: ${input.userAgent}`, font, 7, W)) {
    page.drawText(line, { x: M, y, size: 7, font, color: grey });
    y -= 9;
  }

  return pdf.save();
}

/* ------------------------------------------------------------------ */
/* Offline queue — a signature taken with no signal must never be lost  */
/* ------------------------------------------------------------------ */

const QUEUE_PREFIX = "gs-signature-queue:";

export type QueuedAuthorization = AuthorizationInput & {
  queuedAt: string;
  attempts: number;
  lastError?: string;
};

export async function enqueueAuthorization(input: AuthorizationInput): Promise<void> {
  const item: QueuedAuthorization = { ...input, queuedAt: new Date().toISOString(), attempts: 0 };
  await idbSet(QUEUE_PREFIX + input.documentId, item);
}

export async function listAuthorizationQueue(): Promise<QueuedAuthorization[]> {
  const all = await idbEntries<string, QueuedAuthorization>();
  return all
    .filter(([k]) => typeof k === "string" && k.startsWith(QUEUE_PREFIX))
    .map(([, v]) => v)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

async function markQueueError(id: string, message: string) {
  const cur = (await idbGet(QUEUE_PREFIX + id)) as QueuedAuthorization | undefined;
  if (!cur) return;
  await idbSet(QUEUE_PREFIX + id, {
    ...cur,
    attempts: cur.attempts + 1,
    lastError: message,
  });
}

/**
 * Uploads the signed PDF and signature image, then writes the document and
 * signature rows. The document row is written first so storage RLS can see it,
 * and the signature row last — inserting it is what locks the document.
 */
export async function submitAuthorization(input: AuthorizationInput): Promise<void> {
  const pdfPath = `${input.documentId}/authorization.pdf`;
  const sigPath = `${input.documentId}/signature.png`;

  const pdfBytes = await buildAuthorizationPdf(input);
  const pdfBlob = new Blob([pdfBytes.slice().buffer as ArrayBuffer], {
    type: "application/pdf",
  });
  const sigBlob = await (await fetch(input.signatureDataUrl)).blob();
  const folderId = await authorizationFolderId(input);

  const { error: docErr } = await supabase.from("documents").insert({
    // Only when there is a folder: a database without folders has no column.
    ...(folderId ? { folder_id: folderId } : {}),
    id: input.documentId,
    location_id: input.locationId,
    job_id: input.jobId,
    account_id: input.accountId,
    incident_id: input.incidentId,
    doc_type: "work_authorization",
    name: `Work authorization — ${input.address}`,
    description: input.jobNumber ? `Job ${input.jobNumber}` : null,
    status: "pending_signature",
    storage_bucket: DOCUMENT_BUCKET,
    storage_path: pdfPath,
    mime: "application/pdf",
    size_bytes: pdfBlob.size,
    provider: "native" as SignatureProvider,
    created_by: input.capturedBy,
  });
  if (docErr && docErr.code !== "23505") throw docErr;

  const up1 = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(pdfPath, pdfBlob, { contentType: "application/pdf", upsert: true });
  if (up1.error) throw up1.error;

  const up2 = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(sigPath, sigBlob, { contentType: "image/png", upsert: true });
  if (up2.error) throw up2.error;

  // Hash the exact bytes stored, then lock. After this point the document is
  // evidence: any later difference between file and hash is detectable.
  const contentHash = await sha256Hex(pdfBytes);

  const { error: sigErr } = await supabase.from("document_signatures").insert({
    document_id: input.documentId,
    signer_name: input.signerName,
    signer_role: input.signerRole,
    signer_email: input.signerEmail,
    signer_phone: input.signerPhone,
    signed_at: input.signedAtIso,
    lat: input.lat,
    lon: input.lon,
    signature_path: sigPath,
    provider: "native" as SignatureProvider,
    captured_by: input.capturedBy,
    user_agent: input.userAgent,
  });
  if (sigErr) throw sigErr;

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
    lat: input.lat,
    lon: input.lon,
  });
}

/** Returns how many queued signatures were successfully synced. */
export async function flushAuthorizationQueue(): Promise<{ synced: number; failed: number }> {
  const queue = await listAuthorizationQueue();
  let synced = 0;
  let failed = 0;
  for (const item of queue) {
    try {
      await submitAuthorization(item);
      await idbDel(QUEUE_PREFIX + item.documentId);
      synced++;
    } catch (e) {
      await markQueueError(item.documentId, (e as Error)?.message ?? "unknown");
      failed++;
    }
  }
  return { synced, failed };
}

/** Coordinates at the moment of signing. Event-based capture only. */
export function getPositionOnce(timeoutMs = 8000): Promise<GeolocationPosition | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(p),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 },
    );
  });
}

/* ------------------------------------------------------------------ */
/* Opening a stored document                                           */
/* ------------------------------------------------------------------ */

/**
 * Where a document's bytes live, as far as the browser is concerned.
 *
 * Deliberately not a Storage signed URL and never a `blob:`. Extensions block
 * `blob:` outright — `ERR_BLOCKED_BY_CLIENT`, framed or in a tab of its own —
 * and Storage serves whatever `mime` the upload recorded, which is
 * `application/octet-stream` for every extension the uploader's OS could not
 * name. `/api/documents/$id/file` is same-origin `https:` that extensions leave
 * alone, it types the response from the filename, and it is the only way to see
 * a document that has no stored file yet. See the route for how it authorises.
 */
export function documentFileUrl(
  id: string,
  opts?: { download?: boolean; variant?: "thumb" },
): string {
  const params = new URLSearchParams();
  if (opts?.variant) params.set("variant", opts.variant);
  if (opts?.download) params.set("disposition", "attachment");
  const query = params.size ? `?${params.toString()}` : "";
  return `/api/documents/${encodeURIComponent(id)}/file${query}`;
}

/**
 * Where a document's thumbnail lives in the bucket: beside the file, under the
 * document's own id. `<id>/…` is already the bucket's sidecar namespace — a
 * work authorisation's `signature.png` is filed there — and all four storage
 * policies grant it through the document row (`can_access_document_object`),
 * so a thumbnail is readable by exactly the people who can read the document,
 * can be written for a signed document (the object policies only refuse
 * *replacing* a signed document's objects, never adding one), and needs no
 * column and no migration. It is the one convention every writer must share:
 * the file route reads this path and nothing else.
 */
export function documentThumbPath(id: string): string {
  return `${id}/thumb.webp`;
}

/**
 * The browser types a file from its extension against the OS registry, so a
 * `.esx` — and often a `.heic` or a `.dwg` — arrives with `File.type` empty.
 * Storing that as `application/octet-stream` is what makes a tab download the
 * file instead of showing it, whatever the disposition says. Name the type at
 * upload time so the object is servable inline for good.
 */
const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  tif: "image/tiff",
  tiff: "image/tiff",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  esx: "application/vnd.xactware.esx",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function documentExt(name: string): string {
  // Generated documents are named for the customer, not for a file — without
  // this a dotless name comes back whole and gets shown as its own extension.
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Best known type for a file, preferring the extension over a useless header. */
export function documentMime(name: string, stored?: string | null): string {
  const byExt = MIME_BY_EXT[documentExt(name)];
  if (byExt) return byExt;
  if (stored && stored !== "application/octet-stream") return stored;
  return "application/octet-stream";
}

export type DocumentKind = "pdf" | "image" | "esx" | "text" | "other";

export function documentKind(name: string, stored?: string | null): DocumentKind {
  const ext = documentExt(name);
  if (ext === "esx") return "esx";
  const mime = documentMime(name, stored);
  if (mime === "application/pdf") return "pdf";
  // SVG renders as an image but is live markup from an untrusted upload.
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image";
  if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml")
    return "text";
  return "other";
}

/**
 * How a payment's photographed evidence is filed — a cheque, a remittance
 * advice, an ACH confirmation.
 *
 * `carrier_correspondence` is an existing enum value, so this needs no enum
 * migration, and it is the honest name for what these are: what the payer sent
 * to explain the money. It also keeps them out of the crew's picture gallery,
 * which filters this type out precisely because a cheque photograph carries a
 * routing and account number — see `jobImageDocumentsOf` in `job-photos.ts`.
 */
export const PAYMENT_ATTACHMENT_DOC_TYPE: DocumentType = "carrier_correspondence";

/** Types where an expiry date is a real field rather than dead UI. */
export const EXPIRING_DOCUMENT_TYPES: ReadonlySet<DocumentType> = new Set<DocumentType>([
  "coi",
  "w9",
  "certificate",
  "vendor_agreement",
  "service_agreement",
  "contract",
  "non_waiver",
]);

/* ------------------------------------------------------------------ */
/* Folders                                                             */
/* ------------------------------------------------------------------ */

/**
 * `document_folders` and `documents.folder_id` ship in a migration that has not
 * been applied yet, so every call here is written to survive their absence:
 * `null` means "not migrated", and the panel falls back to the flat list rather
 * than showing an empty one. Typed access is impossible until the generated
 * types catch up, hence the untyped client.
 */
const db = supabase as unknown as SupabaseClient;

export type DocumentFolder = {
  id: string;
  location_id: string;
  job_id: string | null;
  account_id: string | null;
  project_id: string | null;
  name: string;
  parent_folder_id: string | null;
  sort_order: number;
  created_at: string;
};

export type DocumentFolderNode = DocumentFolder & {
  children: DocumentFolderNode[];
  depth: number;
};

export type DocumentScope = {
  locationId: string;
  jobId?: string | null;
  accountId?: string | null;
  projectId?: string | null;
};

/**
 * 42703 is a missing column, 42P01 / PGRST205 a missing table — all three mean
 * the migration is outstanding, not that the query was wrong.
 */
export function foldersNotMigrated(err: unknown): boolean {
  const e = err as { code?: string; message?: string; details?: string } | null;
  if (!e) return false;
  if (e.code === "42703" || e.code === "42P01" || e.code === "PGRST205") return true;
  return /does not exist|could not find the table/i.test(`${e.message ?? ""} ${e.details ?? ""}`);
}

/**
 * Folders belong to the same container the panel is showing, never to all of them.
 *
 * The location-only scope is the main Documents page, which David (12 Oct)
 * redefined as COMPANY-WIDE documents — COI, W-9, contracts, client and tenant
 * forms. Job files live on the job, so that scope no longer reaches a job's or
 * a photo project's folders. See `isCompanyDocument`.
 */
function scopeQuery<T>(q: T, scope: DocumentScope): T {
  type Chain = { eq: (col: string, val: unknown) => Chain; is: (col: string, val: null) => Chain };
  const query = q as unknown as Chain;
  if (scope.jobId) return query.eq("job_id", scope.jobId) as unknown as T;
  if (scope.projectId) return query.eq("project_id", scope.projectId) as unknown as T;
  if (scope.accountId) return query.eq("account_id", scope.accountId) as unknown as T;
  return query
    .eq("location_id", scope.locationId)
    .is("job_id", null)
    .is("project_id", null) as unknown as T;
}

/**
 * Is this a company-wide document — the main Documents page's kind?
 *
 * David, 12 Oct: the left-hand Documents section is for company-wide papers
 * (COI, W-9, contracts, client and tenant forms), not job files. A document is
 * company-wide when no job and no photo project holds it. One attached to an
 * account (a vendor's COI, a client's contract) is still company paperwork and
 * stays on the page.
 */
export function isCompanyDocument(row: {
  job_id?: string | null;
  project_id?: string | null;
  account_id?: string | null;
}): boolean {
  return !row.job_id && !row.project_id;
}

/** The types the company Documents page offers first; every type is still allowed. */
export const COMPANY_DOCUMENT_TYPES: readonly DocumentType[] = [
  "coi",
  "w9",
  "contract",
  "service_agreement",
  "vendor_agreement",
  "other",
];

/** Returns null when the migration has not been applied. */
export async function listDocumentFolders(scope: DocumentScope): Promise<DocumentFolder[] | null> {
  const { data, error } = await scopeQuery(db.from("document_folders").select("*"), scope)
    .order("sort_order")
    .order("name");
  if (error) {
    if (foldersNotMigrated(error)) return null;
    throw error;
  }
  return (data ?? []) as DocumentFolder[];
}

export type DocumentRow = {
  id: string;
  name: string;
  doc_type: DocumentType;
  status: DocumentStatus;
  expiry_date: string | null;
  storage_path: string | null;
  storage_bucket: string | null;
  content_hash: string | null;
  locked_at: string | null;
  created_at: string;
  /** Who filed it. Null on an import, or when the column could not be read. */
  created_by: string | null;
  mime: string | null;
  size_bytes: number | null;
  folder_id: string | null;
  // Signature timing, so the status badge can show age and "opened, unsigned".
} & Omit<DocumentSignatureFacts, "status" | "doc_type" | "created_at">;

const DOCUMENT_COLUMNS =
  "id, name, doc_type, status, expiry_date, storage_path, storage_bucket, content_hash, locked_at, created_at, mime, size_bytes";

const UPLOADER_COLUMN = "created_by";

/**
 * One list, several shapes. `folder_id`, the signature timestamps and
 * `created_by` each ship in a migration that may not be applied yet, and
 * PostgREST fails the whole read on one unknown column. Ask for the richest
 * shape and step down: the day a migration lands the panel gains that column
 * with no code change, and until then the list is still the list rather than
 * an error.
 *
 * The uploader is the outermost dimension, so it is the last thing given up:
 * a panel that has lost folders is still worth showing with a filing history,
 * and `uploaders: false` lets the caller drop the person from the row rather
 * than print "Unknown" against every document.
 */
const DOCUMENT_SHAPES: { cols: string; folders: boolean; uploaders: boolean }[] = (() => {
  const out: { cols: string; folders: boolean; uploaders: boolean }[] = [];
  for (const uploaders of [true, false]) {
    for (const signature of [true, false]) {
      for (const folders of [true, false]) {
        out.push({
          cols: [
            DOCUMENT_COLUMNS,
            signature ? DOCUMENT_SIGNATURE_COLUMNS : null,
            uploaders ? UPLOADER_COLUMN : null,
            folders ? "folder_id" : null,
          ]
            .filter(Boolean)
            .join(", "),
          folders,
          uploaders,
        });
      }
    }
  }
  return out;
})();

export async function listDocuments(
  scope: DocumentScope,
): Promise<{ rows: DocumentRow[]; folders: boolean; uploaders: boolean }> {
  const run = (cols: string) =>
    scopeQuery(db.from("documents").select(cols), scope).order("created_at", { ascending: false });

  let last: unknown = null;
  for (const shape of DOCUMENT_SHAPES) {
    const res = await run(shape.cols);
    if (!res.error) {
      const rows = ((res.data ?? []) as unknown as DocumentRow[]).map((r) => ({
        ...r,
        folder_id: shape.folders ? r.folder_id : null,
        created_by: shape.uploaders ? (r.created_by ?? null) : null,
      }));
      return { rows, folders: shape.folders, uploaders: shape.uploaders };
    }
    if (!isMissingSchema(res.error) && !foldersNotMigrated(res.error)) throw res.error;
    last = res.error;
  }
  throw last;
}

/**
 * Resolves a batch of author ids to names in a single read — never one query
 * per row, which on a job with forty documents would be forty round trips for
 * decoration.
 *
 * Failure is not fatal. A name is a courtesy on top of the document, so a
 * missing column, a revoked grant or an RLS-narrowed answer yields an empty
 * map and the rows render "Unknown" rather than the Documents tab erroring.
 */
export async function listDocumentPeople(
  userIds: readonly (string | null | undefined)[],
): Promise<PersonNames> {
  const ids = Array.from(new Set(userIds.filter((v): v is string => !!v)));
  if (!ids.length) return new Map();
  const { data, error } = await db.from("profiles").select("user_id, full_name").in("user_id", ids);
  if (error) return new Map();
  return buildPersonNames(data as unknown as { user_id: string; full_name: string | null }[]);
}

/**
 * The one container a new folder is filed against, narrowest first — the same
 * order `scopeQuery` reads in. A job's scope also carries the job's account,
 * and `document_folders_one_scope` allows only one of job/account/project, so
 * passing the whole scope through made every folder on a job fail to save.
 */
export function folderContainer(scope: DocumentScope): {
  job_id: string | null;
  account_id: string | null;
  project_id: string | null;
} {
  if (scope.jobId) return { job_id: scope.jobId, account_id: null, project_id: null };
  if (scope.projectId) return { job_id: null, account_id: null, project_id: scope.projectId };
  return { job_id: null, account_id: scope.accountId ?? null, project_id: null };
}

export async function createDocumentFolder(input: {
  scope: DocumentScope;
  name: string;
  parentFolderId: string | null;
  userId: string | null;
  sortOrder?: number;
}): Promise<DocumentFolder> {
  const { data, error } = await db
    .from("document_folders")
    .insert({
      location_id: input.scope.locationId,
      ...folderContainer(input.scope),
      name: input.name.trim(),
      parent_folder_id: input.parentFolderId,
      created_by: input.userId,
      sort_order: input.sortOrder ?? 0,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as DocumentFolder;
}

export async function renameDocumentFolder(id: string, name: string): Promise<void> {
  const { error } = await db.from("document_folders").update({ name: name.trim() }).eq("id", id);
  if (error) throw error;
}

/**
 * Deleting a folder never deletes documents — they fall back to the top level.
 * A document is claim evidence; a folder is filing.
 */
export async function deleteDocumentFolder(id: string): Promise<void> {
  const unfiled = await db.from("documents").update({ folder_id: null }).eq("folder_id", id);
  if (unfiled.error) throw unfiled.error;
  const orphans = await db
    .from("document_folders")
    .update({ parent_folder_id: null })
    .eq("parent_folder_id", id);
  if (orphans.error) throw orphans.error;
  const { error } = await db.from("document_folders").delete().eq("id", id);
  if (error) throw error;
}

export async function moveDocumentToFolder(
  documentId: string,
  folderId: string | null,
): Promise<void> {
  const { data, error } = await db
    .from("documents")
    .update({ folder_id: folderId })
    .eq("id", documentId)
    .select("id");
  if (error) throw error;
  if ((data ?? []).length > 0) return;
  /* No row changed and no error: a SIGNED document, which documents_update
     refuses silently. Filing is not editing — move_document_to_folder
     (20261027170000) changes folder_id alone. */
  const { error: rpcError } = await db.rpc("move_document_to_folder", {
    _document_id: documentId,
    _folder_id: folderId,
  });
  if (rpcError) {
    if (foldersNotMigrated(rpcError) || rpcError.code === "PGRST202") {
      throw new Error(
        "Signed documents cannot be moved into folders yet — database update 20261027170000 has not been applied.",
      );
    }
    throw rpcError;
  }
}

/**
 * The folder a job's recurring paperwork files into, made the first time it is
 * needed.
 *
 * David, 12 Oct: sign-in sheets, supply lists and field forms arrive every day
 * of a job, so each kind gets its own folder on the job — created by the first
 * one saved, never by hand — and each day's PDF goes into it (its name carries
 * the date). An existing top-level folder of the same name, in any case, is
 * reused rather than duplicated, so a folder somebody already made by hand is
 * adopted.
 *
 * `aliases` are the folder's former names (David, 20 Oct renamed the T&M
 * folders). When no folder has the name but one has a former name, that
 * folder is renamed and used — the PDFs already in it stay where they are and
 * no second folder appears. If the rename is refused, the old-named folder is
 * still used.
 *
 * The reads and writes are passed in so the rule is testable without a
 * database; the defaults are this module's own.
 */
export async function ensureJobFolder(
  input: {
    scope: DocumentScope;
    name: string;
    userId: string | null;
    aliases?: readonly string[];
  },
  deps: {
    list: (scope: DocumentScope) => Promise<DocumentFolder[] | null>;
    create: typeof createDocumentFolder;
    rename?: typeof renameDocumentFolder;
  } = { list: listDocumentFolders, create: createDocumentFolder, rename: renameDocumentFolder },
): Promise<DocumentFolder | null> {
  const folders = await deps.list(input.scope);
  // Folders not migrated here: the document stays at the top level, as before.
  if (folders === null) return null;
  const norm = (n: string) => n.trim().toLowerCase();
  const topLevel = folders.filter((f) => !f.parent_folder_id);
  const wanted = norm(input.name);
  const found = topLevel.find((f) => norm(f.name) === wanted);
  if (found) return found;
  const former = new Set((input.aliases ?? []).map(norm));
  const legacy = topLevel.find((f) => former.has(norm(f.name)));
  if (legacy) {
    try {
      await (deps.rename ?? renameDocumentFolder)(legacy.id, input.name);
      return { ...legacy, name: input.name.trim() };
    } catch {
      return legacy;
    }
  }
  return deps.create({
    scope: input.scope,
    name: input.name,
    parentFolderId: null,
    userId: input.userId,
  });
}

/**
 * File one document into its job folder. Never throws: filing is tidiness on
 * top of a document that is already saved, and a failure here must not read
 * as the document being lost. Returns the folder it landed in, or null.
 */
export async function fileIntoJobFolder(
  input: {
    documentId: string;
    scope: DocumentScope;
    folderName: string;
    userId: string | null;
    /** The folder's former names; see ensureJobFolder. */
    folderAliases?: readonly string[];
  },
  deps: {
    list: (scope: DocumentScope) => Promise<DocumentFolder[] | null>;
    create: typeof createDocumentFolder;
    move: typeof moveDocumentToFolder;
    rename?: typeof renameDocumentFolder;
  } = {
    list: listDocumentFolders,
    create: createDocumentFolder,
    move: moveDocumentToFolder,
    rename: renameDocumentFolder,
  },
): Promise<DocumentFolder | null> {
  try {
    const folder = await ensureJobFolder(
      {
        scope: input.scope,
        name: input.folderName,
        userId: input.userId,
        aliases: input.folderAliases,
      },
      deps,
    );
    if (!folder) return null;
    await deps.move(input.documentId, folder.id);
    return folder;
  } catch {
    return null;
  }
}

/** A company document as the job's picker lists it. */
export type CompanyDocument = {
  id: string;
  name: string;
  doc_type: DocumentType;
  storage_bucket: string | null;
  storage_path: string | null;
  mime: string | null;
  size_bytes: number | null;
  content_hash: string | null;
  expiry_date: string | null;
  job_id: string | null;
  project_id: string | null;
  created_at: string;
};

/** The location's company-wide documents, newest first, for a job to pull in. */
export async function listCompanyDocuments(locationId: string): Promise<CompanyDocument[]> {
  const { data, error } = await db
    .from("documents")
    .select(
      "id, name, doc_type, storage_bucket, storage_path, mime, size_bytes, content_hash, expiry_date, job_id, project_id, created_at",
    )
    .eq("location_id", locationId)
    .is("job_id", null)
    .is("project_id", null)
    .not("storage_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) throw error;
  return ((data ?? []) as CompanyDocument[]).filter(isCompanyDocument);
}

/**
 * Pull a company document onto a job: a copy of the file, filed on the job.
 *
 * A copy, not a link, on purpose. There is no link table, and a second row on
 * the same storage object would let deleting the job's copy delete the
 * company's original. The job's copy keeps the original's name, type, expiry
 * and content hash, so it is recognisably the same paper.
 */
export async function copyCompanyDocumentToJob(input: {
  source: CompanyDocument;
  scope: DocumentScope;
  userId: string | null;
}): Promise<{ id: string }> {
  const { source, scope } = input;
  if (!source.storage_path) throw new Error("That document has no file to copy.");
  const bucket = source.storage_bucket ?? DOCUMENT_BUCKET;
  const ext = source.storage_path.split(".").pop() ?? "bin";
  const container = scope.jobId ?? scope.accountId ?? scope.projectId ?? "misc";
  const path = `${scope.locationId}/${container}/${crypto.randomUUID()}.${ext}`;
  const { error: copyErr } = await supabase.storage.from(bucket).copy(source.storage_path, path);
  if (copyErr) throw copyErr;

  const { data, error } = await supabase
    .from("documents")
    .insert({
      location_id: scope.locationId,
      job_id: scope.jobId ?? null,
      account_id: scope.accountId ?? null,
      project_id: scope.projectId ?? null,
      doc_type: source.doc_type,
      name: source.name,
      status: "active",
      storage_bucket: bucket,
      storage_path: path,
      mime: source.mime,
      size_bytes: source.size_bytes,
      expiry_date: source.expiry_date,
      content_hash: source.content_hash,
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (error) throw error;

  await logDocumentEvent(data.id, "generated", {
    source: "company_document",
    from_document_id: source.id,
  });
  return { id: data.id };
}

export function buildDocumentFolderTree(folders: DocumentFolder[]): DocumentFolderNode[] {
  const byId = new Map<string, DocumentFolderNode>();
  for (const f of folders) byId.set(f.id, { ...f, children: [], depth: 0 });
  const roots: DocumentFolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_folder_id ? byId.get(node.parent_folder_id) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const stamp = (nodes: DocumentFolderNode[], depth: number) => {
    for (const n of nodes) {
      n.depth = depth;
      stamp(n.children, depth + 1);
    }
  };
  stamp(roots, 0);
  return roots;
}

/** Depth-first flatten, for the rail and the move-to picker. */
export function flattenDocumentFolderTree(nodes: DocumentFolderNode[]): DocumentFolderNode[] {
  const out: DocumentFolderNode[] = [];
  const walk = (list: DocumentFolderNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Ids of a folder and everything under it — a folder view is inclusive. */
export function documentFolderDescendants(folders: DocumentFolder[], folderId: string): string[] {
  const kids = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parent_folder_id) continue;
    kids.set(f.parent_folder_id, [...(kids.get(f.parent_folder_id) ?? []), f.id]);
  }
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const c of kids.get(id) ?? []) walk(c);
  };
  walk(folderId);
  return out;
}

/**
 * The rows a folder selection should show. Selecting nothing — or having no
 * folders at all — shows everything, which is what keeps a record that has
 * never been filed looking exactly as it did before folders existed.
 *
 * Shared by the record panel and the Documents page so the two cannot disagree
 * about what "in this folder" means; a subfolder's documents are in its parent.
 */
export function documentsInFolder<T extends { folder_id: string | null }>(
  rows: readonly T[],
  folders: DocumentFolder[] | null,
  activeFolder: string | null,
): T[] {
  if (!folders || !activeFolder) return [...rows];
  const ids = new Set(documentFolderDescendants(folders, activeFolder));
  return rows.filter((r) => !!r.folder_id && ids.has(r.folder_id));
}

/** How many documents sit directly in each folder, for the rail's counts. */
export function documentFolderCounts(rows: readonly { folder_id: string | null }[]) {
  const out: Record<string, number> = {};
  for (const r of rows) if (r.folder_id) out[r.folder_id] = (out[r.folder_id] ?? 0) + 1;
  return out;
}

/* ------------------------------------------------------------------ */
/* Upload                                                              */
/* ------------------------------------------------------------------ */

/**
 * Put a file in the bucket and file it as a document. One implementation, so a
 * second surface that needs to attach a file — a photographed field work
 * ticket, say — cannot end up with its own storage path convention, its own
 * missing content hash, or its own missing audit event.
 *
 * Throws on failure; callers decide how to say so.
 */
export async function uploadDocumentFile(input: {
  file: File;
  scope: DocumentScope;
  docType: DocumentType;
  userId: string | null;
  name?: string;
  expiryDate?: string | null;
}): Promise<{ id: string; mime: string; hash: string; path: string }> {
  const { file, scope } = input;
  const ext = file.name.split(".").pop() ?? "bin";
  const container = scope.jobId ?? scope.accountId ?? scope.projectId ?? "misc";
  const path = `${scope.locationId}/${container}/${crypto.randomUUID()}.${ext}`;
  // The browser leaves File.type empty for anything the OS has no mapping
  // for — .esx always, .heic often. Storing that as octet-stream is what
  // makes a tab download the file instead of showing it, so name the type
  // from the extension while we still have the filename.
  const mime = documentMime(file.name, file.type);
  const { error: upErr } = await supabase.storage
    .from(DOCUMENT_BUCKET)
    .upload(path, file, { contentType: mime });
  if (upErr) throw upErr;

  const hash = await sha256Hex(await file.arrayBuffer());
  const { data, error } = await supabase
    .from("documents")
    .insert({
      location_id: scope.locationId,
      job_id: scope.jobId ?? null,
      account_id: scope.accountId ?? null,
      project_id: scope.projectId ?? null,
      doc_type: input.docType,
      name: input.name ?? file.name,
      status: "active",
      storage_bucket: DOCUMENT_BUCKET,
      storage_path: path,
      mime,
      size_bytes: file.size,
      expiry_date: input.expiryDate || null,
      content_hash: hash,
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (error) throw error;

  await logDocumentEvent(data.id, "generated", { source: "upload", hash });
  return { id: data.id, mime, hash, path };
}
