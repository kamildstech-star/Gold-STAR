/**
 * Creating, listing, updating and revoking a job's photo share links.
 *
 * These run in the browser against RLS, not the service role: `share_links`
 * carries job-scoped policies, so a user who cannot manage the job cannot mint
 * a link for it and no bespoke permission check here can drift away from the
 * one the database applies.
 *
 * Reading a link's contents is the opposite problem and lives in
 * `photo-share.server.ts`, where the recipient has no session at all.
 *
 * The token helpers, the URL builder and the "not migrated yet" test are shared
 * with the schedule links rather than copied — two share features that disagree
 * about what a live link looks like is exactly the failure this replaces.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

import { jobShareUrl, newShareToken, shareLinksNotMigrated } from "./job-share-links";
import {
  PHOTO_SHARE_DEFAULTS,
  normalizePhotoShareOptions,
  type PhotoShareOptions,
} from "./photo-share";

export const DOC_ID_PREFIX = "doc:";

export type JobPhotoShareLink = {
  id: string;
  token: string;
  url: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  note: string | null;
  options: PhotoShareOptions;
  /**
   * Whether the recipient may pull the camera original. Off is view-only: the
   * re-encoded display copy and nothing that carries EXIF.
   */
  allowDownloadOriginal: boolean;
  /** Grid ids, so a link's contents can go straight back into a selection. */
  photoIds: string[];
  count: number;
};

/**
 * The grid mixes album photographs (ULID ids) with image documents (`doc:` and
 * a uuid) and the two live in different columns, because they live in different
 * tables. Splitting here keeps that knowledge in one function.
 */
export function splitSelection(ids: string[]): { photoIds: string[]; documentIds: string[] } {
  const photoIds: string[] = [];
  const documentIds: string[] = [];
  for (const id of ids) {
    if (id.startsWith(DOC_ID_PREFIX)) documentIds.push(id.slice(DOC_ID_PREFIX.length));
    else photoIds.push(id);
  }
  return { photoIds, documentIds };
}

export function joinSelection(photoIds: string[], documentIds: string[]): string[] {
  return [...photoIds, ...documentIds.map((d) => `${DOC_ID_PREFIX}${d}`)];
}

const LINK_COLS =
  "id, token, created_at, expires_at, revoked_at, note, display_options, allow_download_original, photo_ids, document_ids";

type LinkRow = {
  id: string;
  token: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  note: string | null;
  display_options: unknown;
  allow_download_original: boolean;
  photo_ids: string[] | null;
  document_ids: string[] | null;
};

function toLink(r: LinkRow): JobPhotoShareLink {
  const ids = joinSelection(r.photo_ids ?? [], r.document_ids ?? []);
  return {
    id: r.id,
    token: r.token,
    url: jobShareUrl(r.token),
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    note: r.note,
    options: normalizePhotoShareOptions(r.display_options),
    allowDownloadOriginal: r.allow_download_original,
    photoIds: ids,
    count: ids.length,
  };
}

export type JobPhotoShareListResult =
  { migrated: true; links: JobPhotoShareLink[] } | { migrated: false; links: [] };

export async function listJobPhotoShareLinks(jobId: string): Promise<JobPhotoShareListResult> {
  const { data, error } = await supabase
    .from("share_links")
    .select(LINK_COLS)
    .eq("job_id", jobId)
    .eq("kind", "job_photos")
    .order("created_at", { ascending: false });

  if (error) {
    if (shareLinksNotMigrated(error)) return { migrated: false, links: [] };
    throw error;
  }

  return { migrated: true, links: (data ?? []).map(toLink) };
}

/**
 * One link by id, for a record that remembers which link it minted — an
 * invoice, say. Null when it no longer exists or RLS hides it; the caller
 * decides whether that means "make a new one".
 */
