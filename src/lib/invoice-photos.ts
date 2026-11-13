/**
 * Photographs on an invoice.
 *
 * Asked for in these words: "to be able to attach images to an invoice ... the
 * option to add physical images to an invoice AND the option to add a link of
 * the selected images to the invoice." Two places feed the same list — the
 * invoice's own "Add images" button and the Pictures tab's selection bar — and
 * both come through here, so neither can drift from the other.
 *
 * `invoices.photo_ids` holds the job grid's own ids (a ULID for an album
 * photograph, `doc:<uuid>` for an image filed as a document) in the order the
 * office arranged them. `invoices.photo_share_link_id` names the `share_links`
 * row minted for exactly that list when the invoice carries a link; the link is
 * kept in step with the list here, on every write, so a customer opening the
 * link sees the same pictures the paper shows.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  INVOICE_PHOTOS_PER_PAGE_LIMIT,
  photoGridSheets,
  photosPerSheet,
} from "@/lib/invoice-photo-grid";
import { loadJobPhotosByIds, type JobPhoto } from "@/lib/job-photos";
import { PHOTO_SHARE_DEFAULTS } from "@/lib/photo-share";
import {
  createJobPhotoShareLink,
  readJobPhotoShareLink,
  revokeJobPhotoShareLink,
  updateJobPhotoShareLink,
  type JobPhotoShareLink,
} from "@/lib/photo-share-links";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * Past this the editor warns, and still lets it happen: a large loss is a
 * large loss, and the link exists for that case. Nothing here blocks a
 * thirteenth photograph — PR #42 put the twelve in the paginator, not in the
 * picker, and that is deliberately left alone.
 *
 * It is `photosPerSheet()`, which is the tighter of David's house limit and
 * what the page can physically hold. Today the house limit binds, so this is
 * twelve; the geometry would allow sixteen. `INVOICE_PHOTOS_PER_PAGE_LIMIT`
 * and `photosPerSheetByGeometry()` keep those two apart, because the last time
 * they were run together the office was warned at fifteen that its invoice
 * would run long and then found all fifteen on one sheet.
 */
export const INVOICE_PHOTO_SOFT_CAP = photosPerSheet();

/**
 * What this many photographs actually do to the paper, or null when they do
 * nothing worth saying.
 *
 * Two facts, and they do not contradict each other: the page count is measured
 * off `layoutPhotoGrid`, so it is whatever the paginator will really produce,
 * and the reason is named as what it is — a Gold Star rule about how many
 * pictures belong on a page, not a claim about how much paper they need.
 *
 * One sentence, shared by every place that asks, so the picker and the invoice
 * card cannot end up telling the office two different stories.
 */
export function invoicePhotoLengthNote(count: number): string | null {
  const sheets = photoGridSheets(count);
  if (sheets <= 1) return null;
  return (
    `${count} photos print as ${sheets} pages of pictures: Gold Star's limit is ` +
    `${INVOICE_PHOTOS_PER_PAGE_LIMIT} photos to a page. The photo link carries any number of ` +
    `them without lengthening the invoice.`
  );
}

/**
 * An invoice link lives a year. A homeowner opens the invoice email when the
 * carrier finally pays, which can be months after it was sent; a link that has
 * quietly expired by then is a phone call and a resend.
 */
export const INVOICE_PHOTO_LINK_DAYS = 365;

export type InvoiceForPhotos = {
  id: string;
  invoiceNumber: string;
  status: string;
  issueDate: string;
  photoIds: string[];
  photoShareLinkId: string | null;
};

export type InvoicePhotoListResult =
  { migrated: true; invoices: InvoiceForPhotos[] } | { migrated: false; invoices: [] };

const INVOICE_COLS =
  "id, invoice_number, status, issue_date, created_at, photo_ids, photo_share_link_id";

function toInvoice(r: {
  id: string;
  invoice_number: string;
  status: string;
  issue_date: string;
  photo_ids: string[] | null;
  photo_share_link_id: string | null;
}): InvoiceForPhotos {
  return {
    id: r.id,
    invoiceNumber: r.invoice_number,
    status: r.status,
    issueDate: r.issue_date,
    photoIds: r.photo_ids ?? [],
    photoShareLinkId: r.photo_share_link_id,
  };
}

/**
 * The job's invoices, newest first, with what is already on each.
 *
 * `photo_ids` is selected by name rather than through `select("*")` on
 * purpose: before the migration lands this read fails with 42703 and the
 * caller turns the control off and says so, rather than silently reporting
 * every invoice as having no photos.
 */
export async function listInvoicesForPhotos(jobId: string): Promise<InvoicePhotoListResult> {
  const { data, error } = await supabase
    .from("invoices")
    .select(INVOICE_COLS)
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingSchema(error)) return { migrated: false, invoices: [] };
    throw error;
  }
  return { migrated: true, invoices: (data ?? []).map(toInvoice) };
}

/**
 * Write the list, and keep the link — when there is one — showing exactly the
 * same pictures.
 *
 * An emptied list takes the link with it: a link to no photographs is not a
 * thing an invoice should print. Everything else updates the existing row in
 * place, because the invoice may already be in someone's inbox with that URL
 * on it.
 */