export async function readJobPhotoShareLink(linkId: string): Promise<JobPhotoShareLink | null> {
  const { data, error } = await supabase
    .from("share_links")
    .select(LINK_COLS)
    .eq("id", linkId)
    .maybeSingle();
  if (error) {
    if (shareLinksNotMigrated(error)) return null;
    throw error;
  }
  return data ? toLink(data) : null;
}

export type CreateJobPhotoShareInput = {
  jobId: string;
  userId: string | null;
  /** Grid ids, exactly as selected, in the order they were shown. */
  ids: string[];
  options: PhotoShareOptions;
  expiresInDays: number;
  note: string | null;
  /** View-only unless said otherwise — the original is the file with the GPS in it. */
  allowDownloadOriginal?: boolean;
};

export async function createJobPhotoShareLink(
  input: CreateJobPhotoShareInput,
): Promise<{ id: string; token: string; url: string }> {
  if (input.ids.length === 0) throw new Error("Pick at least one photo to share.");
  const token = newShareToken();
  const expiresAt = new Date(
    Date.now() + Math.max(1, input.expiresInDays) * 86_400_000,
  ).toISOString();
  const { photoIds, documentIds } = splitSelection(input.ids);

  const { data, error } = await supabase
    .from("share_links")
    .insert({
      job_id: input.jobId,
      kind: "job_photos",
      token,
      created_by: input.userId,
      expires_at: expiresAt,
      note: input.note,
      photo_ids: photoIds,
      document_ids: documentIds,
      allow_download_original: input.allowDownloadOriginal === true,
      /* Normalised on the way in as well as on the way out, so a link can
         never carry a permission the dialog could not have granted. */
      display_options: { ...PHOTO_SHARE_DEFAULTS, ...normalizePhotoShareOptions(input.options) },
    })
    .select("id, token")
    .single();
  if (error) throw error;

  return { id: data.id, token: data.token, url: jobShareUrl(data.token) };
}

/**
 * Change what a link already in someone's inbox shows.
 *
 * The URL is deliberately untouched. "A way to update the link with more
 * images" means the customer opens the message they already have and sees the
 * new photographs — minting a second link and asking them to throw the first
 * one away is the thing this exists instead of.
 *
 * The same call takes photographs away again, and rewrites the switches, for
 * the same reason: the sender's mistake should be fixable on the link that made
 * it, not by revoking and re-sending.
 */
export async function updateJobPhotoShareLink(
  linkId: string,
  patch: {
    ids?: string[];
    options?: PhotoShareOptions;
    note?: string | null;
    allowDownloadOriginal?: boolean;
  },
): Promise<void> {
  const row: Partial<Database["public"]["Tables"]["share_links"]["Update"]> = {};
  if (patch.ids) {
    if (patch.ids.length === 0) throw new Error("A link must show at least one photo.");
    const { photoIds, documentIds } = splitSelection(patch.ids);
    row.photo_ids = photoIds;
    row.document_ids = documentIds;
  }
  if (patch.options) {
    row.display_options = { ...PHOTO_SHARE_DEFAULTS, ...normalizePhotoShareOptions(patch.options) };
  }
  if (patch.note !== undefined) row.note = patch.note;
  if (patch.allowDownloadOriginal !== undefined)
    row.allow_download_original = patch.allowDownloadOriginal;
  if (Object.keys(row).length === 0) return;

  const { data, error } = await supabase
    .from("share_links")
    .update(row)
    .eq("id", linkId)
    .select("id");
  if (error) throw error;
  /* RLS refuses an update by returning no rows rather than by erroring, and a
     silent no-op here would read as "the extra photos were added". */
  if (!data?.length)
    throw new Error("This link could not be changed. You may not manage this job.");
}

export async function revokeJobPhotoShareLink(
  linkId: string,
  userId: string | null,
): Promise<void> {
  const { data, error } = await supabase
    .from("share_links")
    .update({ revoked_at: new Date().toISOString(), revoked_by: userId })
    .eq("id", linkId)
    .select("id");
  if (error) throw error;
  if (!data?.length)
    throw new Error("This link could not be revoked. You may not manage this job.");
}