export async function setInvoicePhotos(
  invoice: { id: string; photoShareLinkId: string | null },
  ids: string[],
  userId: string | null,
): Promise<{ linkRemoved: boolean }> {
  const unique = Array.from(new Set(ids));
  let linkRemoved = false;
  const patch: { photo_ids: string[] | null; photo_share_link_id?: null } = {
    photo_ids: unique.length ? unique : null,
  };
  if (invoice.photoShareLinkId && unique.length === 0) {
    patch.photo_share_link_id = null;
    linkRemoved = true;
  }

  const { data, error } = await supabase
    .from("invoices")
    .update(patch)
    .eq("id", invoice.id)
    .select("id");
  if (error) throw error;
  /* RLS refuses by returning no rows rather than by erroring, and a silent
     no-op here would read as "the photos were added". */
  if (!data?.length) throw new Error("This invoice could not be changed.");

  if (invoice.photoShareLinkId) {
    if (linkRemoved) await revokeJobPhotoShareLink(invoice.photoShareLinkId, userId);
    else await updateJobPhotoShareLink(invoice.photoShareLinkId, { ids: unique });
  }
  return { linkRemoved };
}

/**
 * Add photographs without disturbing what is already on the invoice.
 *
 * Appended, de-duplicated, order preserved: attaching the same six twice is
 * the ordinary way this gets used, and it must not produce twelve.
 */
export async function attachPhotosToInvoice(
  invoice: InvoiceForPhotos,
  ids: string[],
  userId: string | null,
): Promise<number> {
  const added = ids.filter((id) => !invoice.photoIds.includes(id));
  if (added.length === 0) return 0;
  await setInvoicePhotos(invoice, [...invoice.photoIds, ...added], userId);
  return added.length;
}

/* ── the link ───────────────────────────────────────────────────────────── */

export type InvoicePhotoLink = JobPhotoShareLink & {
  /** Neither revoked nor expired: the URL on the paper still opens. */
  live: boolean;
};

function withLiveness(link: JobPhotoShareLink): InvoicePhotoLink {
  return {
    ...link,
    live: !link.revokedAt && new Date(link.expiresAt).getTime() > Date.now(),
  };
}

export async function readInvoicePhotoLink(linkId: string): Promise<InvoicePhotoLink | null> {
  const link = await readJobPhotoShareLink(linkId);
  return link ? withLiveness(link) : null;
}

/**
 * Mint the link for exactly this invoice's photographs and remember it.
 *
 * The display switches are the share defaults — bare pictures and a phone
 * number, nothing about when or who. The one choice the office makes here is
 * view-only versus full-resolution download, and it starts view-only: the
 * original is the file with the GPS coordinates still inside it.
 */
export async function enableInvoicePhotoLink(input: {
  invoiceId: string;
  invoiceNumber: string;
  jobId: string;
  userId: string | null;
  ids: string[];
  allowDownloadOriginal: boolean;
}): Promise<InvoicePhotoLink> {
  if (input.ids.length === 0) throw new Error("Add at least one photo before creating a link.");
  const created = await createJobPhotoShareLink({
    jobId: input.jobId,
    userId: input.userId,
    ids: input.ids,
    options: PHOTO_SHARE_DEFAULTS,
    expiresInDays: INVOICE_PHOTO_LINK_DAYS,
    note: `Invoice ${input.invoiceNumber}`,
    allowDownloadOriginal: input.allowDownloadOriginal,
  });

  const { data, error } = await supabase
    .from("invoices")
    .update({ photo_share_link_id: created.id })
    .eq("id", input.invoiceId)
    .select("id");
  if (error) throw error;
  if (!data?.length) {
    // Never leave a live link that nothing points at.
    await revokeJobPhotoShareLink(created.id, input.userId).catch(() => null);
    throw new Error("This invoice could not be changed.");
  }

  const link = await readInvoicePhotoLink(created.id);
  if (!link) throw new Error("The link was created but could not be read back.");
  return link;
}

/** Turn the link off. Revoked, not deleted, so the audit trail keeps it. */
export async function disableInvoicePhotoLink(
  invoiceId: string,
  linkId: string,
  userId: string | null,
): Promise<void> {
  const { data, error } = await supabase
    .from("invoices")
    .update({ photo_share_link_id: null })
    .eq("id", invoiceId)
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("This invoice could not be changed.");
  await revokeJobPhotoShareLink(linkId, userId);
}

export async function setInvoicePhotoLinkDownload(
  linkId: string,
  allowDownloadOriginal: boolean,
): Promise<void> {
  await updateJobPhotoShareLink(linkId, { allowDownloadOriginal });
}

/* ── the pictures themselves ────────────────────────────────────────────── */

export type InvoicePhotoSet = {
  /** In the invoice's order. */
  photos: JobPhoto[];
  /** Ids on the invoice that the job no longer has — removed since, or hidden by RLS. */
  missing: number;
};

/**
 * The job's photographs that the invoice names, in the invoice's order.
 *
 * Goes through the same rules as the Pictures tab so an invoice can only ever
 * show what that tab shows: soft-deleted photos drop out here exactly as they
 * drop out there.
 *
 * It reads the ids it names, not the album. It used to look them up in the
 * album read, which stopped at the newest 600 photos — so on a large job an
 * attached photo from the first week printed as "missing" on the invoice, and
 * on every report, which borrows this function.
 */
export async function loadInvoicePhotos(jobId: string, ids: string[]): Promise<InvoicePhotoSet> {
  if (ids.length === 0) return { photos: [], missing: 0 };
  const all = await loadJobPhotosByIds(jobId, ids);
  const byId = new Map(all.map((p) => [p.id, p]));
  const photos: JobPhoto[] = [];
  let missing = 0;
  for (const id of ids) {
    const p = byId.get(id);
    if (p) photos.push(p);
    else missing += 1;
  }
  return { photos, missing };
}
